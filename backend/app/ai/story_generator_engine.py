"""Story Generator engine: the deterministic story skeleton (Layer 3).

Why: port of `frontend/src/lib/ai/story-generator-engine.ts`. The application, not the model, owns
the structure of a story: IDs, the scene chain, one learning scene, one puzzle and one result
scene per concept, the single ending and the knowledge mapping. Gemini only writes the text in
those slots (see `story_generator.merge_story_content`); anything it leaves out keeps the template
text built here, so a story is always complete and playable.

Guarantees (same as the TypeScript engine): pure and deterministic (no clock, no randomness, the
request is not mutated), a linear chain `intro -> (learning -> puzzle -> result)* -> ending`,
exactly one ending scene, and every concept both taught and tested, so every `required_knowledge`
reference of a later story can be demonstrated. Puzzle correctness is data only
(`correct_choice_id`); the game engine judges answers.

Expected failures come back as `StoryEngineError`; the engine never raises for bad input.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from app.ai.contracts.campaign import Character
from app.ai.contracts.material import Concept
from app.ai.contracts.requests import GenerateStoryRequest
from app.ai.validation import validation_error
from app.ai.zod_compat import js_trim

# Preferred expression keys, in priority order, when the character has them.
PREFERRED_EXPRESSIONS = (
    "neutral",
    "thinking",
    "worried",
    "approving",
    "surprised",
    "stern",
    "focused",
    "curious",
    "relieved",
    "happy",
    "sad",
    "serious",
)


@dataclass(frozen=True)
class StoryEngineSuccess:
    blueprint: dict[str, Any]
    warnings: list[dict[str, str]] = field(default_factory=list)
    ok: bool = True


@dataclass(frozen=True)
class StoryEngineError:
    code: str
    message: str
    detail: Any = None
    ok: bool = False


StoryEngineResult = StoryEngineSuccess | StoryEngineError

_ARRAY_INDEX = re.compile(r"(?:0|[1-9][0-9]*)")


def _js_keys(mapping: dict[str, str]) -> list[str]:
    """`Object.keys` order: integer-like keys ascending first, then the rest as inserted."""
    integer_keys = [k for k in mapping if _ARRAY_INDEX.fullmatch(k) and int(k) < 2**32 - 1]
    integer_keys.sort(key=int)
    others = [k for k in mapping if k not in set(integer_keys)]
    return integer_keys + others


def _pick_expression(character: Character | None, preference: str) -> str:
    """An expression key the character really owns; falls back to its first key, then neutral."""
    keys = _js_keys(character.expressions) if character is not None else []
    if not keys:
        return "neutral"
    if preference and preference in keys:
        return preference
    for key in PREFERRED_EXPRESSIONS:
        if key in keys:
            return key
    return keys[0]


def order_concepts(concepts: list[Concept]) -> list[Concept]:
    """Stable topological order of a material's concepts (prerequisites first).

    Prerequisites that live in another material are ignored (the campaign planner orders those).
    Ties keep the material's order. Concepts left in a cycle are appended in input order so the
    result is total; the generator validator reports the cycle.
    """
    by_id = {c.concept_id: c for c in concepts}
    input_order = {c.concept_id: i for i, c in enumerate(concepts)}
    deps: dict[str, dict[str, None]] = {}
    for c in concepts:
        local: dict[str, None] = {}
        for prerequisite in c.prerequisites:
            if prerequisite in by_id and prerequisite != c.concept_id:
                local[prerequisite] = None
        deps[c.concept_id] = local

    remaining: dict[str, int] = {}
    dependents: dict[str, list[str]] = {}
    for c in concepts:
        local = deps[c.concept_id]
        remaining[c.concept_id] = len(local)
        for dep in local:
            dependents.setdefault(dep, []).append(c.concept_id)

    def order_key(concept_id: str) -> int:
        return input_order.get(concept_id, 0)

    available = sorted(
        [c.concept_id for c in concepts if remaining.get(c.concept_id, 0) == 0], key=order_key
    )
    ordered: list[Concept] = []
    while available:
        concept_id = available.pop(0)
        concept = by_id.get(concept_id)
        if concept is not None:
            ordered.append(concept)
        for dependent_id in dependents.get(concept_id, []):
            count = remaining.get(dependent_id, 0) - 1
            remaining[dependent_id] = count
            if count == 0:
                available.append(dependent_id)
                available.sort(key=order_key)

    if len(ordered) != len(concepts):
        placed = {c.concept_id for c in ordered}
        ordered.extend(c for c in concepts if c.concept_id not in placed)
    return ordered


# --- text templates ---------------------------------------------------------------------------


def _intro_narration(campaign_title: str, setting: str, entry_title: str, conflict: str) -> str:
    return (
        f"In {setting}, the tale of {campaign_title} continues. "
        f'The struggle that defines "{entry_title}" begins now: {conflict}'
    )


def _learning_body(concept: Concept) -> str:
    parts = [js_trim(concept.definition)]
    if concept.principles:
        parts.append(" ".join(concept.principles))
    if concept.source_evidence:
        parts.append(f'As the records put it: "{concept.source_evidence[0]}"')
    return " ".join(parts)


def _distractor_texts(concept: Concept) -> list[str]:
    if concept.misconceptions:
        return list(concept.misconceptions)
    # Deterministic fallback: negate the first principle, then a generic trap.
    fallbacks: list[str] = []
    if concept.principles:
        fallbacks.append(f"The opposite of: {concept.principles[0]}")
    fallbacks.append(f"Any rule applies to {concept.name} as long as it sounds plausible.")
    return fallbacks


def _pad(n: int) -> str:
    return str(n).rjust(2, "0")


# --- main entry point -------------------------------------------------------------------------


def build_story_blueprint(request: GenerateStoryRequest) -> StoryEngineResult:
    """Build the StoryBlueprint (a plain dict) for one campaign story entry.

    Identical requests give identical output. The request is never mutated.
    """
    campaign = request.campaign
    entry = request.story
    material = request.material
    options = request.options
    previous = request.previous_summaries or []
    warnings: list[dict[str, str]] = []

    # 1. Semantic guards on the request.
    if not any(s.story_id == entry.story_id for s in campaign.story_sequence):
        return StoryEngineError(
            "STORY_NOT_IN_CAMPAIGN",
            f'Story "{entry.story_id}" is not part of campaign "{campaign.campaign_id}".',
        )
    if entry.material_id != material.material_id:
        return StoryEngineError(
            "MATERIAL_MISMATCH",
            f'Story "{entry.story_id}" references material "{entry.material_id}" '
            f'but material "{material.material_id}" was supplied.',
        )
    if not material.concepts:
        return StoryEngineError(
            "CONCEPT_COVERAGE",
            f'Material "{material.material_id}" defines no concepts, so no story can be generated.',
        )

    # 2. Concept order.
    ordered = order_concepts(list(material.concepts))

    # 3. Characters: the guide frames challenges, the companion learns along.
    guide = campaign.characters[0] if len(campaign.characters) > 0 else None
    companion = campaign.characters[1] if len(campaign.characters) > 1 else None
    cast = [c for c in (guide, companion) if c is not None]
    character_ids = [c.character_id for c in cast]
    present = list(character_ids)

    # 4. Scene IDs.
    tag = entry.story_id
    intro_scene_id = f"scene_{tag}_intro"
    ending_scene_id = f"scene_{tag}_ending"

    # 5. Intro scene, then puzzles and per-concept scenes.
    puzzles: list[dict[str, Any]] = []
    knowledge_mapping: list[dict[str, str]] = []
    scenes: list[dict[str, Any]] = []

    intro_content: list[dict[str, Any]] = [
        {
            "type": "narration",
            "text": _intro_narration(
                campaign.title, campaign.setting, entry.title, entry.main_conflict
            ),
        }
    ]
    if guide is not None:
        purpose = re.sub(r"^Introduce and apply: ", "", entry.purpose, count=1)
        intro_content.append(
            {
                "type": "dialogue",
                "character_id": guide.character_id,
                "expression": _pick_expression(guide, "worried"),
                "text": f"We are here because of {purpose}. Nothing about that is optional.",
            }
        )
    if previous:
        last = previous[-1]
        intro_content.append(
            {
                "type": "narration",
                "text": "What came before still shapes this moment: "
                f"{last.outcome_description or last.title}.",
            }
        )
    scenes.append(
        {
            "scene_id": intro_scene_id,
            "type": "narrative",
            "location": campaign.setting,
            "characters_present": list(present),
            "content": intro_content,
            "next_scene_id": None,  # wired below
        }
    )

    for raw_index, concept in enumerate(ordered):
        index = raw_index + 1
        learning_id = f"scene_{tag}_c{_pad(index)}_learning"
        puzzle_scene_id = f"scene_{tag}_c{_pad(index)}_puzzle"
        result_id = f"scene_{tag}_c{_pad(index)}_result"
        puzzle_id = f"puzzle_{tag}_c{_pad(index)}"

        # Learning scene.
        learning_content: list[dict[str, Any]] = [
            {
                "type": "learning_info",
                "title": concept.name,
                "body": _learning_body(concept),
                "concept_ids": [concept.concept_id],
            }
        ]
        if companion is not None:
            learning_content.insert(
                0,
                {
                    "type": "dialogue",
                    "character_id": companion.character_id,
                    "expression": _pick_expression(companion, "curious"),
                    "text": f"Before we go further, we need to be precise about {concept.name}.",
                },
            )
        scenes.append(
            {
                "scene_id": learning_id,
                "type": "learning",
                "location": campaign.setting,
                "characters_present": list(present),
                "content": learning_content,
                "next_scene_id": puzzle_scene_id,
            }
        )

        # Puzzle.
        distractors = _distractor_texts(concept)
        if not concept.misconceptions:
            warnings.append(
                validation_error(
                    "PUZZLE_DISTRACTOR_SUBSTITUTED",
                    f'Concept "{concept.concept_id}" has no recorded misconceptions; '
                    "deterministic fallback distractors were used.",
                    f"puzzles[{puzzle_id}].choices",
                )
            )
        correct_choice_id = f"choice_{tag}_c{_pad(index)}_a"
        choices = [{"choice_id": correct_choice_id, "text": concept.definition}]
        for i, text in enumerate(distractors[:2]):
            choices.append(
                {"choice_id": f"choice_{tag}_c{_pad(index)}_{chr(98 + i)}", "text": text}
            )
        puzzles.append(
            {
                "puzzle_id": puzzle_id,
                "concept_ids": [concept.concept_id],
                "narrative_context": f"{entry.main_conflict} To move forward, "
                f"{concept.name} must be applied correctly.",
                "question": f"Which statement correctly describes {concept.name}?",
                "choices": choices,
                "correct_choice_id": correct_choice_id,
                "explanation": (
                    f"{concept.definition} This follows from: {' '.join(concept.principles)}"
                    if concept.principles
                    else concept.definition
                ),
                "incorrect_feedback": "That is a common misunderstanding. "
                f"Re-read the material on {concept.name} and try again.",
                "correct_feedback": f"Correct. {concept.name} is exactly as stated, "
                "and the story can continue.",
                "retry_allowed": True,
            }
        )
        scenes.append(
            {
                "scene_id": puzzle_scene_id,
                "type": "puzzle",
                "location": campaign.setting,
                "characters_present": list(present),
                "puzzle_id": puzzle_id,
                "next_scene_id": result_id,
            }
        )

        # Result (consequence) scene.
        result_content: list[dict[str, Any]] = [
            {
                "type": "narration",
                "text": f"With {concept.name} understood, the obstacle before you gives way. "
                f'The path through "{entry.title}" opens a little further.',
            }
        ]
        if guide is not None:
            result_content.append(
                {
                    "type": "dialogue",
                    "character_id": guide.character_id,
                    "expression": _pick_expression(guide, "approving"),
                    "text": f"Good. {concept.name} is secure. We continue.",
                }
            )
        scenes.append(
            {
                "scene_id": result_id,
                "type": "consequence",
                "location": campaign.setting,
                "characters_present": list(present),
                "content": result_content,
                "next_scene_id": None,  # wired below
            }
        )

        knowledge_mapping.append(
            {
                "concept_id": concept.concept_id,
                "introduced_in_scene_id": learning_id,
                "tested_in_puzzle_id": puzzle_id,
            }
        )

    # 6. Ending.
    ending_id = f"ending_{tag}_success"
    outcome = entry.outcomes[0] if entry.outcomes else None
    resolution = (
        outcome.description if outcome is not None else "the central problem is fully resolved."
    )
    ending = {
        "ending_id": ending_id,
        "type": "success",
        "title": f"{entry.title} \u2014 Resolved",
        "narration": f'The conflict of "{entry.title}" is settled: {resolution} '
        "The knowledge gained here will matter in what comes next.",
        "world_state_changes": dict(outcome.world_state_changes) if outcome is not None else {},
        "relationship_changes": {cid: 10 for cid in character_ids},
    }
    scenes.append(
        {
            "scene_id": ending_scene_id,
            "type": "ending",
            "location": campaign.setting,
            "characters_present": list(present),
            "ending_id": ending_id,
        }
    )

    # 7. Wire the linear chain.
    content_scenes = [s for s in scenes if s["type"] != "ending"]
    for i, scene in enumerate(content_scenes):
        scene["next_scene_id"] = (
            content_scenes[i + 1]["scene_id"] if i + 1 < len(content_scenes) else ending_scene_id
        )

    # 8. Chapters.
    n = len(ordered)
    wanted = options.concepts_per_chapter if options and options.concepts_per_chapter else n
    per_chapter = max(1, min(wanted, n))
    scenes_per_concept = 3  # learning + puzzle + result
    head, middle, tail = scenes[:1], scenes[1:-1], scenes[-1:]
    group_count = math.ceil(len(middle) / (per_chapter * scenes_per_concept))
    chapters: list[dict[str, Any]] = []
    for g in range(group_count):
        part = middle[
            g * per_chapter * scenes_per_concept : (g + 1) * per_chapter * scenes_per_concept
        ]
        chapters.append(
            {
                "chapter_id": f"chapter_{tag}_01"
                if group_count == 1
                else f"chapter_{tag}_{_pad(g + 1)}",
                "title": entry.title if group_count == 1 else f"{entry.title} \u2014 Part {g + 1}",
                "scenes": [
                    *(head if g == 0 else []),
                    *part,
                    *(tail if g == group_count - 1 else []),
                ],
            }
        )

    # 9. Blueprint with continuity summary.
    blueprint = {
        "story_id": entry.story_id,
        "material_id": material.material_id,
        "title": entry.title,
        "summary": f"{entry.purpose} The story covers {', '.join(c.name for c in ordered)}.",
        "character_ids": character_ids,
        "chapters": chapters,
        "puzzles": puzzles,
        "endings": [ending],
        "continuity_summary": {
            "story_id": entry.story_id,
            "outcome_description": outcome.description if outcome is not None else ending["title"],
            # The engine has no branching choice scenes, so no decisions are possible.
            "key_decisions": [],
            "world_state_snapshot": dict(ending["world_state_changes"]),
            "relationship_snapshot": dict(ending["relationship_changes"]),
        },
        "knowledge_mapping": knowledge_mapping,
    }

    # 10. Non-blocking context warning.
    if entry.required_knowledge and not previous:
        warnings.append(
            validation_error(
                "CONTINUITY_CONTEXT_MISSING",
                f'Story "{entry.story_id}" declares required_knowledge but no previous summaries '
                "were supplied; continuity framing is minimal.",
                "previousSummaries",
            )
        )

    return StoryEngineSuccess(blueprint, warnings)
