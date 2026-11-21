"""Endpoint tests for /api/v1/projects against PostgreSQL (single owner).

Why: covers the data shape each endpoint returns and stores. Cross-owner behaviour lives in
test_projects_ownership.py; size limits and caps in test_projects_limits.py.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Any

import pytest
from conftest import fixture_payload, insert_project, make_client
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text

from app.owner import COOKIE_NAME

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


# ---------------------------------------------------------------- create (T8)


def _create_payload(project_id: str | None = "p_lk2j_ab12cd", updated_at: int = 5000) -> dict:
    body = fixture_payload()
    body["id"] = project_id
    body["created_at"] = updated_at - 100
    body["updated_at"] = updated_at
    return body


def test_create_then_get_round_trips_every_opaque_field(client: TestClient) -> None:
    body = _create_payload()
    body["campaign"]["premise"] = "Kota Berkabut — 雾之城 🎃"
    body["materials"][0]["concepts"] = [{"id": "c1", "nested": {"deep": [1, 2.5, None, True]}}]
    created = client.post(BASE, json=body)
    assert created.status_code == 201
    loaded = client.get(f"{BASE}/{body['id']}").json()
    for key in ("source", "campaign", "stories", "campaign_state", "materials"):
        assert loaded[key] == body[key], key
    assert (loaded["created_at"], loaded["updated_at"]) == (4900, 5000)
    assert created.json() == loaded


def test_create_with_state_feeds_stories_completed_in_list(client: TestClient) -> None:
    body = _create_payload()
    assert client.post(BASE, json=body).status_code == 201
    assert client.get(f"{BASE}/{body['id']}").json()["campaign_state"] == body["campaign_state"]
    summary = client.get(BASE).json()[0]
    assert summary["stories_total"] == 2
    assert summary["stories_completed"] == 1
    assert summary["title"] == body["campaign"]["title"]
    assert summary["source_name"] == "vektor-dasar.pdf"


def test_create_without_id_and_timestamps_generates_them(client: TestClient) -> None:
    body = _create_payload(project_id=None)
    del body["created_at"], body["updated_at"]
    before = time.time_ns() // 1_000_000
    response = client.post(BASE, json=body)
    after = time.time_ns() // 1_000_000
    assert response.status_code == 201
    data = response.json()
    assert data["id"]
    assert before <= data["created_at"] == data["updated_at"] <= after
    assert client.get(f"{BASE}/{data['id']}").status_code == 200


def test_create_accepts_a_non_uuid_id(client: TestClient) -> None:
    response = client.post(BASE, json=_create_payload(project_id="p_lk2j_ab12cd"))
    assert response.status_code == 201
    assert response.json()["id"] == "p_lk2j_ab12cd"


def test_create_without_title_is_422_and_stores_nothing(engine: Engine, client: TestClient) -> None:
    body = _create_payload()
    del body["campaign"]["title"]
    response = client.post(BASE, json=body)
    assert response.status_code == 422
    assert "campaign.title" in response.text
    assert _count(engine, "projects") == 0


def test_repost_with_older_updated_at_returns_200_and_changes_nothing(
    client: TestClient,
) -> None:
    body = _create_payload(updated_at=5000)
    stored = client.post(BASE, json=body).json()
    older = _create_payload(updated_at=4000)
    older["campaign"]["title"] = "Older title"
    del older["stories"]["story_02"]
    response = client.post(BASE, json=older)
    assert response.status_code == 200
    assert response.json() == stored
    assert client.get(f"{BASE}/{body['id']}").json() == stored


def test_repost_with_newer_updated_at_returns_200_and_replaces(client: TestClient) -> None:
    client.post(BASE, json=_create_payload(updated_at=5000))
    newer = _create_payload(updated_at=6000)
    newer["campaign"]["title"] = "Newer title"
    del newer["stories"]["story_02"]
    response = client.post(BASE, json=newer)
    assert response.status_code == 200
    loaded = client.get(f"{BASE}/{newer['id']}").json()
    assert loaded["campaign"]["title"] == "Newer title"
    assert set(loaded["stories"]) == {"story_01"}
    assert loaded["updated_at"] == 6000


def test_create_is_atomic_when_a_story_insert_fails(engine: Engine, app: FastAPI) -> None:
    def fail_on_story_insert(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        if statement.lstrip().startswith("INSERT INTO project_stories"):
            raise RuntimeError("forced story insert failure")

    client = TestClient(app, raise_server_exceptions=False)
    client.cookies.set(COOKIE_NAME, str(OWNER))
    event.listen(engine, "before_cursor_execute", fail_on_story_insert)
    try:
        response = client.post(BASE, json=_create_payload())
    finally:
        event.remove(engine, "before_cursor_execute", fail_on_story_insert)
    assert response.status_code == 500
    assert _count(engine, "projects") == 0
    assert _count(engine, "project_state") == 0


# ---------------------------------------------------------------- save state (T9)


def _state(*completed: str, marker: str = "") -> dict[str, Any]:
    return {"completed_stories": list(completed), "marker": marker}


def _stored_state(engine: Engine, project_id: str) -> tuple[Any, ...] | None:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT campaign_state, updated_at FROM project_state WHERE project_id = :id"),
            {"id": project_id},
        ).one_or_none()
    return tuple(row) if row else None


def test_first_save_creates_the_row_and_touches_the_project(
    engine: Engine, client: TestClient
) -> None:
    insert_project(engine, "p1", OWNER, updated_at=1000, stories={"s1": {}, "s2": {}})
    body = {"campaign_state": _state("s1", marker="first"), "updated_at": 2000}
    response = client.put(f"{BASE}/p1/state", json=body)
    assert response.status_code == 200
    assert response.json() == {"updated_at": 2000}
    assert _stored_state(engine, "p1") == (body["campaign_state"], 2000)
    summary = client.get(BASE).json()[0]
    assert (summary["stories_completed"], summary["updated_at"]) == (1, 2000)


def test_equal_updated_at_is_accepted(engine: Engine, client: TestClient) -> None:
    insert_project(engine, "p1", OWNER, state=_state(marker="old"), state_updated_at=2000)
    body = {"campaign_state": _state("s1", marker="same-time"), "updated_at": 2000}
    assert client.put(f"{BASE}/p1/state", json=body).status_code == 200
    assert _stored_state(engine, "p1") == (body["campaign_state"], 2000)


def test_stale_save_is_409_with_stored_value_and_writes_nothing(
    engine: Engine, client: TestClient
) -> None:
    insert_project(engine, "p1", OWNER, updated_at=3000, state=_state("s1", marker="kept"))
    before_summary = client.get(BASE).json()
    body = {"campaign_state": _state(marker="stale"), "updated_at": 2999}
    response = client.put(f"{BASE}/p1/state", json=body)
    assert response.status_code == 409
    assert response.json() == {"detail": "stale state", "stored_updated_at": 3000}
    assert _stored_state(engine, "p1") == (_state("s1", marker="kept"), 3000)
    assert client.get(BASE).json() == before_summary


@pytest.mark.parametrize("state", [{"marker": "x"}, {"completed_stories": "s1"}])
def test_bad_completed_stories_is_422(
    engine: Engine, client: TestClient, state: dict[str, Any]
) -> None:
    insert_project(engine, "p1", OWNER)
    response = client.put(f"{BASE}/p1/state", json={"campaign_state": state, "updated_at": 2})
    assert response.status_code == 422
    assert "completed_stories" in response.text
    assert _stored_state(engine, "p1") is None


def _race(app: FastAPI, payloads: list[dict[str, Any]]) -> dict[int, int]:
    """Send the payloads from separate clients released together; return status per updated_at."""
    barrier = threading.Barrier(len(payloads))
    statuses: dict[int, int] = {}

    def send(payload: dict[str, Any]) -> None:
        local = make_client(app, OWNER)
        barrier.wait()
        response = local.put(f"{BASE}/p1/state", json=payload)
        statuses[payload["updated_at"]] = response.status_code

    threads = [threading.Thread(target=send, args=(p,)) for p in payloads]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return statuses


@pytest.mark.parametrize("newer_first", [True, False])
def test_racing_saves_end_with_the_newer_state(
    engine: Engine, app: FastAPI, newer_first: bool
) -> None:
    """Two clients (two connections) fire at once; whichever lands first, the newer one wins."""
    insert_project(engine, "p1", OWNER)
    older = {"campaign_state": _state(marker="older"), "updated_at": 2000}
    newer = {"campaign_state": _state("s1", marker="newer"), "updated_at": 3000}
    order = [newer, older] if newer_first else [older, newer]
    for _ in range(5):
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM project_state"))
        statuses = _race(app, order)
        assert statuses[3000] == 200
        assert statuses[2000] in (200, 409)
        assert _stored_state(engine, "p1") == (newer["campaign_state"], 3000)


# ---------------------------------------------------------------- import (T10)


def _import(client: TestClient, *projects: Any) -> dict[str, Any]:
    response = client.post(f"{BASE}/import", json={"projects": list(projects)})
    assert response.status_code == 200, response.text
    return response.json()


def _snapshot(client: TestClient) -> tuple[Any, ...]:
    listing = client.get(BASE).json()
    return tuple((p, client.get(f"{BASE}/{p['id']}").json()) for p in listing)


def test_import_preserves_campaign_state_and_progress(client: TestClient) -> None:
    body = _create_payload()
    assert body["campaign_state"]["completed_stories"] == ["story_01"]
    result = _import(client, body)
    assert result == {"imported": 1, "skipped": 0, "rejected": []}
    loaded = client.get(f"{BASE}/{body['id']}").json()
    assert loaded["campaign_state"] == body["campaign_state"]
    assert client.get(BASE).json()[0]["stories_completed"] == 1


def test_second_identical_import_changes_nothing(client: TestClient) -> None:
    body = _create_payload()
    _import(client, body)
    before = _snapshot(client)
    result = _import(client, body)
    # Equal updated_at rewrites the same data (design uses <=), so it counts as imported.
    assert result == {"imported": 1, "skipped": 0, "rejected": []}
    assert _snapshot(client) == before


def test_older_copy_never_overwrites_and_newer_copy_replaces(client: TestClient) -> None:
    _import(client, _create_payload(updated_at=5000))
    older = _create_payload(updated_at=4000)
    older["campaign"]["title"] = "Older"
    older["campaign_state"]["completed_stories"] = []
    assert _import(client, older) == {"imported": 0, "skipped": 1, "rejected": []}
    loaded = client.get(f"{BASE}/{older['id']}").json()
    assert loaded["campaign"]["title"] != "Older"
    assert loaded["campaign_state"]["completed_stories"] == ["story_01"]

    newer = _create_payload(updated_at=6000)
    newer["campaign"]["title"] = "Newer"
    newer["campaign_state"]["completed_stories"] = ["story_01", "story_02"]
    assert _import(client, newer) == {"imported": 1, "skipped": 0, "rejected": []}
    loaded = client.get(f"{BASE}/{newer['id']}").json()
    assert loaded["campaign"]["title"] == "Newer"
    assert loaded["campaign_state"] == newer["campaign_state"]
    assert client.get(BASE).json()[0]["stories_completed"] == 2


def test_mixed_batch_counts_and_rejects_invalid_items(engine: Engine, client: TestClient) -> None:
    insert_project(engine, "p_foreign", uuid.UUID(int=7), title="Not yours")
    _import(client, _create_payload(project_id="p_mine", updated_at=5000))

    invalid = _create_payload(project_id="p_invalid")
    del invalid["campaign"]["title"]
    nul = _create_payload(project_id="p_nul")
    nul["campaign"]["premise"] = "bad \u0000 byte"  # Postgres jsonb refuses NUL characters
    batch = [
        _create_payload(project_id="p_new_1"),
        _create_payload(project_id="p_mine", updated_at=4000),  # own, older: skipped
        _create_payload(project_id="p_foreign"),  # another owner: skipped
        invalid,
        "not an object",
        nul,
        _create_payload(project_id="p_new_2"),
    ]
    result = _import(client, *batch)
    assert (result["imported"], result["skipped"]) == (2, 2)
    rejected = {r["index"]: r for r in result["rejected"]}
    assert set(rejected) == {3, 4, 5}
    assert rejected[3]["id"] == "p_invalid"
    assert "campaign.title" in rejected[3]["error"]
    assert rejected[4]["id"] is None
    assert rejected[5] == {"index": 5, "id": "p_nul", "error": "invalid data"}

    ids = {p["id"] for p in client.get(BASE).json()}
    assert ids == {"p_mine", "p_new_1", "p_new_2"}
    assert client.get(f"{BASE}/p_mine").json()["updated_at"] == 5000
