"""Abuse and cost limits for the public AI endpoints.

Why: each AI call can hold a connection for up to 5 minutes and spends Gemini quota, while the
API runs as one process on a t3.micro. In-memory limits are enough for one process (same
reasoning as `app.ratelimit`). Per-IP is the main guard because cookies are client-controlled;
the client IP is `app.projects.client_ip` (uvicorn resolves X-Forwarded-For from Caddy).
Everything is non-blocking: a refused request gets HTTP 429 with `Retry-After`, nothing queues.

Environment variables (positive integers; invalid or missing values use the default):

- AI_RATE_PER_MINUTE_IP (default 12): AI requests per IP in a sliding 60 s window.
- AI_RATE_PER_MINUTE_OWNER (default 12): same, per `lore_device` cookie owner.
- AI_DAILY_PER_IP (default 200): Gemini-bound requests per IP per UTC day.
- AI_MAX_CONCURRENT_PER_IP (default 2): AI requests running at once per IP.
- AI_MAX_CONCURRENT_GLOBAL (default 8): AI requests running at once in this process.

Per-minute checks run on every AI request (invalid ones included). The daily quota and the
concurrency slot are only taken once the request is valid and about to call Gemini, so bad
requests do not burn budget. The limiter lives in `app.state.ai_limiter`; tests replace it with
one built on fake clocks. It is safe on the event loop and in threads (a lock guards the dicts).
"""

from __future__ import annotations

import math
import os
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from app.ai.envelope import AiError

# Raw JSON body caps per endpoint. 80,000 characters of material can reach 6 bytes per
# character when JSON escapes it (\uXXXX), so 512 KiB covers the worst legal request.
ANALYZE_MATERIAL_BODY_BYTES = 512 * 1024

# plan-campaign receives full MaterialBlueprints. One blueprint is bounded by Gemini's 6,000
# output tokens (about 24 KB of text, at most about 72 KB at 3 bytes per character) and the UI
# sends one material per campaign. 1 MiB leaves room for roughly ten such blueprints plus options
# and stays far below Caddy's 5 MB limit.
PLAN_CAMPAIGN_BODY_BYTES = 1024 * 1024

# generate-story receives ONE campaign, ONE story entry (a copy of one campaign entry), ONE
# material and the summaries of the stories played so far. Measured on a deliberately heavy
# request (`_worst_realistic_request` in tests/test_ai_generate_story.py), in UTF-8 with
# non-Latin text at 3 bytes per character:
#   material         77 KB: 30 concepts of 2.4 KB (analyze-material is capped at 6,000 output
#                    tokens, about 72 KB at most, so this is above what it can produce)
#   campaign         5.5 KB with 5 stories (about 1 KB per story; the UI plans one per material)
#   story entry      0.9 KB
#   summaries        7.4 KB for 10 of them (about 0.7 KB each)
#   options          0.5 KB (custom instructions are capped at 500 characters in the UI)
# Total 92 KB; the two committed fixtures are 3 to 4 KB. 512 KiB is about 5.7 times the heavy
# case, the same cap as analyze-material (the only other single-material endpoint), and far
# below Caddy's 5 MB limit. A tighter cap would only save memory on a request that is rejected
# anyway; a looser one would not fit more legitimate data.
GENERATE_STORY_BODY_BYTES = 512 * 1024

# POST /api/v1/ai/animations receives one lesson or puzzle: title (200 characters), text (2,000),
# up to 5 concepts, one `visual` and up to 8 forbidden tokens. The heaviest legal request (a
# `plot` with 3 series of 60 points, 2,000 characters of non-Latin text) is under 16 KB, so
# 64 KiB (65,536 bytes) leaves about four times that and stays far below Caddy's 5 MB limit.
ANIMATION_BODY_BYTES = 64 * 1024

# POST /api/v1/ai/ask receives the learner's question plus full MaterialBlueprint[], StoryBlueprint,
# CampaignBlueprint and conversation context (capped at 512 KiB, matching generate-story).
ASK_QUESTION_BODY_BYTES = 512 * 1024

WINDOW_SECONDS = 60
SECONDS_PER_DAY = 86_400
CONCURRENCY_RETRY_AFTER = 5  # seconds; a running call usually finishes within tens of seconds
_SWEEP_EVERY = 500


@dataclass(frozen=True)
class AiLimits:
    """Limit values. Defaults are conservative for a t3.micro."""

    per_minute_ip: int = 12
    per_minute_owner: int = 12
    daily_per_ip: int = 200
    max_concurrent_per_ip: int = 2
    max_concurrent_global: int = 8


def _positive_int(raw: str | None, fallback: int) -> int:
    try:
        value = int(raw) if raw is not None else fallback
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def ai_limits_from_env(env: Mapping[str, str] | None = None) -> AiLimits:
    """Read the limits from the environment."""
    source = os.environ if env is None else env
    d = AiLimits()
    return AiLimits(
        per_minute_ip=_positive_int(source.get("AI_RATE_PER_MINUTE_IP"), d.per_minute_ip),
        per_minute_owner=_positive_int(source.get("AI_RATE_PER_MINUTE_OWNER"), d.per_minute_owner),
        daily_per_ip=_positive_int(source.get("AI_DAILY_PER_IP"), d.daily_per_ip),
        max_concurrent_per_ip=_positive_int(
            source.get("AI_MAX_CONCURRENT_PER_IP"), d.max_concurrent_per_ip
        ),
        max_concurrent_global=_positive_int(
            source.get("AI_MAX_CONCURRENT_GLOBAL"), d.max_concurrent_global
        ),
    )


@dataclass(frozen=True)
class Denied:
    """A refused request: which limit, and how long to wait (whole seconds, at least 1)."""

    scope: str  # "ip" | "owner" | "daily" | "concurrency-ip" | "concurrency-global"
    retry_after: int


_MESSAGES = {
    "ip": "Too many AI requests. Wait a moment, then try again.",
    "owner": "Too many AI requests. Wait a moment, then try again.",
    "daily": "The daily AI request limit for this connection has been reached. Try again tomorrow.",
    "concurrency-ip": "You already have AI requests running. Wait for one to finish.",
    "concurrency-global": "The AI service is busy right now. Try again in a moment.",
}


def denied_to_error(denied: Denied) -> AiError:
    """HTTP 429 answer with a `Retry-After` header."""
    return AiError(
        "RATE_LIMITED",
        _MESSAGES[denied.scope],
        {"scope": denied.scope, "retryAfterSeconds": denied.retry_after},
        status=429,
        headers={"Retry-After": str(denied.retry_after)},
    )


class AiLimiter:
    """Sliding-window, daily and concurrency limits for AI endpoints."""

    def __init__(
        self,
        limits: AiLimits | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.limits = limits or ai_limits_from_env()
        self._mono = monotonic  # injectable for tests
        self._wall = wall  # injectable for tests (UTC calendar day)
        self._lock = threading.Lock()
        self._ip: dict[str, deque[float]] = {}
        self._owner: dict[str, deque[float]] = {}
        self._daily: dict[str, tuple[int, int]] = {}  # ip -> (utc_day, count)
        self._running_ip: dict[str, int] = {}
        self._running = 0
        self._calls = 0

    # --- per-minute -------------------------------------------------------------------------

    def _window(self, buckets: dict[str, deque[float]], key: str, now: float) -> deque[float]:
        window = buckets.setdefault(key, deque())
        while window and now - window[0] >= WINDOW_SECONDS:
            window.popleft()
        return window

    @staticmethod
    def _wait(window: deque[float], now: float) -> int:
        return max(1, math.ceil(window[0] + WINDOW_SECONDS - now))

    def check_rate(self, ip: str, owner: str) -> Denied | None:
        """Record one request against the IP and owner windows, or refuse without recording."""
        with self._lock:
            now = self._mono()
            self._maybe_sweep(now)
            ip_window = self._window(self._ip, ip, now)
            owner_window = self._window(self._owner, owner, now)
            if len(ip_window) >= self.limits.per_minute_ip:
                return Denied("ip", self._wait(ip_window, now))
            if len(owner_window) >= self.limits.per_minute_owner:
                return Denied("owner", self._wait(owner_window, now))
            ip_window.append(now)
            owner_window.append(now)
            return None

    # --- daily ------------------------------------------------------------------------------

    def check_daily(self, ip: str) -> Denied | None:
        """Count one Gemini-bound request for today (UTC), or refuse."""
        with self._lock:
            wall = self._wall()
            today = int(wall // SECONDS_PER_DAY)
            day, count = self._daily.get(ip, (today, 0))
            if day != today:
                day, count = today, 0
            if count >= self.limits.daily_per_ip:
                until_midnight = (today + 1) * SECONDS_PER_DAY - wall
                return Denied("daily", max(1, math.ceil(until_midnight)))
            self._daily[ip] = (day, count + 1)
            return None

    # --- concurrency ------------------------------------------------------------------------

    def try_acquire(self, ip: str) -> Denied | None:
        """Take a concurrency slot, or refuse. Pair every success with `release`."""
        with self._lock:
            if self._running >= self.limits.max_concurrent_global:
                return Denied("concurrency-global", CONCURRENCY_RETRY_AFTER)
            if self._running_ip.get(ip, 0) >= self.limits.max_concurrent_per_ip:
                return Denied("concurrency-ip", CONCURRENCY_RETRY_AFTER)
            self._running += 1
            self._running_ip[ip] = self._running_ip.get(ip, 0) + 1
            return None

    def release(self, ip: str) -> None:
        """Give back a slot taken by `try_acquire`."""
        with self._lock:
            self._running = max(0, self._running - 1)
            left = self._running_ip.get(ip, 0) - 1
            if left > 0:
                self._running_ip[ip] = left
            else:
                self._running_ip.pop(ip, None)

    def in_flight(self) -> int:
        """Requests currently holding a slot (used by tests and diagnostics)."""
        with self._lock:
            return self._running

    # --- housekeeping -----------------------------------------------------------------------

    def _maybe_sweep(self, now: float) -> None:
        """Drop idle keys now and then so memory stays bounded. Caller holds the lock."""
        self._calls += 1
        if self._calls % _SWEEP_EVERY:
            return
        for buckets in (self._ip, self._owner):
            for key in list(buckets):
                window = self._window(buckets, key, now)
                if not window:
                    del buckets[key]
        today = int(self._wall() // SECONDS_PER_DAY)
        for ip in [k for k, (day, _) in self._daily.items() if day != today]:
            del self._daily[ip]
