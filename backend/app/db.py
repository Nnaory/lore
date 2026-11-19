"""Database configuration, engine factory, and readiness checks for LORE."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import Pool

logger = logging.getLogger(__name__)

MAX_CONNECTIONS_PER_PROCESS = 10
DEFAULT_POOL_SIZE = 5
DEFAULT_MAX_OVERFLOW = 5
DEFAULT_CONNECT_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class DatabaseConfig:
    """PostgreSQL connection settings derived from PG* environment variables."""

    host: str
    port: int
    database: str
    user: str
    password: str | None
    sslmode: str
    pool_size: int
    max_overflow: int
    connect_timeout: int

    def url(self) -> URL:
        """Build a SQLAlchemy URL cleanly without string interpolation."""
        return URL.create(
            "postgresql+psycopg",
            username=self.user or None,
            password=self.password,
            host=self.host,
            port=self.port,
            database=self.database or None,
        )


def _parse_int_env(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int | None = None,
) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f"{name} out of allowed range: {value}")
    return value


def load_db_config_from_env() -> DatabaseConfig | None:
    """Read PG* and pool settings from environment, or return None if PGHOST is unset."""
    host = os.getenv("PGHOST", "").strip()
    if not host:
        return None

    port = _parse_int_env("PGPORT", 5432, minimum=1, maximum=65535)
    database = os.getenv("PGDATABASE", "lore").strip() or "lore"
    user = os.getenv("PGUSER", "").strip()
    password = os.getenv("PGPASSWORD")
    sslmode = os.getenv("PGSSLMODE", "require").strip() or "require"

    pool_size = _parse_int_env("DB_POOL_SIZE", DEFAULT_POOL_SIZE, minimum=1)
    max_overflow = _parse_int_env("DB_MAX_OVERFLOW", DEFAULT_MAX_OVERFLOW, minimum=0)
    if pool_size + max_overflow > MAX_CONNECTIONS_PER_PROCESS:
        raise ValueError(
            "DB_POOL_SIZE + DB_MAX_OVERFLOW must not exceed "
            f"{MAX_CONNECTIONS_PER_PROCESS} per process"
        )

    connect_timeout = _parse_int_env(
        "DB_CONNECT_TIMEOUT",
        DEFAULT_CONNECT_TIMEOUT_SECONDS,
        minimum=1,
    )

    return DatabaseConfig(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password,
        sslmode=sslmode,
        pool_size=pool_size,
        max_overflow=max_overflow,
        connect_timeout=connect_timeout,
    )


def create_db_engine(
    config: DatabaseConfig | None = None,
    *,
    poolclass: type[Pool] | None = None,
) -> Engine | None:
    """Create a SQLAlchemy engine from config/env, or return None if DB is unconfigured."""
    cfg = config if config is not None else load_db_config_from_env()
    if cfg is None:
        return None

    kwargs: dict[str, Any] = {
        "connect_args": {
            "connect_timeout": cfg.connect_timeout,
            "sslmode": cfg.sslmode,
        },
    }
    if poolclass is not None:
        kwargs["poolclass"] = poolclass
    else:
        kwargs["pool_size"] = cfg.pool_size
        kwargs["max_overflow"] = cfg.max_overflow
        kwargs["pool_pre_ping"] = True
        kwargs["pool_recycle"] = 1800

    return create_engine(cfg.url(), **kwargs)


def check_db_health(engine: Engine) -> bool:
    """Verify PostgreSQL connectivity via SELECT 1 without exposing credentials."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except SQLAlchemyError as exc:
        logger.warning("Database health check failed (%s)", type(exc).__name__)
        return False
