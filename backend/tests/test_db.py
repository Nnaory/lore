"""Unit and PostgreSQL integration tests for DB configuration and Alembic migrations."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.pool import NullPool, QueuePool

from app.db import create_db_engine, load_db_config_from_env
from app.main import create_app

BACKEND_DIR = Path(__file__).resolve().parent.parent
INITIAL_REVISION = "4ee36ac0a0f8"


def test_load_db_config_returns_none_without_pghost(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PGHOST", raising=False)
    assert load_db_config_from_env() is None

    monkeypatch.setenv("PGHOST", "   ")
    assert load_db_config_from_env() is None


def test_load_db_config_preserves_special_chars_and_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_password = "p@ss:w/o%rd#1?&=+"
    monkeypatch.setenv("PGHOST", "db.internal")
    monkeypatch.setenv("PGUSER", "lore_admin")
    monkeypatch.setenv("PGPASSWORD", raw_password)
    monkeypatch.delenv("PGPORT", raising=False)
    monkeypatch.delenv("PGDATABASE", raising=False)
    monkeypatch.delenv("PGSSLMODE", raising=False)
    monkeypatch.delenv("DB_POOL_SIZE", raising=False)
    monkeypatch.delenv("DB_MAX_OVERFLOW", raising=False)

    cfg = load_db_config_from_env()
    assert cfg is not None
    assert cfg.host == "db.internal"
    assert cfg.port == 5432
    assert cfg.database == "lore"
    assert cfg.user == "lore_admin"
    assert cfg.password == raw_password
    assert cfg.sslmode == "require"
    assert cfg.pool_size == 5
    assert cfg.max_overflow == 5

    url = cfg.url()
    assert url.password == raw_password
    assert raw_password not in url.render_as_string(hide_password=True)


def test_load_db_config_rejects_oversized_pool_and_invalid_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PGHOST", "db.internal")
    monkeypatch.setenv("DB_POOL_SIZE", "6")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "5")
    with pytest.raises(ValueError, match="must not exceed 10"):
        load_db_config_from_env()

    monkeypatch.setenv("DB_POOL_SIZE", "5")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "5")
    monkeypatch.setenv("PGPORT", "70000")
    with pytest.raises(ValueError, match="PGPORT"):
        load_db_config_from_env()


def test_create_db_engine_supports_queue_pool_and_null_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PGHOST", "127.0.0.1")
    monkeypatch.setenv("PGUSER", "lore_admin")
    monkeypatch.setenv("PGPASSWORD", "secret")
    monkeypatch.setenv("DB_POOL_SIZE", "4")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "3")

    pooled = create_db_engine()
    assert pooled is not None
    assert isinstance(pooled.pool, QueuePool)
    assert pooled.pool.size() == 4
    pooled.dispose()

    null_pooled = create_db_engine(poolclass=NullPool)
    assert null_pooled is not None
    assert isinstance(null_pooled.pool, NullPool)
    null_pooled.dispose()


@pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")
def test_live_postgres_health_db_endpoint() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/health/db")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"status": "ok"}


@pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")
def test_live_postgres_alembic_upgrade_and_downgrade() -> None:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    command.upgrade(cfg, "head")

    engine = create_db_engine(poolclass=NullPool)
    assert engine is not None
    try:
        with engine.connect() as conn:
            rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert rev == INITIAL_REVISION

        command.downgrade(cfg, "base")
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT version_num FROM alembic_version")).fetchall()
        assert rows == []

        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            rev_after = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        assert rev_after == INITIAL_REVISION
    finally:
        engine.dispose()
