"""Campaign Planner contract (Layer 2): CampaignBlueprint and its parts.

Why: mirrors `frontend/src/lib/contracts/schemas/campaign.schema.ts` (and the types in
`lib/types/campaign.ts`). The Layer 3 story endpoint receives a campaign and one of its story
entries, so `CampaignBlueprint`, `StorySummaryEntry` and `StoryOutcome` are reused by it. Required
strings must be non-empty and nothing optional exists, so nothing is ever serialized as null.
Numbers in `world_state_changes` must be finite: JSON from JavaScript never carries Infinity
or NaN, and Python's response encoder would refuse them anyway.
"""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal

from pydantic import Field, PlainValidator, Strict, StringConstraints
from pydantic_core import PydanticCustomError

from app.ai.zod_compat import ZodModel

Genre = Literal[
    "fantasy",
    "modern",
    "science_fiction",
    "mystery",
    "historical",
    "survival",
    "horror",
    "custom",
]

Text = Annotated[str, Strict()]
NonEmptyText = Annotated[str, Strict(), StringConstraints(min_length=1)]


def _number(value: object) -> int | float:
    """A JSON number: int or float, never a bool, string or non-finite float."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        # Same error type Pydantic uses for a wrong float input, so `zod_flatten` words it.
        raise PydanticCustomError("float_type", "Input should be a valid number")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Number must be finite")
    return value


# Keeps `10` as 10 (not 10.0) on the way out. A plain validator, not `int | float`, so a wrong
# input yields one error instead of one per union member.
Number = Annotated[Any, PlainValidator(_number)]


class Character(ZodModel):
    character_id: NonEmptyText
    name: NonEmptyText
    role: NonEmptyText
    description: NonEmptyText
    # Kaomoji-style expression keys mapped to display strings, e.g. "happy" -> "(^_^)".
    expressions: dict[Text, Text]


class StoryOutcome(ZodModel):
    outcome_id: NonEmptyText
    description: NonEmptyText
    world_state_changes: dict[Text, Number]


class StorySummaryEntry(ZodModel):
    story_id: NonEmptyText
    material_id: NonEmptyText
    title: NonEmptyText
    purpose: NonEmptyText
    main_conflict: NonEmptyText
    required_knowledge: list[Text]
    outcomes: list[StoryOutcome]


class CampaignBlueprint(ZodModel):
    campaign_id: NonEmptyText
    title: NonEmptyText
    genre: Genre
    tone: NonEmptyText
    premise: NonEmptyText
    main_conflict: NonEmptyText
    setting: NonEmptyText
    characters: Annotated[list[Character], Field(min_length=1)]
    world_rules: list[Text]
    story_sequence: Annotated[list[StorySummaryEntry], Field(min_length=1)]
