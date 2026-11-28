"""Tests for the Animation_Registry (`app.ai.animation.registry`).

Why: the registry is what makes a request idempotent and what caps an owner at 200 animations, and
both rules must hold when requests arrive together (Requirements 18.3 to 18.9, 20.4, 20.5, 20.7 to
20.10, 39.10, 39.11). The rules live in SQL and in one advisory lock, so the proof is Postgres.

Two groups, kept apart on purpose:

- `[PG]` tests (marked `requires_pg`, skipped without PGHOST like the other DB tests) run
  `register`, `find`, `count` and `get` against a migrated database: idempotency, the quota with
  `owner_max_animations` replaced by 1, no quota on an Idempotent_Hit, concurrent identical and
  different requests (real threads, real connections), owner isolation, and a lock that really
  blocks. A skipped test is NOT evidence; CI `ci/api` runs them with a `postgres:16-alpine` service.
- Database-free tests check what can be checked without a server and without a test double:
  the statements against `AnimationRow` and the bind values, the result-row mapping, and the
  `RegistryError` wrap on a real engine pointed at a closed local port. They do not prove the
  control flow of `register`; only the `[PG]` tests do.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from app.ai.animation import registry
from app.ai.animation.limits import AnimationLimits
from app.ai.animation.models import AnimationRow
from app.ai.animation.registry import (
    NewRow,
    QuotaExceeded,
    Registered,
    RegistryError,
    count,
    find,
    get,
    register,
)
from app.db import create_db_engine

BACKEND_DIR = Path(__file__).resolve().parent.parent

requires_pg = pytest.mark.skipif(not os.getenv("PGHOST"), reason="PGHOST not configured")

OWNER_A = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
OWNER_B = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
DEFAULT_LIMITS = AnimationLimits()
ONE_ONLY = AnimationLimits(owner_max_animations=1)
QUOTA = DEFAULT_LIMITS.owner_max_animations
PASSWORD_SENTINEL = "s3cr3t-sentinel-password"

META = {"width": 1280, "height": 720, "fps": 30, "durationInFrames": 150, "pauseAtFrame": 120}
RUNTIME = {"react": "19.3.0", "remotion": "4.0.543"}


def new_row(n: int, owner: uuid.UUID = OWNER_A, **overrides: Any) -> NewRow:
    """A valid row. `n` fixes the request hash and the hashes, so equal `n` is the same request.

    The id is derived from the owner and `n`: the same request from two owners gets two ids. Pass
    `id=...` to simulate a second run of the same request that picked its own id.
    """
    source_sha = hashlib.sha256(f"source-{n}".encode()).hexdigest()
    fields: dict[str, Any] = {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"animation:{owner}:{n}")),
        "owner_id": owner,
        "request_hash": f"{n:064x}",
        "source_sha256": source_sha,
        "bundle_sha256": hashlib.sha256(f"bundle-{n}".encode()).hexdigest(),
        "s3_prefix": f"animations/v1/{source_sha[:2]}/{source_sha}/",
        "kind": "lesson",
        "meta": dict(META),
        "attempts": 2,
        "model": "gemini-3.5-flash-lite",
        "verifier_version": "0.1.0",
        "contract_version": 1,
        "runtime_version": dict(RUNTIME),
        "source_bytes": 6120,
        "bundle_bytes": 8734,
    }
    fields.update(overrides)
    return NewRow(**fields)


def stored(row: NewRow, created_at: int) -> AnimationRow:
    """What the database should hand back for `row`."""
    return AnimationRow(**dataclasses.asdict(row), created_at=created_at)


# --- database-free: statements, bind values, row mapping ----------------------------------


def test_every_read_statement_is_scoped_to_one_owner() -> None:
    for statement in (registry._FIND_SQL, registry._COUNT_SQL, registry._GET_SQL):
        assert "owner_id = :owner" in str(statement)


def test_lock_statement_takes_a_transaction_scoped_advisory_lock_on_the_owner_key() -> None:
    sql = str(registry._LOCK_SQL)
    assert "pg_advisory_xact_lock(hashtextextended(" in sql
    assert ":owner_key" in sql
    assert sql.rstrip().endswith(", 0))")


def test_insert_statement_names_every_row_field_and_nothing_else() -> None:
    sql = str(registry._INSERT_SQL)
    columns_text = re.search(r"INSERT INTO animations \((.*?)\)\s+VALUES", sql, re.DOTALL)
    assert columns_text is not None
    columns = [c.strip() for c in columns_text.group(1).split(",")]
    assert set(columns) == {f.name for f in dataclasses.fields(AnimationRow)}
    assert len(columns) == len(set(columns))

    # Each column is bound to the parameter of the same name, jsonb ones through a CAST. A swap
    # (for example `source_sha256` and `bundle_sha256`) would pass Postgres but store wrong data.
    values_text = re.search(r"VALUES \((.*?)\)\s+ON CONFLICT", sql, re.DOTALL)
    assert values_text is not None
    values = re.findall(r"CAST\(:\w+ AS jsonb\)|:\w+", values_text.group(1))
    expected = [
        f"CAST(:{c} AS jsonb)" if c in {"meta", "runtime_version"} else f":{c}" for c in columns
    ]
    assert values == expected


def test_insert_statement_keeps_the_conflict_clause_and_returns_the_row() -> None:
    sql = " ".join(str(registry._INSERT_SQL).split())
    assert "ON CONFLICT (owner_id, request_hash) DO NOTHING RETURNING *" in sql


def test_insert_params_match_the_statement_and_carry_the_row() -> None:
    row = new_row(1)
    params = registry._insert_params(row, 1_700_000_000_123)
    assert set(params) == set(registry._INSERT_SQL.compile().params)
    assert params["created_at"] == 1_700_000_000_123
    assert params["owner_id"] == OWNER_A
    assert json.loads(params["meta"]) == META
    assert json.loads(params["runtime_version"]) == RUNTIME
    for name in ("id", "request_hash", "source_sha256", "s3_prefix", "kind", "attempts"):
        assert params[name] == getattr(row, name)


def test_result_row_maps_to_animation_row_and_ignores_extra_columns() -> None:
    row = new_row(1)
    values = {**dataclasses.asdict(row), "created_at": 1_700_000_000_123, "added_later": "x"}
    assert registry._to_row(values) == stored(row, 1_700_000_000_123)


def test_result_row_accepts_an_owner_id_given_as_text() -> None:
    row = new_row(1)
    values = {**dataclasses.asdict(row), "owner_id": str(OWNER_A), "created_at": 5}
    assert registry._to_row(values).owner_id == OWNER_A


def test_registry_does_not_load_langgraph_or_boto3() -> None:
    code = (
        "import sys; import app.ai.animation.registry; "
        "bad = [m for m in ('langgraph', 'boto3', 'botocore') if m in sys.modules]; "
        "assert not bad, bad"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=BACKEND_DIR
    )
    assert done.returncode == 0, done.stderr


# --- database-free: RegistryError on a real, unreachable engine ----------------------------


def unreachable_engine() -> Engine:
    """A real engine whose server does not exist: port 1 on loopback refuses at once."""
    url = URL.create(
        "postgresql+psycopg",
        username="lore",
        password=PASSWORD_SENTINEL,
        host="127.0.0.1",
        port=1,
        database="lore",
    )
    return create_engine(url, poolclass=NullPool, connect_args={"connect_timeout": 1})


@pytest.mark.parametrize(
    "operation",
    [
        lambda e: find(e, OWNER_A, "0" * 64),
        lambda e: count(e, OWNER_A),
        lambda e: get(e, OWNER_A, str(uuid.uuid4())),
        lambda e: register(e, new_row(1), DEFAULT_LIMITS),
    ],
    ids=["find", "count", "get", "register"],
)
def test_unreachable_database_raises_registry_error_without_details(operation: Any) -> None:
    engine = unreachable_engine()
    try:
        with pytest.raises(RegistryError) as raised:
            operation(engine)
    finally:
        engine.dispose()
    error = raised.value
    assert isinstance(error.__cause__, SQLAlchemyError)
    # Operation and exception class only: no host, port, user, password, SQL or parameters.
    for secret in (PASSWORD_SENTINEL, "127.0.0.1", "lore", "SELECT", "INSERT", str(OWNER_A)):
        assert secret not in str(error)
    assert re.fullmatch(r"animation registry \w+ failed \(\w+\)", str(error))


# --- [PG]: real database -------------------------------------------------------------------


@pytest.fixture
def engine() -> Iterator[Engine]:
    """Engine on a database migrated to head with an empty `animations` table."""
    command.upgrade(Config(str(BACKEND_DIR / "alembic.ini")), "head")
    eng = create_db_engine(poolclass=NullPool)
    assert eng is not None
    _reset(eng)
    try:
        yield eng
    finally:
        eng.dispose()


def _reset(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE animations"))


def _seed(engine: Engine, owner: uuid.UUID, rows: int, *, first: int = 1_000) -> None:
    """Insert `rows` rows for `owner` straight into the table, independent of `register`."""
    batch = []
    for n in range(first, first + rows):
        row = new_row(n, owner)
        batch.append(
            {
                **dataclasses.asdict(row),
                "meta": json.dumps(row.meta),
                "runtime_version": json.dumps(row.runtime_version),
                "created_at": n,
            }
        )
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
            batch,
        )


def _total(engine: Engine) -> int:
    with engine.connect() as conn:
        return int(conn.execute(text("SELECT count(*) FROM animations")).scalar_one())


def _race(engine: Engine, rows: list[NewRow], limits: AnimationLimits) -> list[Any]:
    """Run `register` for every row on its own thread and connection, released together."""
    barrier = threading.Barrier(len(rows))

    def run(row: NewRow) -> Registered | QuotaExceeded:
        barrier.wait(timeout=10)
        return register(engine, row, limits)

    with ThreadPoolExecutor(max_workers=len(rows)) as pool:
        futures = [pool.submit(run, row) for row in rows]
        return [future.result(timeout=30) for future in futures]


@requires_pg
def test_register_inserts_a_new_row_and_stamps_milliseconds(engine: Engine) -> None:
    row = new_row(1)
    before = time.time_ns() // 1_000_000
    result = register(engine, row, DEFAULT_LIMITS)
    after = time.time_ns() // 1_000_000

    assert isinstance(result, Registered)
    assert result.created is True
    assert before <= result.row.created_at <= after
    assert result.row == stored(row, result.row.created_at)
    assert find(engine, OWNER_A, row.request_hash) == result.row
    assert get(engine, OWNER_A, row.id) == result.row
    assert count(engine, OWNER_A) == 1


@requires_pg
def test_same_request_again_returns_the_first_row_and_adds_nothing(engine: Engine) -> None:
    first = register(engine, new_row(1), DEFAULT_LIMITS)
    assert isinstance(first, Registered)

    other_id = str(uuid.uuid4())
    again = register(
        engine,
        new_row(1, id=other_id, bundle_sha256="ab" * 32, attempts=4),
        DEFAULT_LIMITS,
    )

    assert isinstance(again, Registered)
    assert again.created is False
    assert again.row == first.row
    assert again.row.id != other_id
    assert _total(engine) == 1


@requires_pg
def test_find_count_and_get_never_cross_owners(engine: Engine) -> None:
    mine = register(engine, new_row(1, OWNER_A), DEFAULT_LIMITS)
    assert isinstance(mine, Registered)

    assert find(engine, OWNER_B, mine.row.request_hash) is None
    assert get(engine, OWNER_B, mine.row.id) is None
    assert count(engine, OWNER_B) == 0
    assert get(engine, OWNER_A, str(uuid.uuid4())) is None
    assert find(engine, OWNER_A, "f" * 64) is None


@requires_pg
def test_same_request_from_another_owner_is_a_new_row(engine: Engine) -> None:
    a = register(engine, new_row(1, OWNER_A), DEFAULT_LIMITS)
    b = register(engine, new_row(1, OWNER_B), DEFAULT_LIMITS)

    assert isinstance(a, Registered) and isinstance(b, Registered)
    assert a.created is True and b.created is True
    assert a.row.id != b.row.id
    assert a.row.request_hash == b.row.request_hash
    assert count(engine, OWNER_A) == 1 and count(engine, OWNER_B) == 1


@requires_pg
def test_quota_of_one_refuses_the_next_different_request_and_writes_nothing(
    engine: Engine,
) -> None:
    assert isinstance(register(engine, new_row(1), ONE_ONLY), Registered)

    refused = register(engine, new_row(2), ONE_ONLY)

    assert isinstance(refused, QuotaExceeded)
    assert count(engine, OWNER_A) == 1
    assert find(engine, OWNER_A, new_row(2).request_hash) is None


@requires_pg
def test_quota_counts_only_the_owners_own_rows(engine: Engine) -> None:
    assert isinstance(register(engine, new_row(1, OWNER_A), ONE_ONLY), Registered)

    other = register(engine, new_row(1, OWNER_B), ONE_ONLY)

    assert isinstance(other, Registered)
    assert other.created is True


@requires_pg
def test_quota_does_not_apply_to_an_idempotent_hit(engine: Engine) -> None:
    first = register(engine, new_row(1), ONE_ONLY)
    assert isinstance(first, Registered)
    # The owner is now exactly at the quota; the same request must still be answered.
    again = register(engine, new_row(1, id=str(uuid.uuid4())), ONE_ONLY)

    assert isinstance(again, Registered)
    assert again.created is False
    assert again.row.id == first.row.id


@requires_pg
def test_default_quota_is_200_rows(engine: Engine) -> None:
    _seed(engine, OWNER_A, QUOTA - 1)
    assert isinstance(register(engine, new_row(1), DEFAULT_LIMITS), Registered)
    assert count(engine, OWNER_A) == QUOTA
    assert isinstance(register(engine, new_row(2), DEFAULT_LIMITS), QuotaExceeded)
    assert count(engine, OWNER_A) == QUOTA


@requires_pg
def test_two_identical_concurrent_requests_at_199_rows_share_one_animation(
    engine: Engine,
) -> None:
    for round_number in range(5):
        _reset(engine)
        _seed(engine, OWNER_A, QUOTA - 1)
        rows = [
            new_row(1, id=str(uuid.uuid4())),
            new_row(1, id=str(uuid.uuid4())),
        ]

        results = _race(engine, rows, DEFAULT_LIMITS)

        assert all(isinstance(r, Registered) for r in results), round_number
        assert len({r.row.id for r in results}) == 1, round_number
        assert sorted(r.created for r in results) == [False, True], round_number
        assert count(engine, OWNER_A) == QUOTA, round_number


@requires_pg
def test_two_different_concurrent_requests_at_199_rows_let_exactly_one_in(
    engine: Engine,
) -> None:
    for round_number in range(5):
        _reset(engine)
        _seed(engine, OWNER_A, QUOTA - 1)

        results = _race(engine, [new_row(1), new_row(2)], DEFAULT_LIMITS)

        registered = [r for r in results if isinstance(r, Registered)]
        refused = [r for r in results if isinstance(r, QuotaExceeded)]
        assert len(registered) == 1 and len(refused) == 1, round_number
        assert registered[0].created is True, round_number
        assert count(engine, OWNER_A) == QUOTA, round_number


@requires_pg
def test_concurrent_requests_of_different_owners_do_not_block_each_other(
    engine: Engine,
) -> None:
    results = _race(engine, [new_row(1, OWNER_A), new_row(1, OWNER_B)], ONE_ONLY)

    assert all(isinstance(r, Registered) and r.created for r in results)
    assert _total(engine) == 2


@requires_pg
def test_register_waits_for_the_owners_advisory_lock_but_other_owners_do_not(
    engine: Engine,
) -> None:
    holder = engine.connect()
    try:
        holder.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": str(OWNER_A)},
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            try:
                blocked = pool.submit(register, engine, new_row(1, OWNER_A), DEFAULT_LIMITS)
                free = pool.submit(register, engine, new_row(1, OWNER_B), DEFAULT_LIMITS)
                assert isinstance(free.result(timeout=10), Registered)

                # Wait until Postgres itself reports a session waiting for an advisory lock.
                deadline = time.monotonic() + 10
                waiting = 0
                while waiting == 0 and time.monotonic() < deadline:
                    waiting = holder.execute(
                        text(
                            "SELECT count(*) FROM pg_locks "
                            "WHERE locktype = 'advisory' AND NOT granted"
                        )
                    ).scalar_one()
                    if waiting == 0:
                        time.sleep(0.02)
                assert waiting == 1
                assert not blocked.done()
                with pytest.raises(FutureTimeout):
                    blocked.result(timeout=0.2)
            finally:
                holder.rollback()  # ends the transaction, which releases the xact lock
            assert isinstance(blocked.result(timeout=10), Registered)
    finally:
        holder.close()
    assert count(engine, OWNER_A) == 1


@requires_pg
def test_a_row_postgres_rejects_is_a_registry_error_and_leaves_the_lock_free(
    engine: Engine,
) -> None:
    with pytest.raises(RegistryError) as raised:
        register(engine, new_row(1, attempts=5), DEFAULT_LIMITS)

    assert isinstance(raised.value.__cause__, SQLAlchemyError)
    assert count(engine, OWNER_A) == 0
    # The failed transaction rolled back, so the same owner can register straight away.
    assert isinstance(register(engine, new_row(1), DEFAULT_LIMITS), Registered)
