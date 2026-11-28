"""Request contracts for the AI endpoints (analyze-material, plan-campaign, generate-story).

Why: mirrors `AnalyzeMaterialRequestSchema`, `CampaignPlannerOptionsSchema`,
`PlanCampaignRequestSchema`, `PreviousStorySummarySchema`, `StoryGeneratorOptionsSchema` and
`GenerateStoryRequestSchema` in `frontend/src/lib/contracts/ai-requests.ts`.
Zod measures string length in UTF-16 code units, so the limits here do too; otherwise a
text with emoji could pass one side and fail the other. Limits match
`frontend/src/lib/ingest/limits.ts`.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import BeforeValidator, Field, Strict, field_validator
from pydantic_core import PydanticCustomError

from app.ai.contracts.campaign import (
    CampaignBlueprint,
    Genre,
    NonEmptyText,
    Number,
    StorySummaryEntry,
    Text,
)
from app.ai.contracts.material import MaterialBlueprint
from app.ai.zod_compat import ZodModel

MIN_MATERIAL_CHARS = 10
MAX_MATERIAL_CHARS = 80_000


def utf16_length(text: str) -> int:
    """Length of `text` as JavaScript's `String.length` counts it."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


class AnalyzeMaterialRequest(ZodModel):
    material: Annotated[str, Strict()]
    context: dict[str, Any] | None = None
    genre: Annotated[str, Strict()] | None = None

    @field_validator("material")
    @classmethod
    def _material_length(cls, value: str) -> str:
        length = utf16_length(value)
        if length < MIN_MATERIAL_CHARS:
            raise ValueError(f"material must be at least {MIN_MATERIAL_CHARS} characters")
        if length > MAX_MATERIAL_CHARS:
            raise ValueError(f"material must be at most {MAX_MATERIAL_CHARS} characters")
        return value


OptionalText = Annotated[str, Strict()] | None


class CampaignPlannerOptions(ZodModel):
    """Campaign-level creative options. Wire names are camelCase, like the Zod schema."""

    genre: Genre
    tone: OptionalText = None
    setting: OptionalText = None
    custom_instructions: OptionalText = Field(default=None, alias="customInstructions")
    campaign_id: OptionalText = Field(default=None, alias="campaignId")
    language: OptionalText = None


class PlanCampaignRequest(ZodModel):
    """Campaign Planner request: at least one valid material plus the options."""

    materials: Annotated[list[MaterialBlueprint], Field(min_length=1)]
    options: CampaignPlannerOptions


class PreviousStorySummary(ZodModel):
    """A compact snapshot of a completed story, for continuity. `outcome_description` may be ""."""

    story_id: NonEmptyText
    title: NonEmptyText
    outcome_description: Text
    world_state_snapshot: dict[Text, Number]
    relationship_snapshot: dict[Text, Number]


def _whole_number(value: object) -> object:
    """JSON `2.0` is the integer 2 in JavaScript; a fraction is the Zod "integer" error."""
    if isinstance(value, float):
        if value.is_integer():
            return int(value)
        raise PydanticCustomError("int_from_float", "Input should be a valid integer")
    return value


class StoryGeneratorOptions(ZodModel):
    """Story-level creative options. Wire names are camelCase, like the Zod schema."""

    concepts_per_chapter: (
        Annotated[int, BeforeValidator(_whole_number), Strict(), Field(ge=1)] | None
    ) = Field(default=None, alias="conceptsPerChapter")
    custom_instructions: OptionalText = Field(default=None, alias="customInstructions")
    language: OptionalText = None
    include_boss_chapter: Annotated[bool, Strict()] | None = Field(
        default=None, alias="includeBossChapter"
    )


class GenerateStoryRequest(ZodModel):
    """Story Generator request: ONE story of `campaign`, with the material it references."""

    campaign: CampaignBlueprint
    story: StorySummaryEntry
    material: MaterialBlueprint
    previous_summaries: list[PreviousStorySummary] | None = Field(
        default=None, alias="previousSummaries"
    )
    options: StoryGeneratorOptions | None = None
