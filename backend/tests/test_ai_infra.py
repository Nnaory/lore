"""Tests for the AI envelope, status mapping, hash port and limiter (no HTTP, no Gemini)."""

from __future__ import annotations

import json

import pytest

from app.ai.envelope import AiError, AiOk, status_for_code, to_response
from app.ai.hash import stable_hash
from app.ai.limits import (
    CONCURRENCY_RETRY_AFTER,
    AiLimiter,
    AiLimits,
    ai_limits_from_env,
    denied_to_error,
)
from tests.ai_support import FakeClock


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("INVALID_REQUEST", 400),
        ("MATERIAL_ANALYSIS_FAILED", 422),
        ("VALIDATION_FAILED", 502),
        ("OUTPUT_PARSE_FAILED", 502),
        ("PROVIDER_UNAVAILABLE", 503),
        ("PROVIDER_NOT_CONFIGURED", 503),
        ("RATE_LIMITED", 503),
        ("TIMEOUT", 503),
        ("UNKNOWN", 500),
        ("SOMETHING_ELSE", 500),
    ],
)
def test_status_mapping_matches_the_nextjs_routes(code: str, status: int) -> None:
    assert status_for_code(code) == status


def test_success_and_error_envelopes_omit_absent_detail() -> None:
    ok = to_response(AiOk({"blueprint": {}}))
    assert ok.status_code == 200
    assert json.loads(ok.body) == {"ok": True, "data": {"blueprint": {}}}
    err = to_response(AiError("TIMEOUT", "slow"))
    assert err.status_code == 503
    assert json.loads(err.body) == {"ok": False, "error": {"code": "TIMEOUT", "message": "slow"}}
    with_detail = to_response(AiError("TIMEOUT", "slow", detail=[]))
    assert json.loads(with_detail.body)["error"]["detail"] == []


def test_explicit_status_and_headers_override_the_map() -> None:
    response = to_response(AiError("RATE_LIMITED", "x", status=429, headers={"Retry-After": "7"}))
    assert response.status_code == 429
    assert response.headers["retry-after"] == "7"
    assert response.headers["cache-control"] == "no-store"


# Reference values computed with the TypeScript stableHash in frontend/src/lib/contracts/hash.ts.
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", "ztntfp"),
        ("hello", "m3bicr"),
        ("Linear algebra é😀 ‖v‖", "1xgvqc8"),
        ("Vectors have magnitude and direction.", "1fmda5"),
    ],
)
def test_stable_hash_matches_typescript(text: str, expected: str) -> None:
    assert stable_hash(text) == expected


# --- limiter ----------------------------------------------------------------------------------


def make_limiter(**limits: int) -> tuple[AiLimiter, FakeClock]:
    clock = FakeClock()
    return AiLimiter(AiLimits(**limits), monotonic=clock, wall=clock), clock


def test_defaults_are_conservative() -> None:
    assert AiLimits() == AiLimits(12, 12, 200, 2, 8)


def test_env_overrides_and_falls_back_on_bad_values() -> None:
    limits = ai_limits_from_env(
        {
            "AI_RATE_PER_MINUTE_IP": "5",
            "AI_RATE_PER_MINUTE_OWNER": "abc",
            "AI_DAILY_PER_IP": "0",
            "AI_MAX_CONCURRENT_PER_IP": "-3",
            "AI_MAX_CONCURRENT_GLOBAL": "20",
        }
    )
    assert limits == AiLimits(5, 12, 200, 2, 20)
    assert ai_limits_from_env({}) == AiLimits()


def test_ip_window_slides_and_reports_retry_after() -> None:
    limiter, clock = make_limiter(per_minute_ip=2, per_minute_owner=100)
    assert limiter.check_rate("1.1.1.1", "o") is None
    clock.now += 10
    assert limiter.check_rate("1.1.1.1", "o") is None
    denied = limiter.check_rate("1.1.1.1", "o")
    assert denied is not None
    assert denied.scope == "ip"
    assert denied.retry_after == 50  # the first request leaves the window in 50 s
    clock.now += 50
    assert limiter.check_rate("1.1.1.1", "o") is None  # first one expired
    assert limiter.check_rate("2.2.2.2", "o") is None  # other IPs are independent


def test_owner_window_is_separate_from_ip_window() -> None:
    limiter, _ = make_limiter(per_minute_ip=100, per_minute_owner=1)
    assert limiter.check_rate("1.1.1.1", "owner-a") is None
    denied = limiter.check_rate("2.2.2.2", "owner-a")
    assert denied is not None
    assert denied.scope == "owner"
    assert limiter.check_rate("2.2.2.2", "owner-b") is None


def test_refused_request_is_not_recorded() -> None:
    limiter, clock = make_limiter(per_minute_ip=1, per_minute_owner=100)
    assert limiter.check_rate("ip", "o") is None
    for _ in range(5):
        assert limiter.check_rate("ip", "o") is not None
    clock.now += 60
    assert limiter.check_rate("ip", "o") is None  # hammering did not extend the window


def test_daily_quota_resets_at_utc_midnight_with_exact_retry_after() -> None:
    limiter, clock = make_limiter(daily_per_ip=2)
    clock.now = 86_400 * 100 + 86_400 - 90  # 90 s before midnight UTC
    assert limiter.check_daily("ip") is None
    assert limiter.check_daily("ip") is None
    denied = limiter.check_daily("ip")
    assert denied is not None
    assert (denied.scope, denied.retry_after) == ("daily", 90)
    assert limiter.check_daily("other") is None
    clock.now += 90
    assert limiter.check_daily("ip") is None


def test_concurrency_per_ip_and_global_and_release() -> None:
    limiter, _ = make_limiter(max_concurrent_per_ip=2, max_concurrent_global=3)
    assert limiter.try_acquire("a") is None
    assert limiter.try_acquire("a") is None
    denied = limiter.try_acquire("a")
    assert denied is not None
    assert (denied.scope, denied.retry_after) == ("concurrency-ip", CONCURRENCY_RETRY_AFTER)
    assert limiter.try_acquire("b") is None
    denied = limiter.try_acquire("c")
    assert denied is not None
    assert denied.scope == "concurrency-global"
    assert limiter.in_flight() == 3
    limiter.release("a")
    assert limiter.try_acquire("c") is None
    for ip in ("a", "b", "c"):
        limiter.release(ip)
    assert limiter.in_flight() == 0
    limiter.release("a")  # extra release never goes negative
    assert limiter.in_flight() == 0


def test_denied_error_is_429_with_integer_retry_after() -> None:
    limiter, _ = make_limiter(per_minute_ip=1)
    limiter.check_rate("ip", "o")
    denied = limiter.check_rate("ip", "o")
    assert denied is not None
    error = denied_to_error(denied)
    assert error.status == 429
    assert error.code == "RATE_LIMITED"
    assert int(error.headers["Retry-After"]) >= 1
    assert error.detail == {"scope": "ip", "retryAfterSeconds": denied.retry_after}


def test_sweep_drops_idle_keys() -> None:
    limiter, clock = make_limiter(per_minute_ip=100, per_minute_owner=100, daily_per_ip=100)
    for i in range(499):
        limiter.check_rate(f"ip{i}", f"o{i}")
    clock.now += 120
    limiter.check_rate("fresh", "fresh")  # 500th call triggers the sweep
    assert set(limiter._ip) == {"fresh"}
    assert set(limiter._owner) == {"fresh"}
