"""Tests for the animation env parser, the Animation_Limiter and `config_ready`.

Why: the `ANIMATION_*` settings decide how much Gemini and Lambda budget the endpoint can spend,
so every parsing rule of Requirement 16.1 is pinned here, including the inputs that Python's
`int()` would wrongly accept (`+5`, `1_0`, Arabic-Indic digits; design K-1). The limiter runs on
a fake clock (Requirement 16.10) and is checked to be separate from the AI JSON limiter
(Requirement 16.15). No HTTP, no Gemini, no database, no AWS.
"""

from __future__ import annotations

import dataclasses
import subprocess
import sys

import pytest

from app.ai.animation.limits import (
    AnimationEnv,
    AnimationLimits,
    animation_env_from_env,
    animation_limiter_from_env,
    config_ready,
    parse_positive_ascii_int,
)
from app.ai.limits import (
    ANIMATION_BODY_BYTES,
    CONCURRENCY_RETRY_AFTER,
    AiLimiter,
    AiLimits,
    ai_limits_from_env,
    denied_to_error,
)
from tests.ai_support import FakeClock

# Env name -> default value, for the six numeric variables.
DEFAULTS = {
    "ANIMATION_RATE_PER_MINUTE_IP": 4,
    "ANIMATION_DAILY_PER_IP": 30,
    "ANIMATION_MAX_CONCURRENT_PER_IP": 1,
    "ANIMATION_MAX_CONCURRENT_GLOBAL": 2,
    "ANIMATION_MAX_ATTEMPTS": 4,
    "ANIMATION_DEADLINE_MS": 240_000,
}
LIMITER_FIELD = {
    "ANIMATION_RATE_PER_MINUTE_IP": "per_minute_ip",
    "ANIMATION_DAILY_PER_IP": "daily_per_ip",
    "ANIMATION_MAX_CONCURRENT_PER_IP": "max_concurrent_per_ip",
    "ANIMATION_MAX_CONCURRENT_GLOBAL": "max_concurrent_global",
}
ALL_NAMES = list(DEFAULTS)

# Not "a string of ASCII digits worth 1 or more": every one must fall back to the default.
INVALID = [
    "+5",
    "1_0",
    "٤",  # Arabic-Indic digit four
    "٤٠",
    "４",  # full-width digit four
    "0",
    "000",
    "",
    "   ",
    "-3",
    "4.0",
    "1e3",
    "0x10",
    "abc",
    "4 0",
]


def read(name: str, raw: str | None) -> int:
    """The effective value of one numeric env variable, through the public readers."""
    env = {} if raw is None else {name: raw}
    if name in LIMITER_FIELD:
        return getattr(animation_limiter_from_env(env).limits, LIMITER_FIELD[name])
    if name == "ANIMATION_MAX_ATTEMPTS":
        return animation_env_from_env(env).max_attempts
    return animation_env_from_env(env).deadline_ms


# --- defaults and shape -----------------------------------------------------------------------


def test_defaults_without_env() -> None:
    assert animation_env_from_env({}) == AnimationEnv(False, "", "", "", 4, 240_000)
    assert animation_env_from_env({}) == AnimationEnv()
    limiter = animation_limiter_from_env({})
    assert limiter.limits == AiLimits(4, 4, 30, 1, 2)


def test_animation_limits_default_is_200_and_frozen() -> None:
    limits = AnimationLimits()
    assert limits.owner_max_animations == 200
    assert AnimationLimits(owner_max_animations=1).owner_max_animations == 1
    with pytest.raises(dataclasses.FrozenInstanceError):
        limits.owner_max_animations = 5  # type: ignore[misc]


def test_body_limit_is_64_kib() -> None:
    assert ANIMATION_BODY_BYTES == 65536


def test_reads_the_process_environment_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANIMATION_ENABLED", "true")
    monkeypatch.setenv("ANIMATION_BUCKET", "bucket-x")
    monkeypatch.setenv("ANIMATION_MAX_ATTEMPTS", "2")
    monkeypatch.setenv("ANIMATION_RATE_PER_MINUTE_IP", "9")
    env = animation_env_from_env()
    assert (env.enabled, env.bucket, env.max_attempts) == (True, "bucket-x", 2)
    assert animation_limiter_from_env().limits.per_minute_ip == 9


# --- digit parsing (Requirement 16.1, design K-1) ---------------------------------------------


@pytest.mark.parametrize("name", ALL_NAMES)
@pytest.mark.parametrize("raw", INVALID)
def test_invalid_numbers_use_the_default(name: str, raw: str) -> None:
    assert read(name, raw) == DEFAULTS[name]


@pytest.mark.parametrize("name", ALL_NAMES)
def test_missing_variable_uses_the_default(name: str) -> None:
    assert read(name, None) == DEFAULTS[name]


@pytest.mark.parametrize("name", ALL_NAMES)
@pytest.mark.parametrize("raw", [" 4 ", " 3 ", "\t3\n", "\u00a03\u00a0"])
def test_surrounding_whitespace_is_trimmed(name: str, raw: str) -> None:
    assert read(name, raw) == int(raw.strip())


@pytest.mark.parametrize("name", ["ANIMATION_RATE_PER_MINUTE_IP", "ANIMATION_DAILY_PER_IP"])
def test_valid_numbers_are_used_as_given(name: str) -> None:
    assert read(name, "7") == 7
    assert read(name, "007") == 7
    assert read(name, "1") == 1
    assert read(name, "100000") == 100_000


@pytest.mark.parametrize(
    "name", ["ANIMATION_MAX_CONCURRENT_PER_IP", "ANIMATION_MAX_CONCURRENT_GLOBAL"]
)
def test_concurrency_numbers_are_used_as_given(name: str) -> None:
    assert read(name, "5") == 5
    assert read(name, "1") == 1


def test_parser_returns_none_for_invalid_and_never_raises_on_very_long_digit_runs() -> None:
    assert parse_positive_ascii_int(None) is None
    assert parse_positive_ascii_int("0" * 5000) is None
    assert parse_positive_ascii_int("0" * 5000 + "5") == 5
    # More than 4,300 digits would make `int()` raise; the value is saturated instead.
    huge = parse_positive_ascii_int("9" * 5000)
    assert huge is not None and huge >= 10**18
    assert read("ANIMATION_RATE_PER_MINUTE_IP", "9" * 5000) == huge


# --- ANIMATION_MAX_ATTEMPTS (Requirement 13.4) ------------------------------------------------


@pytest.mark.parametrize(("raw", "expected"), [("1", 1), ("2", 2), ("3", 3), ("4", 4)])
def test_max_attempts_one_to_four_is_kept(raw: str, expected: int) -> None:
    assert animation_env_from_env({"ANIMATION_MAX_ATTEMPTS": raw}).max_attempts == expected


@pytest.mark.parametrize("raw", ["5", "6", "99", "100000", "9" * 5000])
def test_max_attempts_above_four_becomes_four(raw: str) -> None:
    assert animation_env_from_env({"ANIMATION_MAX_ATTEMPTS": raw}).max_attempts == 4


# --- ANIMATION_DEADLINE_MS (Requirement 13.5) -------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("1", 1), ("2", 2), ("1000", 1000), ("239999", 239_999), ("240000", 240_000)],
)
def test_deadline_in_range_is_kept(raw: str, expected: int) -> None:
    assert animation_env_from_env({"ANIMATION_DEADLINE_MS": raw}).deadline_ms == expected


@pytest.mark.parametrize("raw", ["240001", "300000", "999999999", "9" * 5000])
def test_deadline_above_the_maximum_is_clamped(raw: str) -> None:
    assert animation_env_from_env({"ANIMATION_DEADLINE_MS": raw}).deadline_ms == 240_000


# --- ANIMATION_ENABLED and the text variables -------------------------------------------------


@pytest.mark.parametrize("raw", ["true", "TRUE", "True", "tRuE", " true ", "\ttrue\n"])
def test_enabled_is_true_only_for_the_word_true_in_any_case(raw: str) -> None:
    assert animation_env_from_env({"ANIMATION_ENABLED": raw}).enabled is True


@pytest.mark.parametrize(
    "raw",
    ["", " ", "false", "FALSE", "1", "yes", "on", "truee", "tru", "t rue", "ｔｒｕｅ", "true,"],
)
def test_enabled_is_false_for_anything_else(raw: str) -> None:
    assert animation_env_from_env({"ANIMATION_ENABLED": raw}).enabled is False


def test_text_variables_are_trimmed_and_blank_means_empty() -> None:
    env = animation_env_from_env(
        {
            "ANIMATION_BUCKET": "  lore-bucket \n",
            "ANIMATION_VERIFIER_FUNCTION": "\tfn-name",
            "AWS_REGION": " ap-southeast-3 ",
        }
    )
    assert (env.bucket, env.verifier_function, env.region) == (
        "lore-bucket",
        "fn-name",
        "ap-southeast-3",
    )
    blank = animation_env_from_env(
        {"ANIMATION_BUCKET": "   ", "ANIMATION_VERIFIER_FUNCTION": "", "AWS_REGION": "\n"}
    )
    assert (blank.bucket, blank.verifier_function, blank.region) == ("", "", "")


# --- config_ready (Requirement 16.4 and 16.12) -------------------------------------------------


def ready_env(**changes: object) -> AnimationEnv:
    base = AnimationEnv(True, "bucket", "function", "ap-southeast-3", 4, 240_000)
    return dataclasses.replace(base, **changes)


def test_config_ready_when_everything_is_present() -> None:
    assert config_ready(ready_env(), engine_ok=True, contract_ok=True) is True


@pytest.mark.parametrize(
    "changes",
    [
        {"enabled": False},
        {"bucket": ""},
        {"verifier_function": ""},
        {"region": ""},
    ],
)
def test_config_ready_needs_flag_bucket_function_and_region(changes: dict[str, object]) -> None:
    assert config_ready(ready_env(**changes), engine_ok=True, contract_ok=True) is False


def test_config_ready_needs_an_engine_and_a_valid_contract() -> None:
    assert config_ready(ready_env(), engine_ok=False, contract_ok=True) is False
    assert config_ready(ready_env(), engine_ok=True, contract_ok=False) is False
    assert config_ready(ready_env(), engine_ok=False, contract_ok=False) is False
    assert config_ready(AnimationEnv(), engine_ok=True, contract_ok=True) is False


def test_config_ready_from_a_real_env_mapping() -> None:
    env = animation_env_from_env(
        {
            "ANIMATION_ENABLED": "TRUE",
            "ANIMATION_BUCKET": "b",
            "ANIMATION_VERIFIER_FUNCTION": "f",
            "AWS_REGION": "r",
        }
    )
    assert config_ready(env, engine_ok=True, contract_ok=True) is True


# --- the limiter on a fake clock (Requirement 16.10, 16.13) -----------------------------------


def make(env: dict[str, str]) -> tuple[AiLimiter, FakeClock]:
    clock = FakeClock()
    return animation_limiter_from_env(env, monotonic=clock, wall=clock), clock


def test_owner_window_equals_the_ip_window() -> None:
    limiter, _ = make({"ANIMATION_RATE_PER_MINUTE_IP": "7"})
    assert limiter.limits.per_minute_owner == limiter.limits.per_minute_ip == 7


def test_ip_window_slides_on_the_injected_clock() -> None:
    limiter, clock = make({"ANIMATION_RATE_PER_MINUTE_IP": "2"})
    assert limiter.check_rate("1.1.1.1", "o1") is None
    clock.now += 10
    assert limiter.check_rate("1.1.1.1", "o2") is None
    clock.now += 10
    denied = limiter.check_rate("1.1.1.1", "o3")
    assert denied is not None
    assert denied.scope == "ip"
    assert denied.retry_after == 40  # the first request leaves the window 40 s from now
    clock.now += 40
    assert limiter.check_rate("1.1.1.1", "o4") is None


def test_owner_window_refuses_when_the_same_owner_uses_several_ips() -> None:
    limiter, _ = make({"ANIMATION_RATE_PER_MINUTE_IP": "2"})
    assert limiter.check_rate("1.1.1.1", "owner") is None
    assert limiter.check_rate("2.2.2.2", "owner") is None
    denied = limiter.check_rate("3.3.3.3", "owner")
    assert denied is not None
    assert denied.scope == "owner"
    assert denied.retry_after >= 1


def test_daily_quota_resets_at_utc_midnight_on_the_injected_wall_clock() -> None:
    limiter, clock = make({"ANIMATION_DAILY_PER_IP": "2"})
    clock.now = 86_400 * 100 + 86_400 - 90  # 90 s before midnight UTC
    assert limiter.check_daily("ip") is None
    assert limiter.check_daily("ip") is None
    denied = limiter.check_daily("ip")
    assert denied is not None
    assert (denied.scope, denied.retry_after) == ("daily", 90)
    clock.now += 91
    assert limiter.check_daily("ip") is None


def test_default_concurrency_is_one_per_ip_and_two_global() -> None:
    limiter, _ = make({})
    assert limiter.try_acquire("a") is None
    second_same_ip = limiter.try_acquire("a")
    assert second_same_ip is not None
    assert second_same_ip.scope == "concurrency-ip"
    assert second_same_ip.retry_after == CONCURRENCY_RETRY_AFTER == 5
    assert limiter.try_acquire("b") is None
    global_full = limiter.try_acquire("c")
    assert global_full is not None
    assert global_full.scope == "concurrency-global"
    assert global_full.retry_after == 5
    assert limiter.in_flight() == 2
    limiter.release("a")
    limiter.release("b")
    assert limiter.in_flight() == 0
    assert limiter.try_acquire("c") is None


def test_denials_become_429_with_scope_and_retry_after() -> None:
    limiter, _ = make({"ANIMATION_RATE_PER_MINUTE_IP": "1"})
    limiter.check_rate("ip", "o")
    denied = limiter.check_rate("ip", "o")
    assert denied is not None
    error = denied_to_error(denied)
    assert error.status == 429
    assert error.code == "RATE_LIMITED"
    assert error.detail == {"scope": "ip", "retryAfterSeconds": denied.retry_after}
    assert error.headers == {"Retry-After": str(denied.retry_after)}


# --- separation from the AI JSON limiter (Requirement 16.15, 15.14) ---------------------------


def test_animation_limiter_shares_no_counters_with_the_ai_limiter() -> None:
    clock = FakeClock()
    ai = AiLimiter(AiLimits(), monotonic=clock, wall=clock)
    animation = animation_limiter_from_env({}, monotonic=clock, wall=clock)
    assert animation is not ai

    # Fill the animation per-minute window (default 4); the AI limiter (default 12) is untouched.
    for _ in range(4):
        assert animation.check_rate("ip", "owner") is None
    assert animation.check_rate("ip", "owner") is not None
    assert ai.check_rate("ip", "owner") is None

    # A slot and a daily count on one limiter do not show on the other.
    assert animation.try_acquire("ip") is None
    assert animation.check_daily("ip") is None
    assert (animation.in_flight(), ai.in_flight()) == (1, 0)
    assert ai.try_acquire("ip") is None
    assert ai.try_acquire("ip") is None  # the AI default allows 2 per IP, animation only 1
    assert (animation.in_flight(), ai.in_flight()) == (1, 2)


def test_each_call_builds_a_new_limiter() -> None:
    assert animation_limiter_from_env({}) is not animation_limiter_from_env({})


def test_ai_and_animation_env_do_not_leak_into_each_other() -> None:
    ai_env = {"AI_RATE_PER_MINUTE_IP": "99", "AI_MAX_CONCURRENT_GLOBAL": "50"}
    animation_env = {"ANIMATION_RATE_PER_MINUTE_IP": "3", "ANIMATION_DAILY_PER_IP": "9"}
    assert animation_limiter_from_env(ai_env).limits == AiLimits(4, 4, 30, 1, 2)
    assert ai_limits_from_env(animation_env) == AiLimits()


# --- import hygiene (Requirement 41.1) --------------------------------------------------------


def test_module_does_not_load_langgraph_or_boto3() -> None:
    code = (
        "import sys; import app.ai.animation.limits; "
        "bad = [m for m in ('langgraph', 'boto3', 'botocore') if m in sys.modules]; "
        "raise SystemExit(1 if bad else 0)"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
