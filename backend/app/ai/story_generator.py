"""Story Generator (Layer 3): Gemini provider, content merge and service.

Why: port of `frontend/src/lib/ai/story-generator-service.ts` and
`providers/gemini-story-generator.ts` ("skeleton + slots"), with three deliberate differences from
the TypeScript original (25 Nov 2026): the prompt asks for short text, long text is split into
dialogue-box sized blocks, and puzzles may carry a visual:

1. The engine (`build_story_blueprint`) builds the whole story with template text in every slot:
   scene chain, IDs, one learning scene, one puzzle and one result scene per concept, the ending
   and the knowledge mapping. Structure is never provider-controlled.
2. Gemini writes the text for those slots in ONE call (`SYSTEM_PROMPT`, `build_story_prompt`).
3. `merge_story_content` overlays every valid piece of text on the skeleton. Anything missing or
   invalid keeps its template text, so the story is always playable. Each concept is taught in 2
   to 4 lesson steps (`learning_info` blocks in the same scene), each optionally with an
   illustration spec; a spec that fails `parse_lesson_visual` is dropped and recorded in a
   `VISUAL_DROPPED` warning. A puzzle may carry a free drawing of its question (`visual`, same
   five kinds); it follows the same rule. Puzzle choices are shuffled deterministically so the
   correct answer is not always first. Gemini never decides correctness: `correct_choice_id` is
   data. Last, `chunk_story_content` splits narration, dialogue and lesson text that is longer
   than the Stage's dialogue box into consecutive blocks (see `chunking.py`).
4. The service checks the result against the StoryBlueprint model and the generator rules, and
   returns `AiOk | AiError` like the other layers (never raises for expected failures).

Failure policy (as in TypeScript): with no usable Gemini answer there is no template-only story,
because it would be generic text in the wrong language; the player gets PROVIDER_UNAVAILABLE (or
OUTPUT_PARSE_FAILED when Gemini kept answering non-JSON) and can retry. An answer that parses but
holds little useful text is not a failure: the skeleton text fills the gaps and a
`CONTENT_PARTIAL_FALLBACK` warning lists them. If the merge somehow breaks the story, the skeleton
alone is returned.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field, replace
from typing import Annotated, Any, ClassVar

from pydantic import (
    AfterValidator,
    BeforeValidator,
    Field,
    Strict,
    ValidationError,
    model_validator,
)

from app.ai.chunking import chunk_story_content
from app.ai.contracts.requests import GenerateStoryRequest, utf16_length
from app.ai.contracts.story import StoryBlueprint
from app.ai.contracts.visual import VisualInvalid, parse_lesson_visual
from app.ai.envelope import AiError, AiOk, AiResult
from app.ai.gemini_client import GeminiOk, GeminiRequest
from app.ai.hash import seeded_shuffle
from app.ai.prompts.story_generator import SYSTEM_PROMPT, build_story_prompt
from app.ai.runtime import AiContext
from app.ai.story_generator_engine import StoryEngineError, build_story_blueprint
from app.ai.validation import validation_error
from app.ai.validation.generator import validate_generated_story
from app.ai.zod_compat import ZodModel, js_trim, zod_flatten

PROVIDER_ID = "google"
MAX_LESSON_STEPS = 4
_MAX_OUTPUT_TOKENS = 20_000
_TEMPERATURE = 0.8
# Several lesson steps per concept make this the longest answer of the pipeline, so it gets more
# time than the default per-request limit and total budget.
STORY_TIMEOUT_MS = 90_000
STORY_DEADLINE_MS = 150_000
UNAVAILABLE_MESSAGE = "The AI storyteller is unavailable right now. Try again in a moment."

_UNSET: Any = object()  # a field that was absent (Zod `undefined`), as opposed to null


# --- what Gemini may write (lenient: each piece is checked on its own) -----------------------


def _trimmed(min_length: int, max_length: int) -> Any:
    """Zod `z.string().trim().min(1).max(n)`: trimmed first, then 1..n UTF-16 code units."""

    def prepare(value: object) -> object:
        return js_trim(value) if isinstance(value, str) else value

    def check(value: str) -> str:
        if not min_length <= utf16_length(value) <= max_length:
            raise ValueError(f"text must be {min_length} to {max_length} characters")
        return value

    return Annotated[str, BeforeValidator(prepare), Strict(), AfterValidator(check)]


Line = _trimmed(1, 400)
Paragraph = _trimmed(1, 1600)
Title = _trimmed(1, 120)


class _ContentModel(ZodModel):
    """ZodModel whose `z.unknown().optional()` fields (listed in `nullable_keys`) accept null."""

    nullable_keys: ClassVar[frozenset[str]] = frozenset()

    # Same name as the base check on purpose: this override replaces it.
    @model_validator(mode="before")
    @classmethod
    def _reject_null_optional(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for name, field_info in cls.model_fields.items():
                key = field_info.alias or name
                if (
                    key in data
                    and data[key] is None
                    and not field_info.is_required()
                    and key not in cls.nullable_keys
                ):
                    raise ValueError(f'Expected value for "{key}", received null')
        return data


class PuzzleContent(_ContentModel):
    nullable_keys = frozenset({"visual"})

    narrative_context: Paragraph
    question: Line
    correct_answer: Line
    wrong_answers: Annotated[list[Line], Field(min_length=2, max_length=3)]
    explanation: Paragraph
    correct_feedback: Line
    incorrect_feedback: Line
    # Optional drawing of the question; null or absent means "no drawing", checked later.
    visual: Any = _UNSET


class LessonStep(_ContentModel):
    nullable_keys = frozenset({"visual"})

    title: Title
    body: Paragraph
    visual: Any = _UNSET
    # What the companion says before this step (ignored on the first step).
    companion_line: Line | None = None


class ConceptContent(_ContentModel):
    nullable_keys = frozenset({"lesson_visual", "puzzle"})

    concept_id: Annotated[str, Strict()]
    companion_line: Line | None = None
    # Each step is checked on its own, so one bad step does not lose the rest.
    lesson_steps: list[Any] | None = None
    # Single-lesson form (older prompt); used when `lesson_steps` has no usable step.
    lesson_title: Title | None = None
    lesson_body: Paragraph | None = None
    lesson_visual: Any = _UNSET
    puzzle: Any = _UNSET
    result_narration: Paragraph | None = None
    guide_line: Line | None = None


class IntroContent(_ContentModel):
    narration: Paragraph | None = None
    guide_line: Line | None = None


class EndingContent(_ContentModel):
    title: Title | None = None
    narration: Paragraph | None = None


class StoryContent(_ContentModel):
    intro: IntroContent | None = None
    concepts: list[Any] | None = None
    ending: EndingContent | None = None


# --- merge ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MergeResult:
    blueprint: dict[str, Any]
    templated: list[str]  # slots that kept their template text
    dropped_visuals: list[str]  # concepts whose illustration was invalid


def _norm(text: str) -> str:
    """Normalised text for comparing answers."""
    return js_trim(re.sub(r"\s+", " ", text.lower()))


def _set_dialogue(scene: dict[str, Any], text: str | None) -> None:
    if not text:
        return
    block = next((b for b in scene["content"] if b["type"] == "dialogue"), None)
    if block is not None:
        block["text"] = text


def _set_first_narration(scene: dict[str, Any], text: str | None) -> None:
    if not text:
        return
    block = next((b for b in scene["content"] if b["type"] == "narration"), None)
    if block is not None:
        block["text"] = text


def _attach_visual(
    block: dict[str, Any], raw: object, concept_id: str, dropped: list[str]
) -> dict[str, Any]:
    """`block` with a valid visual attached; an invalid one is reported (once per concept)."""
    if raw is _UNSET:
        return block
    parsed = parse_lesson_visual(raw)
    if isinstance(parsed, VisualInvalid):
        if concept_id not in dropped:
            dropped.append(concept_id)
        return block
    return {**block, "visual": parsed.visual.dump()}


def _written_puzzle(
    base: dict[str, Any], raw: object, concept_id: str, dropped: list[str]
) -> dict[str, Any] | None:
    """The puzzle with Gemini's wording, or None when it is unusable.

    A drawing of the question is attached when it passes `parse_lesson_visual`. A bad one is
    dropped and recorded in `dropped`; it never makes the puzzle unusable. `null` counts as "no
    drawing", not as a bad one. Whether the drawing leaks an answer is not checked here: that is
    the prompt's job, and correctness stays in `correct_choice_id`.
    """
    try:
        written = PuzzleContent.model_validate(raw)
    except ValidationError:
        return None
    seen = {_norm(written.correct_answer)}
    wrong: list[str] = []
    for answer in written.wrong_answers:
        key = _norm(answer)
        if key in seen:
            continue
        seen.add(key)
        wrong.append(answer)
    if len(wrong) < 2:
        return None
    puzzle = {
        **base,
        "narrative_context": written.narrative_context,
        "question": written.question,
        "choices": [
            {"choice_id": base["correct_choice_id"], "text": written.correct_answer},
            *(
                {"choice_id": f"{base['puzzle_id']}_w{i + 1}", "text": text}
                for i, text in enumerate(wrong)
            ),
        ],
        "explanation": written.explanation,
        "correct_feedback": written.correct_feedback,
        "incorrect_feedback": written.incorrect_feedback,
    }
    if written.visual is None:
        return puzzle
    return _attach_visual(puzzle, written.visual, concept_id, dropped)


def _usable_steps(raw_steps: list[Any] | None) -> list[LessonStep]:
    steps: list[LessonStep] = []
    for raw in raw_steps or []:
        try:
            steps.append(LessonStep.model_validate(raw))
        except ValidationError:
            continue
    return steps[:MAX_LESSON_STEPS]


def merge_story_content(skeleton: dict[str, Any], content: StoryContent) -> MergeResult:
    """Overlay Gemini's text on the skeleton. Returns a new blueprint; `skeleton` is untouched."""
    story = copy.deepcopy(skeleton)
    templated: list[str] = []
    dropped: list[str] = []
    scenes = {s["scene_id"]: s for chapter in story["chapters"] for s in chapter["scenes"]}

    # Intro = first scene of the first chapter.
    intro = story["chapters"][0]["scenes"][0] if story["chapters"] else None
    if intro is not None and "content" in intro:
        if content.intro is not None and content.intro.narration:
            _set_first_narration(intro, content.intro.narration)
        else:
            templated.append("intro.narration")
        if content.intro is not None and content.intro.guide_line:
            _set_dialogue(intro, content.intro.guide_line)

    written: dict[str, ConceptContent] = {}
    for raw in content.concepts or []:
        try:
            parsed = ConceptContent.model_validate(raw)
        except ValidationError:
            continue
        written[parsed.concept_id] = parsed

    for mapping in story["knowledge_mapping"]:
        concept_id = mapping["concept_id"]
        c = written.get(concept_id)
        if c is None:
            templated.append(f"concept:{concept_id}")
            continue

        learning = scenes.get(mapping["introduced_in_scene_id"])
        if learning is not None and "content" in learning:
            _set_dialogue(learning, c.companion_line)
            lesson_index = next(
                (i for i, b in enumerate(learning["content"]) if b["type"] == "learning_info"),
                -1,
            )
            lesson = learning["content"][lesson_index] if lesson_index >= 0 else None
            if lesson is not None:
                steps = _usable_steps(c.lesson_steps)
                if steps:
                    # The companion's line before the lesson is the voice between steps.
                    speaker = next(
                        (b for b in learning["content"] if b["type"] == "dialogue"), None
                    )
                    blocks: list[dict[str, Any]] = []
                    for i, step in enumerate(steps):
                        if i > 0 and step.companion_line and speaker is not None:
                            blocks.append({**speaker, "text": step.companion_line})
                        blocks.append(
                            _attach_visual(
                                {
                                    "type": "learning_info",
                                    "title": step.title,
                                    "body": step.body,
                                    "concept_ids": list(lesson["concept_ids"]),
                                },
                                step.visual,
                                concept_id,
                                dropped,
                            )
                        )
                    learning["content"][lesson_index : lesson_index + 1] = blocks
                else:
                    single = dict(lesson)
                    if c.lesson_title:
                        single["title"] = c.lesson_title
                    if c.lesson_body:
                        single["body"] = c.lesson_body
                    else:
                        templated.append(f"lesson:{concept_id}")
                    learning["content"][lesson_index] = _attach_visual(
                        single, c.lesson_visual, concept_id, dropped
                    )

        puzzle_index = next(
            (
                i
                for i, p in enumerate(story["puzzles"])
                if p["puzzle_id"] == mapping["tested_in_puzzle_id"]
            ),
            -1,
        )
        if puzzle_index >= 0:
            replaced = _written_puzzle(
                story["puzzles"][puzzle_index], c.puzzle, concept_id, dropped
            )
            if replaced is not None:
                story["puzzles"][puzzle_index] = replaced
            else:
                templated.append(f"puzzle:{mapping['tested_in_puzzle_id']}")

        puzzle_scene = next(
            (
                s
                for s in scenes.values()
                if s["type"] == "puzzle" and s["puzzle_id"] == mapping["tested_in_puzzle_id"]
            ),
            None,
        )
        result_id = puzzle_scene["next_scene_id"] if puzzle_scene is not None else None
        result = scenes.get(result_id) if result_id else None
        if result is not None and "content" in result:
            _set_first_narration(result, c.result_narration)
            _set_dialogue(result, c.guide_line)

    ending = story["endings"][0] if story["endings"] else None
    if ending is not None:
        if content.ending is not None and content.ending.title:
            ending["title"] = content.ending.title
        if content.ending is not None and content.ending.narration:
            ending["narration"] = content.ending.narration
        else:
            templated.append("ending.narration")

    # Shuffle every puzzle's choices so the correct one is not always first. The seed holds the
    # puzzle's content, not just its ID: IDs like "puzzle_story_01_c01" repeat across stories.
    story["puzzles"] = [
        {
            **p,
            "choices": seeded_shuffle(
                p["choices"],
                f"{p['puzzle_id']}|{p['question']}|{'|'.join(c['text'] for c in p['choices'])}",
            ),
        }
        for p in story["puzzles"]
    ]
    # Last step, once all text (Gemini's and the template's) is in place: split what would not
    # fit in the Stage's dialogue box into consecutive blocks.
    return MergeResult(chunk_story_content(story), templated, dropped)


# --- provider ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class StoryCandidate:
    """What the provider hands to the service."""

    blueprint: dict[str, Any]
    provider: str
    model: str
    latency_ms: int
    warnings: list[dict[str, str]] = field(default_factory=list)


def _is_playable(blueprint: dict[str, Any], request: GenerateStoryRequest) -> bool:
    """Schema and generator rules both pass (the merge must never break a story)."""
    try:
        model = StoryBlueprint.model_validate(blueprint)
    except ValidationError:
        return False
    return not validate_generated_story(model, request.material, request.story, [])


async def generate_candidate(
    request: GenerateStoryRequest, ctx: AiContext
) -> StoryCandidate | AiError:
    """Engine skeleton plus Gemini's text. Fails when Gemini gave nothing usable."""
    started = ctx.runtime.monotonic()
    engine = build_story_blueprint(request)
    if isinstance(engine, StoryEngineError):
        return AiError(engine.code, engine.message, engine.detail)
    warnings = list(engine.warnings)

    gemini_ctx = AiContext(
        replace(
            ctx.config,
            timeout_ms=max(ctx.config.timeout_ms, STORY_TIMEOUT_MS),
            deadline_ms=max(ctx.config.deadline_ms, STORY_DEADLINE_MS),
        ),
        ctx.runtime,
    )
    result = await gemini_ctx.generate_json(
        GeminiRequest(
            system=SYSTEM_PROMPT,
            prompt=build_story_prompt(request, engine.blueprint),
            max_output_tokens=_MAX_OUTPUT_TOKENS,
            temperature=_TEMPERATURE,
        )
    )
    if not isinstance(result, GeminiOk):
        code = (
            "OUTPUT_PARSE_FAILED"
            if result.code == "OUTPUT_PARSE_FAILED"
            else ("PROVIDER_UNAVAILABLE")
        )
        return AiError(code, UNAVAILABLE_MESSAGE, result.detail)

    try:
        content = StoryContent.model_validate(result.json)
    except ValidationError:
        content = StoryContent()
    merged = merge_story_content(engine.blueprint, content)
    blueprint, templated, dropped = merged.blueprint, merged.templated, merged.dropped_visuals

    # Defence in depth: if the merge somehow broke the story, fall back to the skeleton.
    if not _is_playable(blueprint, request):
        blueprint = merge_story_content(engine.blueprint, StoryContent()).blueprint
        templated = ["*"]
        dropped = []

    if templated:
        warnings.append(
            validation_error(
                "CONTENT_PARTIAL_FALLBACK",
                f"Template text was kept for: {', '.join(templated)}.",
                "story",
            )
        )
    if dropped:
        warnings.append(
            validation_error(
                "VISUAL_DROPPED",
                f"Illustrations were invalid and are shown as text for: {', '.join(dropped)}.",
                "story",
            )
        )
    latency_ms = round((ctx.runtime.monotonic() - started) * 1000)
    return StoryCandidate(blueprint, PROVIDER_ID, result.model, latency_ms, warnings)


# --- service ----------------------------------------------------------------------------------


def check_request(request: GenerateStoryRequest) -> AiError | None:
    """Cross-reference checks the schema cannot express."""
    campaign, entry, material = request.campaign, request.story, request.material
    if not any(s.story_id == entry.story_id for s in campaign.story_sequence):
        return AiError(
            "STORY_NOT_IN_CAMPAIGN",
            f'Story "{entry.story_id}" is not part of campaign "{campaign.campaign_id}".',
        )
    if entry.material_id != material.material_id:
        return AiError(
            "MATERIAL_MISMATCH",
            f'Story "{entry.story_id}" references material "{entry.material_id}" '
            f'but material "{material.material_id}" was supplied.',
        )
    return None


def check_candidate(candidate: StoryCandidate, request: GenerateStoryRequest) -> AiResult:
    """Schema check, then generator rules; returns the envelope data on success."""
    try:
        model = StoryBlueprint.model_validate(candidate.blueprint)
    except ValidationError as exc:
        return AiError(
            "OUTPUT_PARSE_FAILED",
            "Provider output failed StoryBlueprint schema validation.",
            zod_flatten(exc),
        )
    errors = validate_generated_story(model, request.material, request.story, [])
    if errors:
        return AiError("VALIDATION_FAILED", "Generated story failed semantic validation.", errors)
    return AiOk(
        {
            "blueprint": candidate.blueprint,
            "meta": {
                "provider": candidate.provider,
                "model": candidate.model,
                "latencyMs": candidate.latency_ms,
                "warnings": list(candidate.warnings),
            },
        }
    )


async def generate_story(request: GenerateStoryRequest, ctx: AiContext) -> AiResult:
    """Generate one story: request checks -> provider -> schema and semantic validation."""
    invalid = check_request(request)
    if invalid is not None:
        return invalid
    candidate = await generate_candidate(request, ctx)
    if isinstance(candidate, AiError):
        return candidate
    return check_candidate(candidate, request)
