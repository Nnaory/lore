"""Request contracts for mid-story Q&A (`POST /api/v1/ai/ask`).

Why: mirrors `AskQuestionRequestSchema` and its nested types in
`frontend/src/lib/contracts/ai-requests.ts`. Kept in its own module cleanly separated from
`requests.py` to avoid circular imports with `animation.models -> contracts.requests`.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BeforeValidator, Field, Strict, field_validator

from app.ai.contracts.campaign import CampaignBlueprint, NonEmptyText, Text
from app.ai.contracts.material import MaterialBlueprint
from app.ai.contracts.requests import OptionalText, _whole_number, utf16_length
from app.ai.contracts.story import StoryBlueprint
from app.ai.zod_compat import ZodModel, js_trim

MIN_QUESTION_CHARS = 1
MAX_QUESTION_CHARS = 1_000

KnowledgeStatus = Literal["not_introduced", "introduced", "developing", "demonstrated"]


class AskKnowledgeEntry(ZodModel):
    """Compact concept mastery snapshot sent with a mid-story question."""

    concept_id: NonEmptyText
    status: KnowledgeStatus


class AskLogItem(ZodModel):
    """Compact story-log turn sent as conversational context for a learner question."""

    kind: Literal["narration", "dialogue", "lesson", "question", "answer"]
    speaker: OptionalText = None
    title: OptionalText = None
    text: NonEmptyText


class AskTurn(ZodModel):
    """One prior learner Q&A exchange in the active play session."""

    question: NonEmptyText
    answer: NonEmptyText


class AskSceneContext(ZodModel):
    """Where the player is in the story and recent conversation history when asking."""

    scene_id: NonEmptyText
    chapter_id: OptionalText = None
    chapter_title: OptionalText = None
    block_index: Annotated[int, BeforeValidator(_whole_number), Strict(), Field(ge=0)] | None = None
    speaker_character_id: OptionalText = None
    recent_log: Annotated[list[AskLogItem], Field(max_length=20)] | None = None
    qa_history: Annotated[list[AskTurn], Field(max_length=12)] | None = None
    player_knowledge: dict[Text, AskKnowledgeEntry] | None = None


def _trim_string(value: object) -> object:
    return js_trim(value) if isinstance(value, str) else value


class AskQuestionRequest(ZodModel):
    """Mid-story Q&A request: learner question + materials, campaign, story, and active context."""

    question: Annotated[str, BeforeValidator(_trim_string), Strict()]
    campaign: CampaignBlueprint
    story: StoryBlueprint
    materials: list[MaterialBlueprint]
    context: AskSceneContext

    @field_validator("question")
    @classmethod
    def _question_length(cls, value: str) -> str:
        length = utf16_length(value)
        if length < MIN_QUESTION_CHARS:
            raise ValueError(f"question must be at least {MIN_QUESTION_CHARS} character")
        if length > MAX_QUESTION_CHARS:
            raise ValueError(f"question must be at most {MAX_QUESTION_CHARS} characters")
        return value
