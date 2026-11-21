"""Endpoint tests for /api/v1/projects against PostgreSQL (single owner).

Why: covers the data shape each endpoint returns and stores. Cross-owner behaviour lives in
test_projects_ownership.py; size limits and caps in test_projects_limits.py.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import pytest
from conftest import insert_project, make_client
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text

BASE = "/api/v1/projects"
OWNER = uuid.UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")

pytestmark = pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return make_client(app, OWNER)


def _count(engine: Engine, table: str) -> int:
    with engine.connect() as conn:
        return conn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()


# ---------------------------------------------------------------- list, get, delete (T7)


def test_list_is_sorted_by_updated_at_descending(engine: Engine, client: TestClient) -> None:
    insert_project(engine, "p_old", OWNER, updated_at=1000)
    insert_project(engine, "p_new", OWNER, updated_at=3000)
    insert_project(engine, "p_mid", OWNER, updated_at=2000)
    response = client.get(BASE)
    assert response.status_code == 200
    assert [p["id"] for p in response.json()] == ["p_new", "p_mid", "p_old"]


def test_list_returns_summary_fields_only(engine: Engine, client: TestClient) -> None:
    insert_project(engine, "p1", OWNER, title="T", stories={"s1": {}, "s2": {}})
    assert client.get(BASE).json() == [
        {
            "id": "p1",
            "title": "T",
            "genre": "fantasy",
            "source_name": "a.pdf",
            "updated_at": 1000,
            "stories_total": 2,
            "stories_completed": 0,
        }
    ]


def test_list_query_never_reads_blueprints(engine: Engine, client: TestClient) -> None:
    insert_project(engine, "p1", OWNER, stories={"s1": {"big": "x"}})
    statements: list[str] = []

    def capture(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        assert client.get(BASE).status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert statements, "the list endpoint ran no SQL"
    for statement in statements:
        assert "campaign" not in statement
        assert "blueprint" not in statement
        assert "project_state" not in statement


def test_get_assembles_stories_and_returns_state_as_stored(
    engine: Engine, client: TestClient
) -> None:
    # The state is deliberately not a valid CampaignState: the server must not judge it.
    state = {"completed_stories": ["s1"], "unexpected": {"nested": [1, "ä"]}}
    stories = {"s1": {"story_id": "s1", "title": "Ein Märchen"}, "s2": {"story_id": "s2"}}
    insert_project(engine, "p1", OWNER, stories=stories, state=state, updated_at=4242)
    response = client.get(f"{BASE}/p1")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "p1"
    assert body["created_at"] == body["updated_at"] == 4242
    assert body["stories"] == stories
    assert body["campaign_state"] == state
    assert body["source"] == {"file_name": "a.pdf", "file_type": "pdf"}
    assert body["materials"] is None


def test_get_without_state_returns_null_state(engine: Engine, client: TestClient) -> None:
    insert_project(engine, "p1", OWNER)
    body = client.get(f"{BASE}/p1").json()
    assert body["campaign_state"] is None
    assert body["stories"] == {}


def test_delete_returns_204_and_cascades(engine: Engine, client: TestClient) -> None:
    insert_project(engine, "p1", OWNER, stories={"s1": {}}, state={"completed_stories": []})
    insert_project(engine, "p2", OWNER, stories={"s1": {}})
    response = client.delete(f"{BASE}/p1")
    assert response.status_code == 204
    assert response.content == b""
    assert client.get(f"{BASE}/p1").status_code == 404
    assert _count(engine, "project_stories") == 1
    assert _count(engine, "project_state") == 0
    assert client.delete(f"{BASE}/p1").status_code == 404
