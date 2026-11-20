"""PostgreSQL tests for the r13 persistence migration (tables, types, cascade, downgrade).

Why: the schema is the contract between the API and the data; these checks catch type drift
(text ids, bigint timestamps) and a broken downgrade before the migrate service runs in prod.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, text
from sqlalchemy.pool import NullPool

from app.db import create_db_engine

BACKEND_DIR = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")


@pytest.fixture
def engine() -> Iterator[Engine]:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    eng = create_db_engine(poolclass=NullPool)
    assert eng is not None
    try:
        yield eng
    finally:
        eng.dispose()


def _columns(engine: Engine, table: str) -> dict[str, tuple[str, str]]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table},
        ).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


def test_upgrade_creates_tables_with_expected_types(engine: Engine) -> None:
    projects = _columns(engine, "projects")
    assert projects["id"] == ("text", "NO")
    assert projects["owner_id"] == ("uuid", "YES")
    assert projects["created_at"] == ("bigint", "NO")
    assert projects["updated_at"] == ("bigint", "NO")
    assert projects["materials"] == ("jsonb", "YES")
    assert projects["stories_total"] == ("integer", "NO")

    stories = _columns(engine, "project_stories")
    assert stories["project_id"] == ("text", "NO")
    assert stories["blueprint"] == ("jsonb", "NO")

    state = _columns(engine, "project_state")
    assert state["project_id"] == ("text", "NO")
    assert state["updated_at"] == ("bigint", "NO")

    with engine.connect() as conn:
        index = conn.execute(
            text("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_projects_owner_updated'")
        ).scalar()
    assert index == 1


def test_delete_project_cascades_to_stories_and_state(engine: Engine) -> None:
    doc = json.dumps({})
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO projects (id, created_at, updated_at, source, campaign, title, "
                "genre, source_name, stories_total) VALUES ('p1', 1, 1, :d, :d, 't', 'g', 's', 1)"
            ),
            {"d": doc},
        )
        conn.execute(
            text("INSERT INTO project_stories VALUES ('p1', 's1', :d)"),
            {"d": doc},
        )
        conn.execute(text("INSERT INTO project_state VALUES ('p1', :d, 1)"), {"d": doc})
        conn.execute(text("DELETE FROM projects WHERE id = 'p1'"))
        stories = conn.execute(text("SELECT count(*) FROM project_stories")).scalar_one()
        states = conn.execute(text("SELECT count(*) FROM project_state")).scalar_one()
    assert stories == 0
    assert states == 0


def test_downgrade_drops_tables_and_upgrade_works_again(engine: Engine) -> None:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    command.downgrade(cfg, "base")
    for table in ("projects", "project_stories", "project_state"):
        assert _columns(engine, table) == {}
    command.upgrade(cfg, "head")
    assert "id" in _columns(engine, "projects")
