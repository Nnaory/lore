"""Zod-compatible Pydantic base class and error flattening.

Why: the frontend validates the same payloads with Zod, so the backend models must accept and
reject the same inputs and describe failures in the same `flatten()` shape
(`{formErrors: [], fieldErrors: {field: [message]}}`) that the Next.js routes return as `detail`.
Zod objects strip unknown keys (Pydantic's default `extra="ignore"` does too), and Zod
`.optional()` accepts a missing key but not `null`; the base class rejects `null` for optional
fields to match. Serialize with `dump()` so unset optionals are omitted, never `null`.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator
from pydantic_core import ErrorDetails


class ZodModel(BaseModel):
    """Base for contract models: ignore unknown keys, reject null for optional fields."""

    model_config = ConfigDict(populate_by_name=True)

    # A model-level check (not a "*" field validator) because Pydantic forbids before-validators
    # on a discriminator field. The cost is that the error is reported on the model, not the field.
    @model_validator(mode="before")
    @classmethod
    def _reject_null_optional(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for name, field in cls.model_fields.items():
                key = field.alias or name
                if key in data and data[key] is None and not field.is_required():
                    raise ValueError(f'Expected value for "{key}", received null')
        return data

    def dump(self) -> dict[str, Any]:
        """JSON-ready dict using wire names, without optional fields that were not set."""
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)


# Zod messages for min(1) checks that the schemas customise, keyed by the failing field name.
_CUSTOM_MESSAGES: dict[str, str] = {
    "concept_id": "concept_id must not be empty",
    "name": "concept name must not be empty",
    "definition": "definition must not be empty",
    "material_id": "material_id must not be empty",
    "title": "material title must not be empty",
    "summary": "material summary must not be empty",
    "learning_objectives": "at least one learning objective is required",
    "concepts": "at least one concept is required",
    "section_id": "section_id must not be empty",
    "file_name": "file_name must not be empty",
    "text": "section text must not be empty",
    "source_ref": "source_ref must not be empty",
    "sections": "a document must contain at least one section",
    "materials": "at least one material is required",
    "characters": "at least one character is required",
    "story_sequence": "story_sequence must contain at least one story",
}

# Some Zod messages depend on the object a field belongs to: `name` is "concept name" in a
# concept but "character name" in a character. The scope is the nearest named parent in the
# error path (`characters.0.name`), or the model itself for a top-level field.
_SCOPE_OF_PARENT: dict[str, str] = {
    "characters": "character",
    "story_sequence": "story",
    "story": "story",
    "outcomes": "outcome",
    "campaign": "campaign",
    "previousSummaries": "previous_summary",
}
_SCOPE_OF_MODEL: dict[str, str] = {"CampaignBlueprint": "campaign"}
_SCOPED_MESSAGES: dict[tuple[str, str], str] = {
    ("character", "character_id"): "character_id must not be empty",
    ("character", "name"): "character name must not be empty",
    ("character", "role"): "character role must not be empty",
    ("character", "description"): "character description must not be empty",
    ("outcome", "outcome_id"): "outcome_id must not be empty",
    ("outcome", "description"): "outcome description must not be empty",
    ("story", "story_id"): "story_id must not be empty",
    ("story", "material_id"): "material_id must not be empty",
    ("story", "title"): "story title must not be empty",
    ("story", "purpose"): "story purpose must not be empty",
    ("story", "main_conflict"): "main_conflict must not be empty",
    ("campaign", "campaign_id"): "campaign_id must not be empty",
    ("campaign", "title"): "campaign title must not be empty",
    ("campaign", "tone"): "tone must not be empty",
    ("campaign", "premise"): "premise must not be empty",
    ("campaign", "main_conflict"): "main_conflict must not be empty",
    ("campaign", "setting"): "setting must not be empty",
    ("previous_summary", "story_id"): "story_id must not be empty",
    ("previous_summary", "title"): "title must not be empty",
}

# What JavaScript's String.prototype.trim removes (and Zod's `.trim()` with it). It differs from
# Python's str.strip(): it includes U+FEFF and leaves the C0 separators U+001C to U+001F alone.
_JS_WHITESPACE = (
    "\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008"
    "\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def js_trim(text: str) -> str:
    """`text.trim()` as JavaScript does it."""
    return text.strip(_JS_WHITESPACE)


def zod_type_name(value: Any) -> str:
    """The type name Zod prints in "Expected X, received Y" messages."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list | tuple):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _custom_message(err: ErrorDetails, model: str, fallback: str) -> str:
    """The schema's own min(1) message for the failing field, or `fallback`."""
    names = [p for p in err["loc"] if isinstance(p, str)]
    last = names[-1] if names else ""
    parent = names[-2] if len(names) > 1 else None
    scope = _SCOPE_OF_PARENT.get(parent) if parent else _SCOPE_OF_MODEL.get(model)
    scoped = _SCOPED_MESSAGES.get((scope, last)) if scope else None
    return scoped or _CUSTOM_MESSAGES.get(last, fallback)


def _enum_options(expected: object) -> str:
    """Pydantic's "'a', 'b' or 'c'" written the way Zod does: "'a' | 'b' | 'c'"."""
    return " | ".join(f"'{v}'" for v in re.findall(r"'([^']*)'", str(expected)))


def _message(err: ErrorDetails, model: str = "") -> str:
    kind = err["type"]
    ctx = err.get("ctx") or {}
    received = zod_type_name(err.get("input"))
    if kind == "missing":
        return "Required"
    if kind == "string_type":
        return f"Expected string, received {received}"
    if kind in ("int_type", "int_parsing", "float_type", "float_parsing"):
        return f"Expected number, received {received}"
    if kind == "int_from_float":
        return "Expected integer, received float"
    if kind == "bool_type":
        return f"Expected boolean, received {received}"
    if kind in ("list_type", "tuple_type"):
        return f"Expected array, received {received}"
    if kind in ("dict_type", "model_type", "model_attributes_type"):
        return f"Expected object, received {received}"
    if kind == "string_too_short":
        return _custom_message(
            err, model, f"String must contain at least {ctx.get('min_length')} character(s)"
        )
    if kind == "string_too_long":
        return f"String must contain at most {ctx.get('max_length')} character(s)"
    if kind == "too_short":
        return _custom_message(
            err, model, f"Array must contain at least {ctx.get('min_length')} element(s)"
        )
    if kind == "too_long":
        return f"Array must contain at most {ctx.get('max_length')} element(s)"
    if kind == "greater_than_equal":
        return f"Number must be greater than or equal to {ctx.get('ge')}"
    if kind == "less_than_equal":
        return f"Number must be less than or equal to {ctx.get('le')}"
    if kind == "finite_number":
        return "Number must be finite"
    if kind in ("enum", "literal_error"):
        options = _enum_options(ctx.get("expected"))
        if isinstance(err.get("input"), str):
            return f"Invalid enum value. Expected {options}, received '{err['input']}'"
        return f"Expected {options}, received {received}"
    if kind in ("union_tag_invalid", "union_tag_not_found"):
        return "Invalid input"
    if kind == "value_error":
        return err["msg"].removeprefix("Value error, ")
    return err["msg"]


def zod_flatten(exc: ValidationError) -> dict[str, Any]:
    """Describe `exc` like Zod's `error.flatten()`: top-level field -> list of messages."""
    form_errors: list[str] = []
    field_errors: dict[str, list[str]] = {}
    for err in exc.errors(include_url=False):
        message = _message(err, exc.title)
        loc = err["loc"]
        if loc:
            field_errors.setdefault(str(loc[0]), []).append(message)
        else:
            form_errors.append(message)
    return {"formErrors": form_errors, "fieldErrors": field_errors}
