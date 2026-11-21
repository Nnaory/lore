"""Owner isolation tests: two device cookies (A and B) must never see or touch each other's data.

Why: the device token is the only access control in R13. Cross-owner access must look exactly
like "not found" (404), ownership must be checked before any write, and id collisions on create
or import must not overwrite or reveal another owner's project.

Written before the endpoints (tests first). Each test is marked xfail(strict=True) with the task
that implements its endpoint; that task removes the marker in its test commit. strict=True makes
an unexpected pass fail the gate, so a marker cannot be forgotten.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any

import pytest
from conftest import fixture_payload, make_client
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

BASE = "/api/v1/projects"

OWNER_A = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
OWNER_B = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
A_ID = "p_owner_a"
A_TITLE = "Secret campaign of A"
A_UPDATED = 2000
A_STATE_UPDATED = 2000

pytestmark = pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")


def pending(task: str) -> pytest.MarkDecorator:
    return pytest.mark.xfail(strict=True, reason=f"endpoint implemented in {task}")


@pytest.fixture
def client_a(app: FastAPI) -> TestClient:
    return make_client(app, OWNER_A)


@pytest.fixture
def client_b(app: FastAPI) -> TestClient:
    return make_client(app, OWNER_B)


def payload(project_id: str, updated_at: int = 5000) -> dict[str, Any]:
    body = fixture_payload()
    body["id"] = project_id
    body["created_at"] = updated_at
    body["updated_at"] = updated_at
    body["campaign_state"]["completed_stories"] = []
    return body


def seed(engine: Engine, project_id: str, owner: uuid.UUID | None, title: str = A_TITLE) -> None:
    """Insert a project, one story and a state row directly, bypassing the API."""
    campaign = {"title": title, "genre": "fantasy", "story_sequence": [{"story_id": "s1"}]}
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO projects (id, owner_id, created_at, updated_at, source, campaign, "
                "title, genre, source_name, stories_total, stories_completed) VALUES "
                "(:id, :owner, 1000, :updated, CAST(:source AS jsonb), CAST(:campaign AS jsonb), "
                ":title, 'fantasy', 'a.pdf', 1, 1)"
            ),
            {
                "id": project_id,
                "owner": owner,
                "updated": A_UPDATED,
                "source": json.dumps({"file_name": "a.pdf", "file_type": "pdf"}),
                "campaign": json.dumps(campaign),
                "title": title,
            },
        )
        conn.execute(
            text("INSERT INTO project_stories VALUES (:id, 's1', CAST(:bp AS jsonb))"),
            {"id": project_id, "bp": json.dumps({"story_id": "s1", "title": "Story A"})},
        )
        conn.execute(
            text("INSERT INTO project_state VALUES (:id, CAST(:st AS jsonb), :updated)"),
            {
                "id": project_id,
                "st": json.dumps({"completed_stories": ["s1"], "marker": "A"}),
                "updated": A_STATE_UPDATED,
            },
        )


def snapshot(engine: Engine, project_id: str) -> dict[str, Any]:
    """Everything stored for one project, to prove a request changed nothing."""
    with engine.connect() as conn:
        project = (
            conn.execute(text("SELECT * FROM projects WHERE id = :id"), {"id": project_id})
            .mappings()
            .one_or_none()
        )
        stories = conn.execute(
            text("SELECT story_id, blueprint FROM project_stories WHERE project_id = :id"),
            {"id": project_id},
        ).all()
        state = conn.execute(
            text("SELECT campaign_state, updated_at FROM project_state WHERE project_id = :id"),
            {"id": project_id},
        ).one_or_none()
    return {
        "project": dict(project) if project else None,
        "stories": sorted((s[0], json.dumps(s[1], sort_keys=True)) for s in stories),
        "state": tuple(state) if state else None,
    }


# ---------------------------------------------------------------- list / get / delete (T7)


def test_list_returns_only_the_callers_projects(
    engine: Engine, client_a: TestClient, client_b: TestClient
) -> None:
    seed(engine, A_ID, OWNER_A)
    seed(engine, "p_owner_b", OWNER_B, title="B's campaign")
    a = client_a.get(BASE)
    b = client_b.get(BASE)
    assert a.status_code == 200
    assert b.status_code == 200
    assert [p["id"] for p in a.json()] == [A_ID]
    assert [p["id"] for p in b.json()] == ["p_owner_b"]


def test_get_foreign_id_is_indistinguishable_from_missing(
    engine: Engine, client_b: TestClient
) -> None:
    seed(engine, A_ID, OWNER_A)
    foreign = client_b.get(f"{BASE}/{A_ID}")
    missing = client_b.get(f"{BASE}/does_not_exist")
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert A_TITLE not in foreign.text


def test_delete_foreign_id_returns_404_and_keeps_the_project(
    engine: Engine, client_b: TestClient
) -> None:
    seed(engine, A_ID, OWNER_A)
    before = snapshot(engine, A_ID)
    foreign = client_b.delete(f"{BASE}/{A_ID}")
    missing = client_b.delete(f"{BASE}/does_not_exist")
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert snapshot(engine, A_ID) == before


def test_null_owner_rows_are_invisible_to_everyone(
    engine: Engine, client_a: TestClient, client_b: TestClient
) -> None:
    seed(engine, "p_legacy", None)
    for client in (client_a, client_b):
        assert client.get(BASE).json() == []
        assert client.get(f"{BASE}/p_legacy").status_code == 404
        assert client.delete(f"{BASE}/p_legacy").status_code == 404
    assert snapshot(engine, "p_legacy")["project"] is not None


# ---------------------------------------------------------------- put state (T9)


@pending("T9")
@pytest.mark.parametrize("updated_at", [A_STATE_UPDATED - 1000, A_STATE_UPDATED + 1000])
def test_put_state_on_foreign_id_returns_404_and_writes_nothing(
    engine: Engine, client_b: TestClient, updated_at: int
) -> None:
    # The stale value would give A a 409; B must still get 404 so it cannot probe through 409.
    seed(engine, A_ID, OWNER_A)
    before = snapshot(engine, A_ID)
    body = {"campaign_state": {"completed_stories": [], "marker": "B"}, "updated_at": updated_at}
    foreign = client_b.put(f"{BASE}/{A_ID}/state", json=body)
    missing = client_b.put(f"{BASE}/does_not_exist/state", json=body)
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert snapshot(engine, A_ID) == before


# ---------------------------------------------------------------- create (T8)


def test_create_with_a_foreign_id_returns_409_and_changes_nothing(
    engine: Engine, client_b: TestClient
) -> None:
    seed(engine, A_ID, OWNER_A)
    before = snapshot(engine, A_ID)
    response = client_b.post(BASE, json=payload(A_ID, updated_at=99999))
    assert response.status_code == 409
    assert str(OWNER_A) not in response.text
    assert A_TITLE not in response.text
    assert snapshot(engine, A_ID) == before


def test_create_with_a_null_owner_id_returns_409(engine: Engine, client_a: TestClient) -> None:
    seed(engine, "p_legacy", None)
    before = snapshot(engine, "p_legacy")
    response = client_a.post(BASE, json=payload("p_legacy", updated_at=99999))
    assert response.status_code == 409
    assert snapshot(engine, "p_legacy") == before


# ---------------------------------------------------------------- import (T10)


@pending("T10")
def test_import_with_a_foreign_id_is_skipped_and_changes_nothing(
    engine: Engine, client_b: TestClient
) -> None:
    seed(engine, A_ID, OWNER_A)
    before = snapshot(engine, A_ID)
    response = client_b.post(f"{BASE}/import", json={"projects": [payload(A_ID, 99999)]})
    assert response.status_code == 200
    assert response.json()["imported"] == 0
    assert response.json()["skipped"] == 1
    assert snapshot(engine, A_ID) == before
