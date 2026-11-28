"""Tests for the six animation error codes in the shared AI envelope (no HTTP, no Gemini).

Why: the animation endpoint answers pre-stream failures with the same `{ok: false, error}`
envelope as the other AI routes, so its codes must map to the statuses fixed by the spec
(Requirement 16.6): quota and verification failures are 422, configuration, timeout, verifier and
storage failures are 503. The mapping the older codes already had must not move.
"""

from __future__ import annotations

import json

import pytest

from app.ai.envelope import AiError, status_for_code, to_response

UNPROCESSABLE_CODES = ("ANIMATION_QUOTA_EXCEEDED", "ANIMATION_VERIFICATION_FAILED")
UNAVAILABLE_CODES = (
    "ANIMATION_NOT_CONFIGURED",
    "ANIMATION_TIMEOUT",
    "ANIMATION_VERIFIER_UNAVAILABLE",
    "ANIMATION_STORAGE_FAILED",
)


@pytest.mark.parametrize("code", UNPROCESSABLE_CODES)
def test_quota_and_verification_failures_are_422(code: str) -> None:
    assert status_for_code(code) == 422


@pytest.mark.parametrize("code", UNAVAILABLE_CODES)
def test_configuration_timeout_verifier_and_storage_failures_are_503(code: str) -> None:
    assert status_for_code(code) == 503


@pytest.mark.parametrize("code", UNPROCESSABLE_CODES + UNAVAILABLE_CODES)
def test_to_response_uses_the_mapped_status_and_never_caches(code: str) -> None:
    response = to_response(AiError(code, "fixed message"))
    assert response.status_code == status_for_code(code)
    assert response.status_code in {422, 503}
    assert response.headers["cache-control"] == "no-store"
    assert json.loads(response.body) == {
        "ok": False,
        "error": {"code": code, "message": "fixed message"},
    }


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("INVALID_REQUEST", 400),
        ("MATERIAL_ANALYSIS_FAILED", 422),
        ("CONCEPT_COVERAGE", 422),
        ("VALIDATION_FAILED", 502),
        ("OUTPUT_PARSE_FAILED", 502),
        ("PROVIDER_UNAVAILABLE", 503),
        ("PROVIDER_NOT_CONFIGURED", 503),
        ("RATE_LIMITED", 503),
        ("TIMEOUT", 503),
        ("UNKNOWN", 500),
        ("ANIMATION_SOMETHING_ELSE", 500),
    ],
)
def test_existing_mapping_is_unchanged(code: str, status: int) -> None:
    assert status_for_code(code) == status
