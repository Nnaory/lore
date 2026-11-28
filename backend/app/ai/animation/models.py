"""Pydantic models for AI-written animations: request, reference, verifier result, manifest, SSE.

Why: the request body, the `Animation_Reference` stored in stories, the verifier output, the S3
manifest and the stream events cross three boundaries (browser, Lambda, S3), so each has one model
that every module shares (design 5.2, 6.2, 10.2 to 10.4). Rules follow the Zod schemas in the
frontend so both sides decide alike on the shared fixtures in `tests/fixtures/animation/`:

- lengths count UTF-16 code units like `String.length`, and `title` is trimmed like `.trim()`;
- a lone surrogate in any key or value is rejected (`JSON.parse` keeps one, UTF-8 cannot);
- `30.0` is the whole number 30 and `30.5` is not (`WholeInt`);
- unknown keys are dropped, `null` is not accepted for an optional field, and `dump()` omits
  unset optionals so `pause_at_frame` is absent, never `null`.

Canvas size, duration range, byte limits, message length and code prefixes come from
`load_contract()` when a value is checked, never from a second literal here (Requirement 2.6). If
the contract is missing or invalid, validation fails with an ordinary `ValidationError`; the
endpoint answers 503 `ANIMATION_NOT_CONFIGURED` before it reaches these models.

`canonical_json` and `canonical_hash` live here too (design note N-2). The Request_Hash is built
from a validated `CreateAnimationRequest` and is the idempotency key of the registry (design 10.5,
Requirement 18). Two requests that mean the same thing must give the same key, so the JSON is
canonical: sorted keys, no spaces, UTF-8 left unescaped, whole floats written as integers and no
Unicode normalization.

`reference_from_row` builds the `AnimationReference` of a registry row for every caller that answers
from a row (the agent, the Idempotent_Hit and the Reader), so the three cannot drift apart.

`_whole_number` is a local copy on purpose (design note K-5): importing a name that starts with an
underscore from another module is a bad cross-module dependency. This module must not import
`langgraph` or `boto3` (Requirement 41.1).
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, ClassVar, Literal, get_args

from pydantic import (
    BeforeValidator,
    ConfigDict,
    Field,
    Strict,
    StrictBool,
    StringConstraints,
    ValidationInfo,
    field_validator,
    model_validator,
)

from app.ai.animation.contract import (
    AGENT_PREFIX,
    AnimationContract,
    ContractOk,
    diagnostic_code_pattern,
    load_contract,
)
from app.ai.contracts.requests import utf16_length
from app.ai.contracts.visual import (
    DiagramVisual,
    FormulaVisual,
    PlotVisual,
    TableVisual,
    VectorsVisual,
    VisualInvalid,
    parse_lesson_visual,
)
from app.ai.zod_compat import ZodModel, js_trim

# Request limits (Requirement 15.2). Counted in UTF-16 code units, like Zod's `.max()`.
TITLE_MAX_UNITS = 200
TEXT_MAX_UNITS = 2000
CONCEPTS_MAX = 5
CONCEPT_MAX_UNITS = 80
FORBIDDEN_TOKENS_MAX = 8
FORBIDDEN_TOKEN_MAX_UNITS = 80

# One run makes at most four Gemini calls (Requirement 13.4), so `attempts` is 1 to 4 everywhere.
ATTEMPTS_MIN = 1
ATTEMPTS_MAX = 4

# A `diagnostics` event lists at most ten items and never a message (Requirement 17.3).
DIAGNOSTICS_EVENT_ITEMS_MAX = 10

MANIFEST_SCHEMA_VERSION = 1

UUID_LOWER = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
SHA256_HEX = r"^[0-9a-f]{64}$"

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
# `datetime.fromisoformat` also accepts other shapes, so the shape is fixed first.
_UTC_TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z")


def _whole_number(value: object) -> object:
    """JSON `30.0` is the integer 30 in JavaScript; a fraction stays a float and fails `Strict`."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


# Whole numbers only: rejects 30.5, "30", True and null, like Zod's `z.number().int()`.
WholeInt = Annotated[int, BeforeValidator(_whole_number), Strict()]
PositiveWhole = Annotated[WholeInt, Field(ge=1)]
NonNegativeWhole = Annotated[WholeInt, Field(ge=0)]
Attempts = Annotated[WholeInt, Field(ge=ATTEMPTS_MIN, le=ATTEMPTS_MAX)]

NonEmptyStr = Annotated[str, Strict(), StringConstraints(min_length=1)]
Uuid36 = Annotated[str, Strict(), StringConstraints(pattern=UUID_LOWER)]
Sha256Hex = Annotated[str, Strict(), StringConstraints(pattern=SHA256_HEX)]

VerifierTool = Literal[
    "size", "policy", "eslint", "tsc", "esbuild", "render", "fidelity", "verifier"
]
# The verifier never sends `agent`; it lets the agent's own `AGENT_*` Diagnostics share the type.
DiagnosticTool = Literal[
    "size", "policy", "eslint", "tsc", "esbuild", "render", "fidelity", "verifier", "agent"
]
Severity = Literal["error", "warning"]
Kind = Literal["lesson", "puzzle"]

VisualSpec = VectorsVisual | PlotVisual | DiagramVisual | TableVisual | FormulaVisual


def _contract() -> AnimationContract:
    """The shipped contract, or a `ValueError` that surfaces as a `ValidationError`."""
    loaded = load_contract()
    if not isinstance(loaded, ContractOk):
        raise ValueError("the animation contract is not available")
    return loaded.contract


def contains_lone_surrogate(value: object) -> bool:
    """True if any string in `value`, dict keys included, holds a lone surrogate.

    In a Python `str` every code point from U+D800 to U+DFFF is lone, because `json.loads` already
    joins valid `\\ud83d\\ude00` pairs. It is iterative so a deeply nested body cannot hit the
    recursion limit.
    """
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            if _LONE_SURROGATE.search(item):
                return True
        elif isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list | tuple):
            pending.extend(item)
    return False


def _check_units(value: str, *, label: str, minimum: int, maximum: int) -> str:
    length = utf16_length(value)
    if length < minimum:
        raise ValueError(f"{label} must be at least {minimum} character(s)")
    if length > maximum:
        raise ValueError(f"{label} must be at most {maximum} characters")
    return value


def _check_each(items: list[str], *, label: str, maximum: int) -> list[str]:
    for item in items:
        _check_units(item, label=label, minimum=1, maximum=maximum)
    return items


def _parse_visual(raw: object) -> object:
    """Run the visual through `parse_lesson_visual`; an invalid spec is a field error."""
    parsed = parse_lesson_visual(raw)
    if isinstance(parsed, VisualInvalid):
        raise ValueError("visual is not a valid lesson visual")
    return parsed.visual


class CreateAnimationRequest(ZodModel):
    """Body of `POST /api/v1/ai/animations` (Requirement 15.2, 15.12, 15.13).

    `forbidden_tokens` may only be set for a `puzzle`; a missing list is `[]`, so a request without
    it hashes like one that sends `[]` (Requirement 15.13).
    """

    kind: Kind
    title: Annotated[str, Strict()]
    text: Annotated[str, Strict()]
    concepts: list[Annotated[str, Strict()]] = Field(default_factory=list, max_length=CONCEPTS_MAX)
    visual: Annotated[VisualSpec, BeforeValidator(_parse_visual)]
    language: Literal["en", "id"]
    forbidden_tokens: list[Annotated[str, Strict()]] = Field(
        default_factory=list, max_length=FORBIDDEN_TOKENS_MAX
    )

    @model_validator(mode="before")
    @classmethod
    def _no_lone_surrogate(cls, data: Any) -> Any:
        if contains_lone_surrogate(data):
            raise ValueError("strings must not contain a lone surrogate")
        return data

    @field_validator("title")
    @classmethod
    def _title_in_bounds(cls, value: str) -> str:
        trimmed = js_trim(value)
        return _check_units(trimmed, label="title", minimum=1, maximum=TITLE_MAX_UNITS)

    @field_validator("text")
    @classmethod
    def _text_in_bounds(cls, value: str) -> str:
        return _check_units(value, label="text", minimum=1, maximum=TEXT_MAX_UNITS)

    @field_validator("concepts")
    @classmethod
    def _concepts_in_bounds(cls, items: list[str]) -> list[str]:
        return _check_each(items, label="concept", maximum=CONCEPT_MAX_UNITS)

    @field_validator("forbidden_tokens")
    @classmethod
    def _forbidden_tokens_in_bounds(cls, items: list[str]) -> list[str]:
        return _check_each(items, label="forbidden token", maximum=FORBIDDEN_TOKEN_MAX_UNITS)

    @model_validator(mode="after")
    def _forbidden_only_for_puzzle(self) -> CreateAnimationRequest:
        if self.kind == "lesson" and self.forbidden_tokens:
            raise ValueError("forbidden_tokens is only allowed for a puzzle")
        return self


def _canon(value: Any) -> Any:
    """A copy of a JSON value in which a float with a whole value becomes an `int`.

    `2.0` becomes `2` and `-0.0` becomes `0`, so a request that sends `2.0` and one that sends `2`
    share a hash (JavaScript has one number type, and the browser may send either). A `bool` is
    left alone: `True` is not `1`, and Python's `bool` is not a `float` so it never reaches the
    conversion. A float with a fraction stays as it is. NaN and infinity cannot occur here because
    the visual validators reject them. The input is not changed.
    """
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: _canon(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_canon(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    """The canonical JSON text of `value` that the Request_Hash is computed over (design 10.5).

    Keys are sorted at every depth, separators are `,` and `:` without spaces, and non-ASCII text
    is written as is. There is no Unicode normalization, so U+00E9 and `e` + U+0301 differ.
    """
    return json.dumps(_canon(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_hash(req: CreateAnimationRequest, contract_version: int) -> str:
    """The Request_Hash: SHA-256 as lower-case hex of the canonical JSON of the request.

    It covers `contract_version`, `kind`, `title` (already trimmed by the model), `text`,
    `concepts` in the order sent, the visual as `visual.dump()`, `language`, and
    `forbidden_tokens` sorted by code point without duplicates. A missing `concepts` or
    `forbidden_tokens` is `[]` in the model, so it hashes like an empty list (Requirement 18.1).
    The request is not changed.
    """
    body = {
        "contract_version": contract_version,
        "kind": req.kind,
        "title": req.title,
        "text": req.text,
        "concepts": list(req.concepts),
        "visual": req.visual.dump(),
        "language": req.language,
        "forbidden_tokens": sorted(set(req.forbidden_tokens)),
    }
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def _canvas_value(name: str, value: int) -> int:
    expected = getattr(_contract().canvas, name)
    if value != expected:
        raise ValueError(f"{name} must be {expected}")
    return value


def _duration_value(value: int) -> int:
    duration = _contract().duration
    if not duration.min <= value <= duration.max:
        raise ValueError(f"duration must be between {duration.min} and {duration.max} frames")
    return value


def _pause_before_last_frame(pause: int | None, duration: int) -> None:
    if pause is not None and pause > duration - 1:
        raise ValueError("pause frame must be at most the duration minus 1")


class AnimationReference(ZodModel):
    """What a story keeps about a published animation (design 10.3, Requirement 22.2).

    Also built for the Reader and the `done` event. Use `dump()`: `pause_at_frame` is left out when
    it is not set (Requirement 21.13).
    """

    animation_id: Uuid36
    source_sha256: Sha256Hex
    bundle_sha256: Sha256Hex
    width: WholeInt
    height: WholeInt
    fps: WholeInt
    duration_in_frames: WholeInt
    pause_at_frame: PositiveWhole | None = None
    contract_version: PositiveWhole

    @field_validator("width", "height", "fps")
    @classmethod
    def _canvas_matches_contract(cls, value: int, info: ValidationInfo) -> int:
        return _canvas_value(str(info.field_name), value)

    @field_validator("duration_in_frames")
    @classmethod
    def _duration_matches_contract(cls, value: int) -> int:
        return _duration_value(value)

    @model_validator(mode="after")
    def _pause_inside_animation(self) -> AnimationReference:
        _pause_before_last_frame(self.pause_at_frame, self.duration_in_frames)
        return self


def _check_code(code: str) -> str:
    """`PREFIX_NAME` with a prefix from the contract; `AGENT` is allowed for the agent's own."""
    contract = _contract()
    if re.fullmatch(diagnostic_code_pattern(contract), code):
        return code
    if re.fullmatch(rf"{re.escape(AGENT_PREFIX)}_[A-Z0-9_]+", code):
        return code
    raise ValueError("code must be PREFIX_NAME with a prefix from the contract")


class Diagnostic(ZodModel):
    """One finding from the verifier, or from the agent when `tool` is `agent` (design 5.2)."""

    tool: DiagnosticTool
    code: Annotated[str, Strict()]
    severity: Severity
    line: PositiveWhole | None = None
    column: PositiveWhole | None = None
    message: Annotated[str, Strict()]

    @field_validator("code")
    @classmethod
    def _code_has_known_prefix(cls, value: str) -> str:
        return _check_code(value)

    @field_validator("message")
    @classmethod
    def _message_fits(cls, value: str) -> str:
        maximum = _contract().limits.diagnostic_message_max_chars
        return _check_units(value, label="message", minimum=0, maximum=maximum)


class MainMeta(ZodModel):
    """`export const meta` of a Main_File. Wire names are camelCase, like the verifier's type."""

    model_config = ConfigDict(populate_by_name=False)

    width: WholeInt
    height: WholeInt
    fps: WholeInt
    duration_in_frames: WholeInt = Field(alias="durationInFrames")
    pause_at_frame: PositiveWhole | None = Field(default=None, alias="pauseAtFrame")

    @field_validator("width", "height", "fps")
    @classmethod
    def _canvas_matches_contract(cls, value: int, info: ValidationInfo) -> int:
        return _canvas_value(str(info.field_name), value)

    @field_validator("duration_in_frames")
    @classmethod
    def _duration_matches_contract(cls, value: int) -> int:
        return _duration_value(value)

    @model_validator(mode="after")
    def _pause_inside_animation(self) -> MainMeta:
        _pause_before_last_frame(self.pause_at_frame, self.duration_in_frames)
        return self


class RuntimeVersion(ZodModel):
    react: NonEmptyStr
    remotion: NonEmptyStr


class CheckSummary(ZodModel):
    """Outcome of one verifier step; `ms` is the only field that varies between runs."""

    name: VerifierTool
    ok: StrictBool
    ms: NonNegativeWhole


class VerifierSummary(ZodModel):
    verifier_version: NonEmptyStr
    contract_version: PositiveWhole
    runtime_version: RuntimeVersion
    checks: list[CheckSummary]
    truncated: StrictBool


def _at_most_diagnostics_max(items: list[Any]) -> list[Any]:
    maximum = _contract().limits.diagnostics_max
    if len(items) > maximum:
        raise ValueError(f"at most {maximum} diagnostics are allowed")
    return items


class VerifierResult(ZodModel):
    """What the verifier Lambda returns (design 5.2).

    `ok` true carries `bundle` and `meta`; `ok` false carries neither (Requirement 6.11).
    """

    ok: StrictBool
    diagnostics: list[Diagnostic]
    bundle: Annotated[str, Strict()] | None = None
    meta: MainMeta | None = None
    summary: VerifierSummary

    @field_validator("diagnostics")
    @classmethod
    def _diagnostics_within_limit(cls, items: list[Diagnostic]) -> list[Diagnostic]:
        return _at_most_diagnostics_max(items)

    @model_validator(mode="after")
    def _shape(self) -> VerifierResult:
        if self.ok and (self.bundle is None or self.meta is None):
            raise ValueError("an ok result must carry bundle and meta")
        if not self.ok and (self.bundle is not None or self.meta is not None):
            raise ValueError("a failed result must not carry bundle or meta")
        return self


class ManifestVerification(ZodModel):
    verifier_version: NonEmptyStr
    checks: list[CheckSummary]
    warnings: list[Diagnostic]

    @field_validator("warnings")
    @classmethod
    def _only_warnings(cls, items: list[Diagnostic]) -> list[Diagnostic]:
        if any(item.severity != "warning" for item in items):
            raise ValueError("warnings must have severity warning")
        return _at_most_diagnostics_max(items)


class AnimationManifest(ZodModel):
    """`manifest.json` next to `main.ts` and `main.js` in S3 (design 10.2, Requirement 19.6)."""

    schema_version: WholeInt
    contract_version: PositiveWhole
    runtime_version: RuntimeVersion
    source_sha256: Sha256Hex
    bundle_sha256: Sha256Hex
    source_bytes: WholeInt
    bundle_bytes: WholeInt
    meta: MainMeta
    verification: ManifestVerification
    skipped_tokens: list[Annotated[str, Strict()]]
    model: NonEmptyStr
    attempts: Attempts
    request_hash: Sha256Hex
    created_at: Annotated[str, Strict()]

    @field_validator("schema_version")
    @classmethod
    def _known_schema(cls, value: int) -> int:
        if value != MANIFEST_SCHEMA_VERSION:
            raise ValueError(f"schema_version must be {MANIFEST_SCHEMA_VERSION}")
        return value

    @field_validator("source_bytes")
    @classmethod
    def _source_fits(cls, value: int) -> int:
        maximum = _contract().limits.source_max_bytes
        if not 1 <= value <= maximum:
            raise ValueError(f"source_bytes must be between 1 and {maximum}")
        return value

    @field_validator("bundle_bytes")
    @classmethod
    def _bundle_fits(cls, value: int) -> int:
        maximum = _contract().limits.bundle_max_bytes
        if not 1 <= value <= maximum:
            raise ValueError(f"bundle_bytes must be between 1 and {maximum}")
        return value

    @field_validator("created_at")
    @classmethod
    def _utc_timestamp(cls, value: str) -> str:
        if _UTC_TIMESTAMP.fullmatch(value) is None:
            raise ValueError("created_at must be a UTC ISO 8601 time ending in Z")
        try:
            datetime.fromisoformat(value)
        except ValueError:
            raise ValueError("created_at must be a real date and time") from None
        return value


@dataclass(frozen=True)
class AnimationRow:
    """One row of the `animations` table (design 10.1), read back as plain values."""

    id: str
    owner_id: uuid.UUID
    request_hash: str
    source_sha256: str
    bundle_sha256: str
    s3_prefix: str
    kind: Kind
    meta: dict[str, Any]
    attempts: int
    model: str
    verifier_version: str
    contract_version: int
    runtime_version: dict[str, str]
    source_bytes: int
    bundle_bytes: int
    created_at: int


def reference_from_row(row: AnimationRow) -> AnimationReference:
    """The `Animation_Reference` of a registry row, built from its columns (Requirement 18.7).

    One function for every place that answers from a row: the agent after `register`, the
    Idempotent_Hit and the Reader. `meta` keeps the wire names of `MainMeta` (`durationInFrames`,
    `pauseAtFrame`), so `pause_at_frame` is passed only when the row has one and is otherwise
    absent from the dump, never `null`. A row that breaks the contract raises `ValidationError`.
    """
    raw: dict[str, Any] = {
        "animation_id": row.id,
        "source_sha256": row.source_sha256,
        "bundle_sha256": row.bundle_sha256,
        "width": row.meta.get("width"),
        "height": row.meta.get("height"),
        "fps": row.meta.get("fps"),
        "duration_in_frames": row.meta.get("durationInFrames"),
        "contract_version": row.contract_version,
    }
    if "pauseAtFrame" in row.meta:
        raw["pause_at_frame"] = row.meta["pauseAtFrame"]
    return AnimationReference.model_validate(raw)


# Closed set of codes an `error` event may carry (Requirement 13.11).
ErrorCode = Literal[
    "ANIMATION_VERIFICATION_FAILED",
    "ANIMATION_TIMEOUT",
    "ANIMATION_VERIFIER_UNAVAILABLE",
    "ANIMATION_STORAGE_FAILED",
    "ANIMATION_QUOTA_EXCEEDED",
    "PROVIDER_UNAVAILABLE",
    "RATE_LIMITED",
    "UNKNOWN",
]
ERROR_CODES: tuple[str, ...] = get_args(ErrorCode)


class StartedEvent(ZodModel):
    """First event of every stream (design 10.4)."""

    event_name: ClassVar[str] = "started"

    max_attempts: Attempts
    deadline_ms: PositiveWhole
    cached: StrictBool


class StageEvent(ZodModel):
    event_name: ClassVar[str] = "stage"

    stage: Literal["generating", "verifying", "repairing", "publishing"]
    attempt: Attempts


class DiagnosticItem(ZodModel):
    """A Diagnostic in a `diagnostics` event: tool, code and line only, never the message."""

    tool: DiagnosticTool
    code: Annotated[str, Strict()]
    line: PositiveWhole | None = None

    @field_validator("code")
    @classmethod
    def _code_has_known_prefix(cls, value: str) -> str:
        return _check_code(value)


class DiagnosticsEvent(ZodModel):
    event_name: ClassVar[str] = "diagnostics"

    attempt: Attempts
    ok: StrictBool
    error_count: NonNegativeWhole
    warning_count: NonNegativeWhole
    items: list[DiagnosticItem] = Field(max_length=DIAGNOSTICS_EVENT_ITEMS_MAX)


class DoneEvent(ZodModel):
    """Final event on success. `attempts` is the recorded value, not 0 for a cache hit."""

    event_name: ClassVar[str] = "done"

    animation: AnimationReference
    cached: StrictBool
    attempts: Attempts


class ErrorEvent(ZodModel):
    """Final event on failure. `message` is a fixed sentence per code, with no internal detail."""

    event_name: ClassVar[str] = "error"

    code: ErrorCode
    message: NonEmptyStr
    attempts: NonNegativeWhole


SseEvent = StartedEvent | StageEvent | DiagnosticsEvent | DoneEvent | ErrorEvent
