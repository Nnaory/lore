"""Shared PostgreSQL fixtures for the projects API tests.

Why: the ownership, CRUD and limit tests all need a migrated database emptied before each test
and an app wired to it; one definition keeps them consistent. Fixtures only run in tests that
request them, so non-DB tests are unaffected when PGHOST is unset.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.pool import NullPool

from app.db import create_db_engine
from app.main import create_app
from app.owner import COOKIE_NAME

BACKEND_DIR = Path(__file__).resolve().parent.parent
FIXTURE = Path(__file__).parent / "fixtures" / "project.json"


@pytest.fixture(scope="session")
def migrated() -> None:
    command.upgrade(Config(str(BACKEND_DIR / "alembic.ini")), "head")


@pytest.fixture
def engine(migrated: None) -> Iterator[Engine]:
    eng = create_db_engine(poolclass=NullPool)
    assert eng is not None
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE projects CASCADE"))
    try:
        yield eng
    finally:
        eng.dispose()


@pytest.fixture
def app(engine: Engine) -> FastAPI:
    return create_app(engine)


def make_client(app: FastAPI, owner: uuid.UUID) -> TestClient:
    client = TestClient(app)
    client.cookies.set(COOKIE_NAME, str(owner))
    return client


def fixture_payload() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def insert_project(
    engine: Engine,
    project_id: str,
    owner: uuid.UUID | None,
    *,
    updated_at: int = 1000,
    title: str = "Title",
    stories: dict[str, Any] | None = None,
    state: dict[str, Any] | None = None,
    state_updated_at: int | None = None,
) -> None:
    """Insert a project (and optionally stories and state) directly, bypassing the API."""
    stories = stories if stories is not None else {}
    campaign = {"title": title, "genre": "fantasy", "story_sequence": list(stories)}
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO projects (id, owner_id, created_at, updated_at, source, campaign, "
                "title, genre, source_name, stories_total, stories_completed) VALUES "
                "(:id, :owner, :created, :updated, CAST(:source AS jsonb), "
                "CAST(:campaign AS jsonb), :title, 'fantasy', 'a.pdf', :total, 0)"
            ),
            {
                "id": project_id,
                "owner": owner,
                "created": updated_at,
                "updated": updated_at,
                "source": json.dumps({"file_name": "a.pdf", "file_type": "pdf"}),
                "campaign": json.dumps(campaign),
                "title": title,
                "total": len(stories),
            },
        )
        for story_id, blueprint in stories.items():
            conn.execute(
                text("INSERT INTO project_stories VALUES (:id, :sid, CAST(:bp AS jsonb))"),
                {"id": project_id, "sid": story_id, "bp": json.dumps(blueprint)},
            )
        if state is not None:
            conn.execute(
                text("INSERT INTO project_state VALUES (:id, CAST(:st AS jsonb), :updated)"),
                {
                    "id": project_id,
                    "st": json.dumps(state),
                    "updated": state_updated_at if state_updated_at is not None else updated_at,
                },
            )
