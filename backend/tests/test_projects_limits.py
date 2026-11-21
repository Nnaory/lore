"""Request size limits, storage caps and the daily creation quota, end to end through the router.

Why: the API is public and runs on a small instance with a 20 GB database. These limits are the
only guard against one client exhausting memory or storage, so each one is checked through real
requests, including chunked bodies that carry no Content-Length.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from conftest import fixture_payload, insert_project, make_client
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from app.projects import DEFAULT_LIMITS, Limits
from app.ratelimit import RateLimiter

BASE = "/api/v1/projects"
OWNER = uuid.UUID("dddddddd-dddd-4ddd-8ddd-dddddddddddd")

pytestmark = pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return make_client(app, OWNER)


def _payload(project_id: str) -> dict[str, Any]:
    body = fixture_payload()
    body["id"] = project_id
    return body


def _chunks(size: int, chunk: int = 64 * 1024) -> Iterator[bytes]:
    sent = 0
    while sent < size:
        part = min(chunk, size - sent)
        sent += part
        yield b" " * part


def _count(engine: Engine) -> int:
    with engine.connect() as conn:
        return conn.execute(text("SELECT count(*) FROM projects")).scalar_one()


# ---------------------------------------------------------------- body size limits

ENDPOINTS = [
    ("POST", BASE, DEFAULT_LIMITS.create_body_bytes),
    ("PUT", f"{BASE}/any/state", DEFAULT_LIMITS.state_body_bytes),
    ("POST", f"{BASE}/import", DEFAULT_LIMITS.import_body_bytes),
]


def test_default_limits_match_the_spec() -> None:
    assert DEFAULT_LIMITS.create_body_bytes == 2_000_000
    assert DEFAULT_LIMITS.state_body_bytes == 500_000
    assert DEFAULT_LIMITS.import_body_bytes == 5_000_000


@pytest.mark.parametrize(("method", "path", "limit"), ENDPOINTS)
def test_oversized_body_with_content_length_is_413(
    engine: Engine, client: TestClient, method: str, path: str, limit: int
) -> None:
    response = client.request(
        method, path, content=b" " * (limit + 1), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert _count(engine) == 0


@pytest.mark.parametrize(("method", "path", "limit"), ENDPOINTS)
def test_oversized_chunked_body_without_content_length_is_413(
    engine: Engine, client: TestClient, method: str, path: str, limit: int
) -> None:
    request = client.build_request(
        method, path, content=_chunks(limit + 1), headers={"Content-Type": "application/json"}
    )
    assert "content-length" not in request.headers
    assert request.headers["transfer-encoding"] == "chunked"
    response = client.send(request)
    assert response.status_code == 413
    assert _count(engine) == 0


def test_body_exactly_at_the_limit_is_accepted(app: FastAPI, client: TestClient) -> None:
    body = json.dumps(_payload("p_exact")).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    app.state.limits = Limits(create_body_bytes=len(body))
    assert client.post(BASE, content=body, headers=headers).status_code == 201

    over = json.dumps(_payload("p_overx")).encode("utf-8")  # same id length as "p_exact"
    assert len(over) == len(body)
    app.state.limits = Limits(create_body_bytes=len(body) - 1)
    assert client.post(BASE, content=over, headers=headers).status_code == 413


# ---------------------------------------------------------------- storage caps


def test_the_101st_project_for_one_owner_is_422(engine: Engine, client: TestClient) -> None:
    for i in range(100):
        insert_project(engine, f"p_{i}", OWNER)
    response = client.post(BASE, json=_payload("p_new"))
    assert response.status_code == 422
    assert "project limit" in response.json()["detail"]
    assert _count(engine) == 100


def test_an_owner_at_the_cap_can_still_replace_its_own_project(
    engine: Engine, client: TestClient
) -> None:
    for i in range(99):
        insert_project(engine, f"p_{i}", OWNER)
    assert client.post(BASE, json=_payload("p_mine")).status_code == 201
    newer = _payload("p_mine")
    newer["updated_at"] += 1
    assert client.post(BASE, json=newer).status_code == 200


def test_per_owner_size_cap_is_422(app: FastAPI, engine: Engine, client: TestClient) -> None:
    assert client.post(BASE, json=_payload("p_small")).status_code == 201
    with engine.connect() as conn:
        stored = conn.execute(
            text(
                "SELECT octet_length(campaign::text) + coalesce(octet_length(materials::text), 0)"
                " + (SELECT coalesce(sum(octet_length(blueprint::text)), 0) FROM project_stories)"
                " FROM projects"
            )
        ).scalar_one()
    # Room for the first project, not for a second copy of it.
    app.state.limits = Limits(owner_max_bytes=stored + stored // 2)
    response = client.post(BASE, json=_payload("p_second"))
    assert response.status_code == 422
    assert "storage limit" in response.json()["detail"]
    assert _count(engine) == 1


def test_global_cap_is_422(app: FastAPI, engine: Engine, client: TestClient) -> None:
    app.state.limits = Limits(global_max_projects=3)
    for i in range(3):
        insert_project(engine, f"other_{i}", uuid.UUID(int=i + 1))
    response = client.post(BASE, json=_payload("p_new"))
    assert response.status_code == 422
    assert "server project limit" in response.json()["detail"]


def test_import_rejects_items_over_the_cap_and_processes_the_rest(
    app: FastAPI, engine: Engine, client: TestClient
) -> None:
    app.state.limits = Limits(owner_max_projects=2)
    assert client.post(BASE, json=_payload("p_1")).status_code == 201
    newer_own = _payload("p_1")
    newer_own["updated_at"] += 1
    batch = {"projects": [_payload("p_2"), _payload("p_3"), newer_own, _payload("p_4")]}
    response = client.post(f"{BASE}/import", json=batch)
    assert response.status_code == 200
    body = response.json()
    assert (body["imported"], body["skipped"]) == (2, 0)  # p_2 and the newer p_1
    assert [(r["index"], r["id"]) for r in body["rejected"]] == [(1, "p_3"), (3, "p_4")]
    assert all("project limit" in r["error"] for r in body["rejected"])
    assert {p["id"] for p in client.get(BASE).json()} == {"p_1", "p_2"}


# ---------------------------------------------------------------- daily creation quota


class Clock:
    def __init__(self, start: float) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


def test_daily_creation_quota_is_enforced_through_the_router(app: FastAPI) -> None:
    mono = Clock(1000.0)
    wall = Clock(86400.0 * 20000 + 3600)  # 01:00 UTC on some day
    app.state.rate_limiter = RateLimiter(monotonic=mono, wall=wall)
    first = make_client(app, OWNER)
    for i in range(100):
        if i and i % 50 == 0:
            mono.now += 61  # stay under the 60/min owner-write and 120/min per-IP limits
        assert first.post(BASE, json=_payload(f"p_{i}")).status_code == 201, i

    mono.now += 61
    refused = make_client(app, uuid.uuid4()).post(BASE, json=_payload("p_101"))
    assert refused.status_code == 429  # same IP, new cookie: the quota is per IP
    assert refused.headers["retry-after"] == "60"

    wall.now += 86400  # next UTC day
    after_midnight = make_client(app, uuid.uuid4()).post(BASE, json=_payload("p_101"))
    assert after_midnight.status_code == 201
