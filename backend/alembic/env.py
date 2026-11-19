"""Alembic migration environment configured from PG* environment variables."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool

from app.db import create_db_engine, load_db_config_from_env

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = None


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    cfg = load_db_config_from_env()
    if cfg is None:
        raise RuntimeError("PGHOST must be set to run Alembic offline migrations")

    context.configure(
        url=cfg.url().render_as_string(hide_password=False),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    existing_conn = config.attributes.get("connection")
    if existing_conn is not None:
        context.configure(connection=existing_conn, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        return

    connectable = create_db_engine(poolclass=pool.NullPool)
    if connectable is None:
        raise RuntimeError("PGHOST must be set to run Alembic online migrations")

    try:
        with connectable.connect() as connection:
            context.configure(connection=connection, target_metadata=target_metadata)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
