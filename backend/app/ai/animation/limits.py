"""Environment settings and rate limiter for the animation endpoint.

Why: animation generation can hold a connection for up to 4 minutes and spends Gemini and Lambda
budget, so it gets its own limits, separate from the JSON AI endpoints (design D-12, Requirement
16.15). `animation_limiter_from_env` builds a second `AiLimiter` with `ANIMATION_*` values; it
shares no counters with `app.state.ai_limiter`. `AiLimiter` and `AiLimits` are reused as they are
(Requirement 39.3): only the env parsing is new.

Env parsing does not reuse `app.ai.limits._positive_int`. That function calls `int()`, which
accepts `+5`, `1_0` and non-ASCII digits (Arabic-Indic, full-width), while Requirement 16.1 only
accepts a string of ASCII digits worth 1 or more after trimming (design K-1, DK-1). Here the
check is `re.fullmatch(r"[0-9]+", raw.strip())`. The pattern of `limits.py` is kept: a frozen
dataclass of limits and a default for every missing or invalid value.

Variables (defaults in brackets):

- ANIMATION_RATE_PER_MINUTE_IP [4]: requests per IP in a sliding 60 s window. The per-owner
  window uses the same number (A-11).
- ANIMATION_DAILY_PER_IP [30], ANIMATION_MAX_CONCURRENT_PER_IP [1], ANIMATION_MAX_CONCURRENT_GLOBAL
  [2]: same meaning as their `AI_*` twins.
- ANIMATION_MAX_ATTEMPTS [4]: Gemini calls per run; 1 to 4 as given, above 4 becomes 4.
- ANIMATION_DEADLINE_MS [240000]: total run time, clamped to 1 to 240000.
- ANIMATION_ENABLED [false]: true only for the text `true`, in any letter case.
- ANIMATION_BUCKET, ANIMATION_VERIFIER_FUNCTION, AWS_REGION: non-empty text after trimming.

Names and defaults match `animation_ssm_params` in `infra/animation.tf`. Nothing here raises.
This module must not import `langgraph` or `boto3` (Requirement 41.1).
"""

from __future__ import annotations

import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from app.ai.limits import AiLimiter, AiLimits

DEFAULT_RATE_PER_MINUTE_IP = 4
DEFAULT_DAILY_PER_IP = 30
DEFAULT_MAX_CONCURRENT_PER_IP = 1
DEFAULT_MAX_CONCURRENT_GLOBAL = 2

# The attempt cap is also the default: one `generate` and up to three `repair` (Requirement 13.4).
MAX_ATTEMPTS_CAP = 4
DEADLINE_MS_CAP = 240_000

_ASCII_DIGITS = re.compile(r"[0-9]+")

# `int()` refuses strings of more than 4,300 digits, so a longer run of digits would raise. Any
# value this large is "unlimited" in practice, so it is saturated instead of rejected.
_MAX_DIGITS = 18
_SATURATED = 10**_MAX_DIGITS


def parse_positive_ascii_int(raw: str | None) -> int | None:
    """Return `raw` as an integer of 1 or more, or None when it is not valid.

    Valid means ASCII digits only after trimming, with a value of at least 1. Signs, `_`
    separators, decimals, non-ASCII digits and empty text are all invalid. Leading zeros are
    allowed (`"007"` is 7). A value above 10**18 is returned as 10**18.
    """
    if raw is None:
        return None
    text = raw.strip()
    if _ASCII_DIGITS.fullmatch(text) is None:
        return None
    digits = text.lstrip("0")
    if not digits:
        return None
    if len(digits) > _MAX_DIGITS:
        return _SATURATED
    return int(digits)


def _positive_or(source: Mapping[str, str], name: str, default: int) -> int:
    value = parse_positive_ascii_int(source.get(name))
    return default if value is None else value


def _capped_or(source: Mapping[str, str], name: str, default: int) -> int:
    """Like `_positive_or`, but a value above `default` becomes `default` (default is the cap)."""
    return min(_positive_or(source, name, default), default)


def _text(source: Mapping[str, str], name: str) -> str:
    return (source.get(name) or "").strip()


def _is_true(raw: str | None) -> bool:
    """True only for the text `true` in any letter case (surrounding spaces are ignored)."""
    if raw is None:
        return False
    text = raw.strip()
    # `isascii` keeps look-alike characters (full-width letters) from ever matching.
    return text.isascii() and text.lower() == "true"


@dataclass(frozen=True)
class AnimationEnv:
    """Animation settings read from the environment (the limiter values are not part of it)."""

    enabled: bool = False
    bucket: str = ""
    verifier_function: str = ""
    region: str = ""
    max_attempts: int = MAX_ATTEMPTS_CAP
    deadline_ms: int = DEADLINE_MS_CAP


def animation_env_from_env(env: Mapping[str, str] | None = None) -> AnimationEnv:
    """Read the animation settings from `env` (default: the process environment)."""
    source = os.environ if env is None else env
    return AnimationEnv(
        enabled=_is_true(source.get("ANIMATION_ENABLED")),
        bucket=_text(source, "ANIMATION_BUCKET"),
        verifier_function=_text(source, "ANIMATION_VERIFIER_FUNCTION"),
        region=_text(source, "AWS_REGION"),
        max_attempts=_capped_or(source, "ANIMATION_MAX_ATTEMPTS", MAX_ATTEMPTS_CAP),
        deadline_ms=_capped_or(source, "ANIMATION_DEADLINE_MS", DEADLINE_MS_CAP),
    )


def animation_limiter_from_env(
    env: Mapping[str, str] | None = None,
    *,
    monotonic: Callable[[], float] = time.monotonic,
    wall: Callable[[], float] = time.time,
) -> AiLimiter:
    """Build the Animation_Limiter: a new `AiLimiter` that shares nothing with the AI JSON one.

    The per-owner window equals the per-IP window. `monotonic` and `wall` are injectable so
    tests can drive both windows and the UTC day with a fake clock (Requirement 16.10).
    """
    source = os.environ if env is None else env
    per_minute = _positive_or(source, "ANIMATION_RATE_PER_MINUTE_IP", DEFAULT_RATE_PER_MINUTE_IP)
    limits = AiLimits(
        per_minute_ip=per_minute,
        per_minute_owner=per_minute,
        daily_per_ip=_positive_or(source, "ANIMATION_DAILY_PER_IP", DEFAULT_DAILY_PER_IP),
        max_concurrent_per_ip=_positive_or(
            source, "ANIMATION_MAX_CONCURRENT_PER_IP", DEFAULT_MAX_CONCURRENT_PER_IP
        ),
        max_concurrent_global=_positive_or(
            source, "ANIMATION_MAX_CONCURRENT_GLOBAL", DEFAULT_MAX_CONCURRENT_GLOBAL
        ),
    )
    return AiLimiter(limits, monotonic=monotonic, wall=wall)


@dataclass(frozen=True)
class AnimationLimits:
    """Per-owner animation cap (Requirement 39.10).

    Lives in `app.state.animation_limits`, apart from the project `Limits` in `app.projects`.
    It has no env variable; tests replace it to use a small number.
    """

    owner_max_animations: int = 200


def config_ready(env: AnimationEnv, engine_ok: bool, contract_ok: bool) -> bool:
    """True when the animation endpoint can run (Requirement 16.4 and 16.12).

    Needs the feature flag on, a bucket, a verifier function and a region, a database engine
    and a valid animation contract. The reader endpoint does not look at the verifier function
    (Requirement 21.12), so it uses `reader_config_ready` instead.
    """
    return bool(
        env.enabled
        and env.bucket
        and env.verifier_function
        and env.region
        and engine_ok
        and contract_ok
    )


def reader_config_ready(env: AnimationEnv, engine_ok: bool) -> bool:
    """True when the Animation_Reader can answer (Requirement 21.5 and 21.12).

    The reader only reads a row and signs two URLs, so it needs the flag, a bucket, a region and a
    database engine. It deliberately ignores `ANIMATION_VERIFIER_FUNCTION`: an animation that is
    already stored stays readable while the verifier is being replaced or is not configured.
    """
    return bool(env.enabled and env.bucket and env.region and engine_ok)
