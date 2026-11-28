"""Tests for the `animations` Alembic revision (single head, offline SQL, live PostgreSQL DDL).

Why: the table is the contract between the animation registry and the data. These checks catch a
forked migration chain, column/NOT NULL drift, CHECK constraints that stop rejecting bad ids,
hashes, sizes or `s3_prefix`, and a broken downgrade before the migrate service runs in prod.
The chain and offline-SQL tests need no database; the rest are skipped without PGHOST like the
other DB tests.
"""

from __future__ import annotations

import io
import json
import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg.errors
import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from app.db import create_db_engine

BACKEND_DIR = Path(__file__).resolve().parent.parent
REVISION = "725515cc1581"
PREVIOUS = "7c1d9e4a52b8"
INDEX_NAME = "idx_animations_owner_created"
UNIQUE_NAME = "uq_animations_owner_request"

requires_pg = pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")

EXPECTED_COLUMNS = {
    "id": "text",
    "owner_id": "uuid",
    "request_hash": "text",
    "source_sha256": "text",
    "bundle_sha256": "text",
    "s3_prefix": "text",
    "kind": "text",
    "meta": "jsonb",
    "attempts": "integer",
    "model": "text",
    "verifier_version": "text",
    "contract_version": "integer",
    "runtime_version": "jsonb",
    "source_bytes": "integer",
    "bundle_bytes": "integer",
    "created_at": "bigint",
}

SOURCE_SHA = "9f" + "2c" * 31


def _config(buffer: io.StringIO | None = None) -> Config:
    return Config(str(BACKEND_DIR / "alembic.ini"), output_buffer=buffer)


def _valid_row(**overrides: Any) -> dict[str, Any]:
    """A row that satisfies every constraint; `s3_prefix` follows `source_sha256` unless given."""
    row: dict[str, Any] = {
        "id": "3f8e2b1c-6d4a-4e5f-9a7b-0c1d2e3f4a5b",
        "owner_id": uuid.UUID("11111111-2222-4333-8444-555555555555"),
        "request_hash": "c0" * 32,
        "source_sha256": SOURCE_SHA,
        "bundle_sha256": "41" * 32,
        "kind": "lesson",
        "meta": {"width": 1280, "height": 720, "fps": 30, "durationInFrames": 150},
        "attempts": 2,
        "model": "gemini-3.5-flash-lite",
        "verifier_version": "0.1.0",
        "contract_version": 1,
        "runtime_version": {"react": "19.3.0", "remotion": "4.0.543"},
        "source_bytes": 6120,
        "bundle_bytes": 8734,
        "created_at": 1_700_000_000_000,
    }
    row.update(overrides)
    if "s3_prefix" not in row:
        sha = row["source_sha256"]
        row["s3_prefix"] = f"animations/v1/{sha[:2]}/{sha}/"
    return row


def _insert(engine: Engine, row: dict[str, Any]) -> None:
    params = {
        **row,
        "meta": json.dumps(row["meta"]),
        "runtime_version": json.dumps(row["runtime_version"]),
    }
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO animations (id, owner_id, request_hash, source_sha256, "
                "bundle_sha256, s3_prefix, kind, meta, attempts, model, verifier_version, "
                "contract_version, runtime_version, source_bytes, bundle_bytes, created_at) "
                "VALUES (:id, :owner_id, :request_hash, :source_sha256, :bundle_sha256, "
                ":s3_prefix, :kind, CAST(:meta AS jsonb), :attempts, :model, :verifier_version, "
                ":contract_version, CAST(:runtime_version AS jsonb), :source_bytes, "
                ":bundle_bytes, :created_at)"
            ),
            params,
        )


@pytest.fixture
def engine() -> Iterator[Engine]:
    """Engine on a database migrated to head with an empty `animations` table."""
    command.upgrade(_config(), "head")
    eng = create_db_engine(poolclass=NullPool)
    assert eng is not None
    with eng.begin() as conn:
        conn.execute(text("TRUNCATE animations"))
    try:
        yield eng
    finally:
        eng.dispose()


def _scalar(engine: Engine, sql: str) -> Any:
    with engine.connect() as conn:
        return conn.execute(text(sql)).scalar()


def _version(engine: Engine) -> str:
    return str(_scalar(engine, "SELECT version_num FROM alembic_version"))


def _table_exists(engine: Engine, table: str) -> bool:
    return _scalar(engine, f"SELECT to_regclass('public.{table}')") is not None


def _index_def(engine: Engine) -> str | None:
    return _scalar(engine, f"SELECT indexdef FROM pg_indexes WHERE indexname = '{INDEX_NAME}'")


def _unique_def(engine: Engine) -> str | None:
    return _scalar(
        engine,
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        f"WHERE conname = '{UNIQUE_NAME}' AND contype = 'u'",
    )


def test_revision_is_the_only_head_and_follows_r13() -> None:
    scripts = ScriptDirectory.from_config(_config())
    assert len(scripts.get_heads()) == 1
    revision = scripts.get_revision(REVISION)
    assert revision is not None
    assert revision.down_revision == PREVIOUS


def test_offline_sql_creates_table_then_index_and_downgrade_drops_index_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PGHOST", "offline.invalid")

    up = io.StringIO()
    command.upgrade(_config(up), f"{PREVIOUS}:{REVISION}", sql=True)
    up_sql = up.getvalue()
    assert up_sql.index("CREATE TABLE animations") < up_sql.index(f"CREATE INDEX {INDEX_NAME}")
    assert f"CONSTRAINT {UNIQUE_NAME} UNIQUE (owner_id, request_hash)" in up_sql
    # Expand-only: the upgrade neither alters nor drops anything that already exists.
    assert "ALTER" not in up_sql
    assert "DROP" not in up_sql

    down = io.StringIO()
    command.downgrade(_config(down), f"{REVISION}:{PREVIOUS}", sql=True)
    down_sql = down.getvalue()
    assert down_sql.index(f"DROP INDEX IF EXISTS {INDEX_NAME}") < down_sql.index(
        "DROP TABLE IF EXISTS animations"
    )
    assert "projects" not in down_sql


@requires_pg
def test_upgrade_creates_columns_all_not_null_and_the_index(engine: Engine) -> None:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'animations'"
            )
        ).fetchall()
    assert {r[0]: r[1] for r in rows} == EXPECTED_COLUMNS
    assert {r[2] for r in rows} == {"NO"}

    assert "(owner_id, created_at DESC)" in (_index_def(engine) or "")
    assert _unique_def(engine) == "UNIQUE (owner_id, request_hash)"


@requires_pg
def test_valid_row_is_accepted(engine: Engine) -> None:
    _insert(engine, _valid_row())
    assert _scalar(engine, "SELECT count(*) FROM animations") == 1


@requires_pg
@pytest.mark.parametrize(
    "override",
    [
        {"id": "3F8E2B1C-6D4A-4E5F-9A7B-0C1D2E3F4A5B"},
        {"id": "3f8e2b1c6d4a4e5f9a7b0c1d2e3f4a5b"},
        {"request_hash": "C0" * 32},
        {"request_hash": "c0" * 31},
        {"source_sha256": "9F" + "2C" * 31},
        {"bundle_sha256": "zz" * 32},
        {"s3_prefix": f"animations/v1/00/{SOURCE_SHA}/"},
        {"s3_prefix": f"animations/v2/9f/{SOURCE_SHA}/"},
        {"s3_prefix": f"animations/v1/9f/{SOURCE_SHA}"},
        {"kind": "quiz"},
        {"attempts": 0},
        {"attempts": 5},
        {"source_bytes": 0},
        {"source_bytes": 32769},
        {"bundle_bytes": 0},
        {"bundle_bytes": 131073},
    ],
    ids=lambda o: "-".join(f"{k}={str(v)[:24]}" for k, v in o.items()),
)
def test_check_constraints_reject_bad_values(engine: Engine, override: dict[str, Any]) -> None:
    with pytest.raises(IntegrityError) as raised:
        _insert(engine, _valid_row(**override))
    assert isinstance(raised.value.orig, psycopg.errors.CheckViolation)
    assert _scalar(engine, "SELECT count(*) FROM animations") == 0


@requires_pg
@pytest.mark.parametrize(
    "override",
    [
        {"kind": "puzzle"},
        {"attempts": 1},
        {"attempts": 4},
        {"source_bytes": 1},
        {"source_bytes": 32768},
        {"bundle_bytes": 1},
        {"bundle_bytes": 131072},
    ],
    ids=lambda o: "-".join(f"{k}={v}" for k, v in o.items()),
)
def test_check_constraints_accept_boundary_values(engine: Engine, override: dict[str, Any]) -> None:
    _insert(engine, _valid_row(**override))
    assert _scalar(engine, "SELECT count(*) FROM animations") == 1


@requires_pg
def test_owner_and_request_hash_are_unique_per_owner(engine: Engine) -> None:
    _insert(engine, _valid_row())
    other_id = "7a1b9c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"
    with pytest.raises(IntegrityError) as raised:
        _insert(engine, _valid_row(id=other_id))
    assert isinstance(raised.value.orig, psycopg.errors.UniqueViolation)

    other_owner = uuid.UUID("99999999-2222-4333-8444-555555555555")
    _insert(engine, _valid_row(id=other_id, owner_id=other_owner))
    assert _scalar(engine, "SELECT count(*) FROM animations") == 2


@requires_pg
def test_downgrade_then_upgrade_round_trip_keeps_projects(engine: Engine) -> None:
    cfg = _config()
    try:
        command.upgrade(cfg, "head")
        # No-op while this revision is head; peels newer revisions first once there are any.
        command.downgrade(cfg, REVISION)
        assert _version(engine) == REVISION
        assert _table_exists(engine, "animations")

        command.downgrade(cfg, "-1")
        assert _version(engine) == PREVIOUS
        assert not _table_exists(engine, "animations")
        assert _index_def(engine) is None
        assert _unique_def(engine) is None
        assert _table_exists(engine, "projects")

        command.upgrade(cfg, "head")
        assert _table_exists(engine, "animations")
        assert "(owner_id, created_at DESC)" in (_index_def(engine) or "")
        assert _unique_def(engine) == "UNIQUE (owner_id, request_hash)"
    finally:
        command.upgrade(cfg, "head")
