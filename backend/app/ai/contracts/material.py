"""Material Intelligence contract (Layer 1): MaterialBlueprint and Concept.

Why: mirrors `frontend/src/lib/contracts/schemas/material.schema.ts`. `notation` and `examples`
are optional (older blueprints lack them) and are omitted, not null, when serialized.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import Field, Strict, StringConstraints

from app.ai.zod_compat import ZodModel

Text = Annotated[str, Strict()]
NonEmptyText = Annotated[str, Strict(), StringConstraints(min_length=1)]


class Concept(ZodModel):
    concept_id: NonEmptyText
    name: NonEmptyText
    definition: NonEmptyText
    principles: list[Text]
    methods: list[Text]
    prerequisites: list[Text]
    misconceptions: list[Text]
    source_evidence: list[Text]
    notation: list[Text] | None = None
    examples: list[Text] | None = None


class MaterialBlueprint(ZodModel):
    material_id: NonEmptyText
    title: NonEmptyText
    summary: NonEmptyText
    learning_objectives: Annotated[list[Text], Field(min_length=1)]
    concepts: Annotated[list[Concept], Field(min_length=1)]
    scope_limitations: list[Text]
