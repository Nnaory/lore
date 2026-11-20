"""Behaviour tests for the in-memory rate limiter (clocks injected, no sleeping).

Why: the first draft of the limiter deleted a fresh key and returned before recording, so no
window could ever fill. These tests pin the real behaviour: windows, independence of buckets,
memory pruning, the UTC daily quota and thread safety.
"""

from __future__ import annotations

import threading

from app.ratelimit import RateLimiter


class Clock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


def make(mono: Clock | None = None, wall: Clock | None = None) -> tuple[RateLimiter, Clock, Clock]:
    mono = mono or Clock()
    wall = wall or Clock(86400.0 * 20000)
    return RateLimiter(monotonic=mono, wall=wall), mono, wall


def test_ip_limit_120_per_minute_then_window_frees_up() -> None:
    limiter, mono, _ = make()
    assert all(limiter.check_ip("1.1.1.1") for _ in range(120))
    assert limiter.check_ip("1.1.1.1") is False
    mono.now += 60
    assert limiter.check_ip("1.1.1.1") is True


def test_first_call_on_fresh_key_records_a_timestamp() -> None:
    limiter, _, _ = make()
    assert limiter.check_ip("2.2.2.2", limit=1) is True
    assert limiter.check_ip("2.2.2.2", limit=1) is False


def test_buckets_are_independent() -> None:
    limiter, _, _ = make()
    assert all(limiter.check_import("3.3.3.3") for _ in range(5))
    assert limiter.check_import("3.3.3.3") is False
    assert limiter.check_ip("3.3.3.3") is True
    assert all(limiter.check_owner_write("owner") for _ in range(60))
    assert limiter.check_owner_write("owner") is False
    assert limiter.check_ip("3.3.3.3") is True
    assert limiter.check_owner_write("other") is True


def test_sweep_shrinks_dicts_after_window_passes() -> None:
    limiter, mono, _ = make()
    for i in range(300):
        limiter.check_ip(f"10.0.0.{i}")
    assert limiter.key_count() == 300
    mono.now += 61
    for _ in range(RateLimiter.SWEEP_EVERY):
        limiter.check_ip("keep")
    assert limiter.key_count() < 10


def test_sweep_runs_when_key_count_exceeds_cap() -> None:
    limiter, mono, _ = make()
    for i in range(RateLimiter.SWEEP_KEYS):
        limiter.check_ip(f"k{i}")
    mono.now += 61
    # One call past the cap must trigger an immediate sweep, long before SWEEP_EVERY calls.
    limiter.check_ip("trigger")
    assert limiter.key_count() == 1


def test_daily_quota_resets_at_utc_midnight_and_sweep_drops_old_days() -> None:
    limiter, _, wall = make()
    assert all(limiter.check_daily_create("4.4.4.4") for _ in range(100))
    assert limiter.check_daily_create("4.4.4.4") is False
    wall.now += 86400
    assert limiter.check_daily_create("4.4.4.4") is True

    limiter2, mono2, wall2 = make()
    for i in range(50):
        limiter2.check_daily_create(f"ip{i}")
    wall2.now += 86400
    mono2.now += 61
    for _ in range(RateLimiter.SWEEP_EVERY):
        limiter2.check_ip("x")
    assert limiter2.key_count() < 5


def test_threads_never_admit_more_than_the_limit() -> None:
    limiter, _, _ = make()
    admitted: list[bool] = []
    lock = threading.Lock()

    def worker() -> None:
        for _ in range(50):
            ok = limiter.check_ip("5.5.5.5", limit=100)
            with lock:
                admitted.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(admitted) == 100
