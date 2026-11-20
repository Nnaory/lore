"""Wiring tests for the projects router: 503 without a DB, limit order, 429 + Retry-After.

Why: these rules are cross-cutting and must hold before any endpoint has real logic.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app

ROUTES = [
    ("GET", "/api/v1/projects"),
    ("POST", "/api/v1/projects"),
    ("POST", "/api/v1/projects/import"),
    ("GET", "/api/v1/projects/abc"),
    ("DELETE", "/api/v1/projects/abc"),
    ("PUT", "/api/v1/projects/abc/state"),
]


class FakeLimiter:
    """Records the order of checks and refuses the named ones."""

    def __init__(self, refuse: set[str] | None = None) -> None:
        self.calls: list[str] = []
        self.refuse = refuse or set()

    def _check(self, name: str) -> bool:
        self.calls.append(name)
        return name not in self.refuse

    def check_ip(self, ip: str) -> bool:
        return self._check("ip")

    def check_owner_write(self, owner: str) -> bool:
        return self._check("owner")

    def check_import(self, ip: str) -> bool:
        return self._check("import")

    def check_daily_create(self, ip: str) -> bool:
        return self._check("daily")


def _client(limiter: FakeLimiter | None = None) -> TestClient:
    app = create_app(None)
    if limiter is not None:
        app.state.rate_limiter = limiter
    return TestClient(app)


def test_every_route_returns_503_without_database() -> None:
    client = _client()
    for method, path in ROUTES:
        response = client.request(method, path, json={})
        assert response.status_code == 503, (method, path)


def test_create_checks_ip_then_owner_then_daily() -> None:
    limiter = FakeLimiter()
    _client(limiter).post("/api/v1/projects", json={})
    assert limiter.calls == ["ip", "owner", "daily"]


def test_import_checks_ip_then_import_only() -> None:
    limiter = FakeLimiter()
    _client(limiter).post("/api/v1/projects/import", json={})
    assert limiter.calls == ["ip", "import"]


def test_reads_check_ip_only_and_writes_check_ip_then_owner() -> None:
    limiter = FakeLimiter()
    client = _client(limiter)
    client.get("/api/v1/projects")
    assert limiter.calls == ["ip"]
    limiter.calls.clear()
    client.delete("/api/v1/projects/abc")
    assert limiter.calls == ["ip", "owner"]


def test_refused_ip_limit_returns_429_with_retry_after_and_stops_later_checks() -> None:
    limiter = FakeLimiter(refuse={"ip"})
    response = _client(limiter).post("/api/v1/projects", json={})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"
    assert limiter.calls == ["ip"]
    assert "lore_device" in response.headers["set-cookie"]


def test_refused_daily_quota_returns_429() -> None:
    limiter = FakeLimiter(refuse={"daily"})
    response = _client(limiter).post("/api/v1/projects", json={})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


def test_existing_health_routes_are_unaffected() -> None:
    client = _client()
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/health").status_code == 200
    assert "set-cookie" not in client.get("/api/v1/health").headers
