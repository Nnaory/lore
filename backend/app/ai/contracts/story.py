"""Story Generator contract (Layer 3): StoryBlueprint, scenes, puzzles and endings.

Why: mirrors `frontend/src/lib/contracts/schemas/{story,scene,puzzle}.schema.ts`. The service
checks the provider's blueprint against these models (defence in depth, like the Zod check in
`story-generator-service.ts`) before it is returned.

Differences that matter on the wire:
- `continuity_summary` and a scene's `next_scene_id` are required but nullable in Zod
  (`.nullable()`), so they are `X | None` without a default here, and `StoryBlueprint.dump()`
  keeps a null `continuity_summary` instead of dropping it with the other unset optionals.
- A learning block's `visual` is optional and lenient: an invalid or null value is dropped, not
  an error, so one bad drawing spec never makes a story unreadable (Zod `.transform` + `.optional`).
  A puzzle's `visual` (a free drawing of the question, same five kinds) is lenient the same way.
  `dump()` omits it when empty, so stories without one are written exactly as before.
- `location` and `on_incorrect_scene_id` are optional and omitted, never null.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BeforeValidator, Field, Strict, model_validator

from app.ai.contracts.campaign import NonEmptyText, Number, Text
from app.ai.contracts.visual import VisualInvalid, parse_lesson_visual
from app.ai.zod_compat import ZodModel


def _visual_or_none(value: object) -> object:
    """Keep a valid visual (as its model); anything else becomes None."""
    parsed = parse_lesson_visual(value)
    return None if isinstance(parsed, VisualInvalid) else parsed.visual


# --- puzzle -----------------------------------------------------------------------------------


class PuzzleChoice(ZodModel):
    choice_id: NonEmptyText
    text: NonEmptyText


class Puzzle(ZodModel):
    """Multiple choice only. Correctness is data (`correct_choice_id`); the game engine judges."""

    puzzle_id: NonEmptyText
    concept_ids: Annotated[list[Text], Field(min_length=1)]
    narrative_context: NonEmptyText
    question: NonEmptyText
    choices: Annotated[list[PuzzleChoice], Field(min_length=2)]
    correct_choice_id: NonEmptyText
    explanation: NonEmptyText
    incorrect_feedback: NonEmptyText
    correct_feedback: NonEmptyText
    retry_allowed: Annotated[bool, Strict()]
    # A drawing of the question (vectors, plot, diagram, table or formula). It is never a source
    # of truth for the answer: the game engine judges `correct_choice_id`.
    visual: Annotated[Any, BeforeValidator(_visual_or_none)] = None

    # Same name as the base check on purpose: the override replaces it, because `visual` accepts
    # null (an invalid drawing is dropped) and no other field here is optional.
    @model_validator(mode="before")
    @classmethod
    def _reject_null_optional(cls, data: Any) -> Any:
        return data

    @model_validator(mode="after")
    def _correct_choice_exists(self) -> Puzzle:
        if not any(c.choice_id == self.correct_choice_id for c in self.choices):
            raise ValueError("correct_choice_id must match one of the choice_id values in choices")
        return self


# --- scene content ----------------------------------------------------------------------------


class NarrationContent(ZodModel):
    type: Literal["narration"]
    text: NonEmptyText


class DialogueContent(ZodModel):
    type: Literal["dialogue"]
    character_id: NonEmptyText
    expression: NonEmptyText
    text: NonEmptyText


class LearningContent(ZodModel):
    type: Literal["learning_info"]
    title: NonEmptyText
    body: NonEmptyText
    concept_ids: Annotated[list[Text], Field(min_length=1)]
    visual: Annotated[Any, BeforeValidator(_visual_or_none)] = None

    # Same name as the base check on purpose: the override replaces it, because `visual` accepts
    # null (Zod `z.unknown()`) and no other field here is optional.
    @model_validator(mode="before")
    @classmethod
    def _reject_null_optional(cls, data: Any) -> Any:
        return data


SceneContent = Annotated[
    NarrationContent | DialogueContent | LearningContent, Field(discriminator="type")
]

# --- endings and scenes -----------------------------------------------------------------------


class Ending(ZodModel):
    ending_id: NonEmptyText
    type: Literal["success", "failure", "partial_success"]
    title: NonEmptyText
    narration: NonEmptyText
    world_state_changes: dict[Text, Number]
    relationship_changes: dict[Text, Number]


class SceneBase(ZodModel):
    scene_id: NonEmptyText
    location: Text | None = None
    characters_present: list[Text]


class NarrativeScene(SceneBase):
    type: Literal["narrative"]
    content: Annotated[list[SceneContent], Field(min_length=1)]
    next_scene_id: Text | None


class LearningScene(SceneBase):
    type: Literal["learning"]
    content: Annotated[list[SceneContent], Field(min_length=1)]
    next_scene_id: Text | None


class InteractionScene(SceneBase):
    type: Literal["interaction"]
    content: Annotated[list[SceneContent], Field(min_length=1)]
    next_scene_id: Text | None


class PuzzleScene(SceneBase):
    type: Literal["puzzle"]
    puzzle_id: NonEmptyText
    next_scene_id: Text | None
    # Wrong choice_id -> consequence ("bad branch") scene_id.
    on_incorrect_scene_id: dict[NonEmptyText, NonEmptyText] | None = None


class ConsequenceScene(SceneBase):
    type: Literal["consequence"]
    content: Annotated[list[SceneContent], Field(min_length=1)]
    next_scene_id: Text | None


class EndingScene(SceneBase):
    type: Literal["ending"]
    ending_id: NonEmptyText


Scene = Annotated[
    NarrativeScene
    | LearningScene
    | InteractionScene
    | PuzzleScene
    | ConsequenceScene
    | EndingScene,
    Field(discriminator="type"),
]

# --- story ------------------------------------------------------------------------------------


class DecisionRecord(ZodModel):
    decision_id: NonEmptyText
    description: NonEmptyText
    result: NonEmptyText


class ContinuitySummary(ZodModel):
    story_id: NonEmptyText
    outcome_description: NonEmptyText
    key_decisions: list[DecisionRecord]
    world_state_snapshot: dict[Text, Number]
    relationship_snapshot: dict[Text, Number]


class KnowledgeMappingEntry(ZodModel):
    concept_id: NonEmptyText
    introduced_in_scene_id: NonEmptyText
    tested_in_puzzle_id: NonEmptyText


class Chapter(ZodModel):
    chapter_id: NonEmptyText
    title: NonEmptyText
    scenes: Annotated[list[Scene], Field(min_length=1)]


class StoryBlueprint(ZodModel):
    story_id: NonEmptyText
    material_id: NonEmptyText
    title: NonEmptyText
    summary: NonEmptyText
    character_ids: list[Text]
    chapters: Annotated[list[Chapter], Field(min_length=1)]
    puzzles: list[Puzzle]
    endings: list[Ending]
    continuity_summary: ContinuitySummary | None
    knowledge_mapping: list[KnowledgeMappingEntry]

    def dump(self) -> dict[str, Any]:
        """Wire form: unset optionals omitted, but `continuity_summary` stays (null allowed)."""
        data = super().dump()
        data.setdefault("continuity_summary", None)
        return data
