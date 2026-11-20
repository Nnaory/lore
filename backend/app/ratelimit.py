"""In-memory sliding-window rate limiter for the projects API.

Why: the API is public and runs as one process on a small instance, so a per-process limiter
is enough (no Redis). Per-IP is the primary guard because cookies are client-controlled.
Idle keys are pruned by a periodic sweep, not on the request path, to bound memory.
A threading.Lock guards the dicts because sync endpoints run in a threadpool.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable

SECONDS_PER_DAY = 86400


class RateLimiter:
    WINDOW = 60  # seconds, sliding window for the per-minute buckets
    SWEEP_EVERY = 500  # run a sweep every N calls ...
    SWEEP_KEYS = 5000  # ... or when the total key count exceeds this

    def __init__(
        self,
        monotonic: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self._mono = monotonic  # injectable for tests
        self._wall = wall  # injectable for tests (UTC calendar day)
        self._lock = threading.Lock()
        self._ip: dict[str, deque[float]] = {}
        self._owner: dict[str, deque[float]] = {}
        self._import: dict[str, deque[float]] = {}
        self._daily_create: dict[str, tuple[int, int]] = {}  # ip -> (utc_day, count)
        self._calls = 0

    def _check_and_record(self, buckets: dict[str, deque[float]], key: str, limit: int) -> bool:
        now = self._mono()
        with self._lock:
            self._maybe_sweep(now)
            window = buckets.setdefault(key, deque())
            while window and now - window[0] >= self.WINDOW:
                window.popleft()
            if len(window) >= limit:
                return False
            window.append(now)
            return True

    def check_ip(self, ip: str, limit: int = 120) -> bool:
        return self._check_and_record(self._ip, ip, limit)

    def check_owner_write(self, owner_id: str, limit: int = 60) -> bool:
        return self._check_and_record(self._owner, owner_id, limit)

    def check_import(self, ip: str, limit: int = 5) -> bool:
        return self._check_and_record(self._import, ip, limit)

    def check_daily_create(self, ip: str, limit: int = 100) -> bool:
        today = int(self._wall() // SECONDS_PER_DAY)
        with self._lock:
            self._maybe_sweep(self._mono())
            day, count = self._daily_create.get(ip, (today, 0))
            if day != today:
                day, count = today, 0
            if count >= limit:
                return False
            self._daily_create[ip] = (day, count + 1)
            return True

    def key_count(self) -> int:
        """Total tracked keys across all buckets (used by tests and memory checks)."""
        with self._lock:
            return self._total_keys()

    def _total_keys(self) -> int:
        return len(self._ip) + len(self._owner) + len(self._import) + len(self._daily_create)

    def _maybe_sweep(self, now: float) -> None:
        """Drop expired timestamps and idle keys. Caller must hold the lock."""
        self._calls += 1
        if self._calls % self.SWEEP_EVERY and self._total_keys() <= self.SWEEP_KEYS:
            return
        for buckets in (self._ip, self._owner, self._import):
            for key in list(buckets):
                window = buckets[key]
                while window and now - window[0] >= self.WINDOW:
                    window.popleft()
                if not window:
                    del buckets[key]
        today = int(self._wall() // SECONDS_PER_DAY)
        for ip in [k for k, (day, _) in self._daily_create.items() if day != today]:
            del self._daily_create[ip]
