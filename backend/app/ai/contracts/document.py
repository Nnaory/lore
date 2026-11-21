"""Extracted document contract (Layer 0 output).

Why: mirrors `frontend/src/lib/contracts/schemas/document.schema.ts`. Ingest runs in the
browser today; the model lets later endpoints accept a document with the same rules.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BeforeValidator, Field, Strict, StringConstraints, model_validator

from app.ai.zod_compat import ZodModel

NonEmptyText = Annotated[str, Strict(), StringConstraints(min_length=1)]


def _whole_number(value: object) -> object:
    """JSON `3.0` is the integer 3 in JavaScript; accept it, still reject booleans."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


NonNegativeInt = Annotated[int, BeforeValidator(_whole_number), Strict(), Field(ge=0)]


class DocumentSection(ZodModel):
    section_id: NonEmptyText
    title: NonEmptyText
    text: NonEmptyText
    source_ref: NonEmptyText


class DocumentWarning(ZodModel):
    code: Literal["PARTIAL_TEXT_LAYER", "EMPTY_SLIDES_SKIPPED"]
    message: NonEmptyText


class DocumentStats(ZodModel):
    units: NonNegativeInt
    words: NonNegativeInt
    chars: NonNegativeInt


class ExtractedDocument(ZodModel):
    file_name: NonEmptyText
    file_type: Literal["pdf", "docx", "pptx", "text"]
    sections: Annotated[list[DocumentSection], Field(min_length=1)]
    stats: DocumentStats
    warnings: list[DocumentWarning]

    @model_validator(mode="after")
    def _unique_section_ids(self) -> ExtractedDocument:
        if len({s.section_id for s in self.sections}) != len(self.sections):
            raise ValueError("section_id values must be unique")
        return self
