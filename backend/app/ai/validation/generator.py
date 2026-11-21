"""Semantic validator for a generated StoryBlueprint (Layer 3 rules).

Why: port of `frontend/src/lib/validation/generator-validator.ts`. These are the rules that make a
generated story playable and complete, kept apart from `validate_story` so older fixtures are
never held to stricter rules than they were written for. Rules: unique chapter, puzzle, choice
and ending IDs; exactly one ending scene; no scene without a next scene (the engine would treat
it as story completion); every scene and the ending reachable from the entry scene; every
material concept taught in exactly one scene and tested by exactly one puzzle, with a matching
knowledge_mapping; `required_knowledge` must not be a concept of this story's own material;
no prerequisite cycle inside the material; puzzle scenes point at existing puzzles.

Returns `{code, message, path}` dicts in the same order and with the same wording as the
TypeScript version, because they are sent as the `detail` of a VALIDATION_FAILED answer.
"""

from __future__ import annotations

from app.ai.contracts.campaign import StorySummaryEntry
from app.ai.contracts.material import MaterialBlueprint
from app.ai.contracts.story import EndingScene, PuzzleScene, Scene, StoryBlueprint
from app.ai.validation import validation_error
from app.ai.validation.story import collect_scenes


def _reachable_scene_ids(story: StoryBlueprint, scenes: list[Scene]) -> set[str]:
    """Breadth-first set of scenes reachable from the entry scene."""
    index = {s.scene_id: s for s in scenes}
    reachable: set[str] = set()
    if not story.chapters or not story.chapters[0].scenes:
        return reachable
    queue = [story.chapters[0].scenes[0].scene_id]
    while queue:
        scene_id = queue.pop(0)
        if scene_id in reachable:
            continue
        reachable.add(scene_id)
        scene = index.get(scene_id)
        if scene is None or isinstance(scene, EndingScene):
            continue
        if scene.next_scene_id:
            queue.append(scene.next_scene_id)
    return reachable


def _js_sort_key(text: str) -> bytes:
    """JavaScript's default sort compares UTF-16 code units."""
    return text.encode("utf-16-be", errors="surrogatepass")


def _intra_material_cycle_concepts(material: MaterialBlueprint) -> list[str]:
    """Concept IDs that take part in a prerequisite cycle inside the material, sorted."""
    by_id = {c.concept_id: c for c in material.concepts}
    state: dict[str, int] = {}  # 1 = visiting, 2 = done
    in_cycle: set[str] = set()

    def visit(concept_id: str, stack: list[str]) -> None:
        mark = state.get(concept_id, 0)
        if mark == 2:
            return
        if mark == 1:
            start = stack.index(concept_id) if concept_id in stack else 0
            in_cycle.update(stack[start:])
            return
        state[concept_id] = 1
        stack.append(concept_id)
        for prerequisite in by_id[concept_id].prerequisites:
            if prerequisite in by_id:
                visit(prerequisite, stack)
        stack.pop()
        state[concept_id] = 2

    for concept in material.concepts:
        visit(concept.concept_id, [])
    return sorted(in_cycle, key=_js_sort_key)


def validate_generated_story(
    story: StoryBlueprint,
    material: MaterialBlueprint,
    entry: StorySummaryEntry | None = None,
    previous_stories: list[StoryBlueprint] | None = None,
) -> list[dict[str, str]]:
    """Return the problems found in `story`; an empty list means valid."""
    errors: list[dict[str, str]] = []
    scenes = collect_scenes(story)
    story_id = story.story_id

    # 1. Chapter IDs are unique.
    seen_chapters: set[str] = set()
    for chapter in story.chapters:
        if chapter.chapter_id in seen_chapters:
            errors.append(
                validation_error(
                    "DUPLICATE_CHAPTER_ID",
                    f'Duplicate chapter_id "{chapter.chapter_id}" in story "{story_id}".',
                    f"chapters[{chapter.chapter_id}]",
                )
            )
        seen_chapters.add(chapter.chapter_id)

    # 2. Puzzle IDs are unique; choice IDs are unique within a puzzle.
    seen_puzzles: set[str] = set()
    for puzzle in story.puzzles:
        if puzzle.puzzle_id in seen_puzzles:
            errors.append(
                validation_error(
                    "DUPLICATE_PUZZLE_ID",
                    f'Duplicate puzzle_id "{puzzle.puzzle_id}" in story "{story_id}".',
                    f"puzzles[{puzzle.puzzle_id}]",
                )
            )
        seen_puzzles.add(puzzle.puzzle_id)
        seen_choices: set[str] = set()
        for choice in puzzle.choices:
            if choice.choice_id in seen_choices:
                errors.append(
                    validation_error(
                        "DUPLICATE_CHOICE_ID",
                        f'Duplicate choice_id "{choice.choice_id}" in puzzle "{puzzle.puzzle_id}".',
                        f"puzzles[{puzzle.puzzle_id}].choices[{choice.choice_id}]",
                    )
                )
            seen_choices.add(choice.choice_id)

    # 3. Ending IDs are unique; exactly one ending scene.
    seen_endings: set[str] = set()
    for ending in story.endings:
        if ending.ending_id in seen_endings:
            errors.append(
                validation_error(
                    "DUPLICATE_ENDING_ID",
                    f'Duplicate ending_id "{ending.ending_id}" in story "{story_id}".',
                    f"endings[{ending.ending_id}]",
                )
            )
        seen_endings.add(ending.ending_id)

    ending_scenes = [s for s in scenes if isinstance(s, EndingScene)]
    if len(ending_scenes) != 1:
        errors.append(
            validation_error(
                "ENDING_SCENE_COUNT",
                f'Story "{story_id}" must contain exactly one ending scene, '
                f"found {len(ending_scenes)}.",
                "chapters[*].scenes",
            )
        )

    # 4. No silent dead ends.
    for scene in scenes:
        if isinstance(scene, EndingScene):
            continue
        if scene.next_scene_id is None:
            errors.append(
                validation_error(
                    "DEAD_END_SCENE",
                    f'Scene "{scene.scene_id}" ({scene.type}) has no next_scene_id. '
                    "The engine would treat this as story completion.",
                    f"scenes[{scene.scene_id}].next_scene_id",
                )
            )

    # 5 and 6. Reachability.
    reachable = _reachable_scene_ids(story, scenes)
    for scene in scenes:
        if scene.scene_id not in reachable:
            errors.append(
                validation_error(
                    "UNREACHABLE_SCENE",
                    f'Scene "{scene.scene_id}" is not reachable from the entry scene.',
                    f"scenes[{scene.scene_id}]",
                )
            )
    if ending_scenes and ending_scenes[0].scene_id not in reachable:
        errors.append(
            validation_error(
                "ENDING_UNREACHABLE",
                f'The ending scene "{ending_scenes[0].scene_id}" is not reachable '
                "from the entry scene.",
                f"scenes[{ending_scenes[0].scene_id}]",
            )
        )

    # 7. Concept coverage.
    material_concepts = list(dict.fromkeys(c.concept_id for c in material.concepts))
    material_concept_set = set(material_concepts)

    # concept -> scenes. A scene may teach one concept over several learning_info blocks
    # (lesson steps); that still counts as one scene.
    introduced: dict[str, list[str]] = {}
    for scene in scenes:
        for block in getattr(scene, "content", []):
            if block.type != "learning_info":
                continue
            for concept_id in block.concept_ids:
                scene_ids = introduced.setdefault(concept_id, [])
                if scene.scene_id not in scene_ids:
                    scene_ids.append(scene.scene_id)

    tested: dict[str, list[str]] = {}
    for puzzle in story.puzzles:
        for concept_id in puzzle.concept_ids:
            tested.setdefault(concept_id, []).append(puzzle.puzzle_id)

    for concept_id in material_concepts:
        intro_scenes = introduced.get(concept_id, [])
        test_puzzles = tested.get(concept_id, [])
        path = f"knowledge_mapping[{concept_id}]"
        if not intro_scenes:
            errors.append(
                validation_error(
                    "CONCEPT_NOT_INTRODUCED",
                    f'Concept "{concept_id}" is never introduced by a learning_info block.',
                    path,
                )
            )
        elif len(intro_scenes) > 1:
            errors.append(
                validation_error(
                    "CONCEPT_INTRODUCED_TWICE",
                    f'Concept "{concept_id}" is introduced in multiple scenes: '
                    f"{', '.join(intro_scenes)}.",
                    path,
                )
            )
        if not test_puzzles:
            errors.append(
                validation_error(
                    "CONCEPT_NOT_TESTED",
                    f'Concept "{concept_id}" is never tested by a puzzle, '
                    "so it can never be demonstrated.",
                    path,
                )
            )
        elif len(test_puzzles) > 1:
            errors.append(
                validation_error(
                    "CONCEPT_TESTED_TWICE",
                    f'Concept "{concept_id}" is tested by multiple puzzles: '
                    f"{', '.join(test_puzzles)}.",
                    path,
                )
            )

    for concept_id in introduced:
        if concept_id not in material_concept_set:
            errors.append(
                validation_error(
                    "INVALID_CONCEPT_REF",
                    f'learning_info introduces concept "{concept_id}" which is not defined '
                    f'by material "{material.material_id}".',
                    f"knowledge_mapping[{concept_id}]",
                )
            )
    for concept_id in tested:
        if concept_id not in material_concept_set:
            errors.append(
                validation_error(
                    "INVALID_CONCEPT_REF",
                    f'A puzzle tests concept "{concept_id}" which is not defined '
                    f'by material "{material.material_id}".',
                    f"knowledge_mapping[{concept_id}]",
                )
            )

    # 8. knowledge_mapping is complete and has one entry per concept.
    mapped: dict[str, None] = {}
    for mapping in story.knowledge_mapping:
        if mapping.concept_id in mapped:
            errors.append(
                validation_error(
                    "DUPLICATE_KNOWLEDGE_MAPPING",
                    "knowledge_mapping contains multiple entries for concept "
                    f'"{mapping.concept_id}".',
                    f"knowledge_mapping[{mapping.concept_id}]",
                )
            )
        mapped[mapping.concept_id] = None

    for concept_id in material_concepts:
        if concept_id not in mapped:
            errors.append(
                validation_error(
                    "MISSING_KNOWLEDGE_MAPPING",
                    f'Concept "{concept_id}" has no knowledge_mapping entry.',
                    f"knowledge_mapping[{concept_id}]",
                )
            )
    for concept_id in mapped:
        if concept_id not in material_concept_set:
            errors.append(
                validation_error(
                    "INVALID_CONCEPT_REF",
                    f'knowledge_mapping references concept "{concept_id}" which is not defined '
                    f'by material "{material.material_id}".',
                    f"knowledge_mapping[{concept_id}]",
                )
            )

    # 9. required_knowledge soundness.
    if entry is not None:
        prior_tested: set[str] = set()
        for prior in previous_stories or []:
            for puzzle in prior.puzzles:
                prior_tested.update(puzzle.concept_ids)
        has_prior_context = len(previous_stories or []) > 0
        for concept_id in entry.required_knowledge:
            if concept_id in material_concept_set:
                errors.append(
                    validation_error(
                        "REQUIRED_KNOWLEDGE_SELF_REFERENCE",
                        f'Story "{story_id}" requires concept "{concept_id}" but that concept '
                        f'is taught by this story\'s own material "{material.material_id}".',
                        f"story.required_knowledge[{concept_id}]",
                    )
                )
            if has_prior_context and concept_id not in prior_tested:
                errors.append(
                    validation_error(
                        "REQUIRED_KNOWLEDGE_UNTESTABLE",
                        f'Story "{story_id}" requires concept "{concept_id}" but no earlier '
                        "supplied story tests it, so it can never be demonstrated.",
                        f"story.required_knowledge[{concept_id}]",
                    )
                )

    # 10. Prerequisite cycles inside the material.
    cyclic = _intra_material_cycle_concepts(material)
    if cyclic:
        errors.append(
            validation_error(
                "CONCEPT_PREREQUISITE_CYCLE",
                f'Material "{material.material_id}" has an intra-material prerequisite cycle '
                f"involving: {', '.join(cyclic)}.",
                f"material[{material.material_id}].concepts",
            )
        )

    # 11. Puzzle scenes point at existing puzzles.
    puzzle_ids = {p.puzzle_id for p in story.puzzles}
    for scene in scenes:
        if isinstance(scene, PuzzleScene) and scene.puzzle_id not in puzzle_ids:
            errors.append(
                validation_error(
                    "INVALID_PUZZLE_REF",
                    f'Puzzle scene "{scene.scene_id}" references unknown puzzle '
                    f'"{scene.puzzle_id}".',
                    f"scenes[{scene.scene_id}].puzzle_id",
                )
            )

    return errors
