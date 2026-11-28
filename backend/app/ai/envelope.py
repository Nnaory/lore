"""Response envelope and HTTP status mapping shared by every AI endpoint.

Why: the three AI routes (analyze-material, plan-campaign, generate-story) answer with the same
envelope the Next.js routes use, `{ok: true, data}` or `{ok: false, error: {code, message,
detail?}}`, and map codes to statuses the same way. Services return `AiOk | AiError` instead of
raising; only `to_response` turns them into HTTP. Optional keys (`detail`) are omitted, never
null, because the Zod schemas in the frontend use `.optional()` without `.nullable()`.

Status map (same as the Next.js routes): INVALID_REQUEST 400; semantic errors 422
(MATERIAL_ANALYSIS_FAILED, the planner's DUPLICATE_* and PREREQUISITE_* codes, and the story ones
STORY_NOT_IN_CAMPAIGN, MATERIAL_MISMATCH, CONCEPT_COVERAGE, REQUIRED_KNOWLEDGE_SELF_REFERENCE and
REQUIRED_KNOWLEDGE_UNTESTABLE, plus the animation ANIMATION_QUOTA_EXCEEDED and
ANIMATION_VERIFICATION_FAILED); VALIDATION_FAILED and OUTPUT_PARSE_FAILED 502;
PROVIDER_UNAVAILABLE, PROVIDER_NOT_CONFIGURED, RATE_LIMITED (from Gemini), TIMEOUT and the
animation ANIMATION_NOT_CONFIGURED, ANIMATION_TIMEOUT, ANIMATION_VERIFIER_UNAVAILABLE and
ANIMATION_STORAGE_FAILED 503; anything else 500. Limits of this API itself use AiError.status
(413, 429) to override the map.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from fastapi.responses import JSONResponse

NO_STORE = {"Cache-Control": "no-store"}

NOT_CONFIGURED_MESSAGE = (
    "No AI model is configured on this server (set AI_PROVIDER=google and GOOGLE_API_KEY)."
)
INTERNAL_ERROR_MESSAGE = "Internal server error"

_BAD_GATEWAY = frozenset({"VALIDATION_FAILED", "OUTPUT_PARSE_FAILED"})
_UNAVAILABLE = frozenset(
    {
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_NOT_CONFIGURED",
        "RATE_LIMITED",
        "TIMEOUT",
        # Lesson animations: server not set up, deadline hit, checker or storage down.
        "ANIMATION_NOT_CONFIGURED",
        "ANIMATION_TIMEOUT",
        "ANIMATION_VERIFIER_UNAVAILABLE",
        "ANIMATION_STORAGE_FAILED",
    }
)
# Semantic failures of one layer; each layer adds its own code (story, campaign) here.
# Campaign Planner: unusable planning input (the engine's checks), as in plan-campaign/route.ts.
_UNPROCESSABLE = frozenset(
    {
        "MATERIAL_ANALYSIS_FAILED",
        "DUPLICATE_MATERIAL_ID",
        "DUPLICATE_CONCEPT_ID",
        "INVALID_PREREQUISITE_REF",
        "PREREQUISITE_CYCLE",
        "REQUIRED_KNOWLEDGE_ORDER",
        # Story Generator: unusable generation input, as in generate-story/route.ts.
        "STORY_NOT_IN_CAMPAIGN",
        "MATERIAL_MISMATCH",
        "CONCEPT_COVERAGE",
        "REQUIRED_KNOWLEDGE_SELF_REFERENCE",
        "REQUIRED_KNOWLEDGE_UNTESTABLE",
        # Mid-story Q&A: invalid scene pointer or asking while a puzzle/ending is active.
        "SCENE_NOT_IN_STORY",
        "ASK_NOT_ALLOWED_IN_SCENE",
        # Lesson animations: the policy refused (per-owner quota) or the code never verified.
        "ANIMATION_QUOTA_EXCEEDED",
        "ANIMATION_VERIFICATION_FAILED",
    }
)


@dataclass(frozen=True)
class AiOk:
    """Successful result; `data` becomes `{ok: true, data}`."""

    data: dict[str, Any]
    ok: bool = True


@dataclass(frozen=True)
class AiError:
    """Failed result. `status` overrides the code-based mapping; `headers` are added as is."""

    code: str
    message: str
    detail: Any = None
    status: int | None = None
    headers: Mapping[str, str] = field(default_factory=dict)
    ok: bool = False


AiResult = AiOk | AiError


def status_for_code(code: str) -> int:
    """HTTP status for an error code, matching the Next.js routes."""
    if code == "INVALID_REQUEST":
        return 400
    if code in _BAD_GATEWAY:
        return 502
    if code in _UNAVAILABLE:
        return 503
    if code in _UNPROCESSABLE:
        return 422
    return 500


def warning(code: str, message: str, path: str) -> dict[str, str]:
    """One non-blocking validation warning for `meta.warnings`."""
    return {"code": code, "message": message, "path": path}


def to_response(result: AiResult) -> JSONResponse:
    """Build the JSON response for a service result."""
    if isinstance(result, AiOk):
        return JSONResponse({"ok": True, "data": result.data}, 200, headers=NO_STORE)
    error: dict[str, Any] = {"code": result.code, "message": result.message}
    if result.detail is not None:
        error["detail"] = result.detail
    status = result.status if result.status is not None else status_for_code(result.code)
    return JSONResponse(
        {"ok": False, "error": error}, status, headers={**NO_STORE, **result.headers}
    )


def unknown_error() -> AiError:
    """The 500 answer; never carries internal details."""
    return AiError("UNKNOWN", INTERNAL_ERROR_MESSAGE)
