"""Animation_Registry: per-owner rows of the `animations` table (find, count, get, register).

Why: the registry is what makes a generation request idempotent and bounded. It answers "does this
owner already have this request?" without touching Gemini, Lambda or S3 (Requirement 18.3), and it
caps how many animations one owner can hold (Requirement 20.5). Both rules must stay true when two
requests arrive together, so `register` does everything in one transaction behind a per-owner
advisory lock (Requirement 20.8, design 6.9, D-9, D-11).

How `register` decides, in order, inside one `engine.begin()` transaction:

1. `pg_advisory_xact_lock(hashtextextended(owner, 0))` serialises writers of the same owner. The
   lock is released at commit or rollback, so nothing can leak it. Other owners do not wait.
2. Look the request up by `(owner_id, request_hash)`. A row found here is returned as
   `Registered(row, created=False)` and the quota is NOT checked (Requirements 18.8 and 20.8): an
   owner at 200 rows can still be answered from a row it already has. The lock is what makes two
   identical concurrent requests end with the same `animation_id` (Requirement 18.4, 18.9).
3. Count the owner's rows. `>= owner_max_animations` is `QuotaExceeded`; nothing is written. The
   count and the insert run under the same lock, so two different requests at 199 rows cannot both
   pass (Requirement 20.9).
4. `INSERT ... ON CONFLICT (owner_id, request_hash) DO NOTHING RETURNING *`. With the lock a
   conflict should not happen; if it does, the surviving row is read back instead of failing
   (Requirement 20.4).

`find`, `count`, `get` and `register` are synchronous and meant for `asyncio.to_thread`. Every
statement filters by `owner_id`, so one owner can never see another owner's row (Requirement 18.6).

Errors: any `SQLAlchemyError` (including a refused connection or a `DB_CONNECT_TIMEOUT`) becomes
`RegistryError`, which the endpoint turns into 503 `ANIMATION_STORAGE_FAILED` before the stream or
an `error` event after it (Requirement 20.7). This is the one place a function here raises, because
the design fixes the signatures (`find` returns `AnimationRow | None`, `register` returns
`Registered | QuotaExceeded`) and has the callers catch `RegistryError`. The message holds only the
operation and the exception class name, never SQL text, parameters or connection details.

`created_at` is epoch milliseconds, stamped here like `projects.py` does. This module must not
import `langgraph` or `boto3` (Requirement 41.1).
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import Engine, text
from sqlalchemy.exc import SQLAlchemyError

from app.ai.animation.limits import AnimationLimits
from app.ai.animation.models import AnimationRow

_FIND_SQL = text("SELECT * FROM animations WHERE owner_id = :owner AND request_hash = :hash")
_COUNT_SQL = text("SELECT count(*) FROM animations WHERE owner_id = :owner")
_GET_SQL = text("SELECT * FROM animations WHERE id = :id AND owner_id = :owner")
# The explicit CAST keeps the argument typed as text whatever the driver sends for a string.
_LOCK_SQL = text("SELECT pg_advisory_xact_lock(hashtextextended(CAST(:owner_key AS text), 0))")
# Bind names equal column names, so `_insert_params` and this statement can be checked against
# each other (and against `AnimationRow`) without a database.
_INSERT_SQL = text(
    """
    INSERT INTO animations (id, owner_id, request_hash, source_sha256, bundle_sha256, s3_prefix,
                            kind, meta, attempts, model, verifier_version, contract_version,
                            runtime_version, source_bytes, bundle_bytes, created_at)
    VALUES (:id, :owner_id, :request_hash, :source_sha256, :bundle_sha256, :s3_prefix,
            :kind, CAST(:meta AS jsonb), :attempts, :model, :verifier_version, :contract_version,
            CAST(:runtime_version AS jsonb), :source_bytes, :bundle_bytes, :created_at)
    ON CONFLICT (owner_id, request_hash) DO NOTHING
    RETURNING *
    """
)


class RegistryError(Exception):
    """The registry could not be read or written (database error or no connection)."""


@dataclass(frozen=True)
class NewRow:
    """An animation to record: every column of `AnimationRow` except `created_at`.

    The registry stamps `created_at`. `id` is chosen by the caller (a lowercase UUID string); if
    the same `(owner_id, request_hash)` is already recorded, that row wins and this `id` is not
    stored. `s3_prefix` must be `animations/v1/<first two hex of source_sha256>/<source_sha256>/`;
    Postgres rejects anything else (Requirement 20.11), which surfaces as `RegistryError`.
    """

    id: str
    owner_id: uuid.UUID
    request_hash: str
    source_sha256: str
    bundle_sha256: str
    s3_prefix: str
    kind: Literal["lesson", "puzzle"]
    meta: dict[str, Any]
    attempts: int
    model: str
    verifier_version: str
    contract_version: int
    runtime_version: dict[str, str]
    source_bytes: int
    bundle_bytes: int


@dataclass(frozen=True)
class Registered:
    """The row that now stands for the request.

    `created` is True when this call inserted it and False when it was already there (an
    Idempotent_Hit, or a race that another run won). Callers use `row`, never their own `NewRow`,
    to build the reference they return (Requirement 18.9).
    """

    row: AnimationRow
    created: bool


@dataclass(frozen=True)
class QuotaExceeded:
    """The owner already holds `owner_max_animations` rows and the request is not a repeat."""


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _fail(operation: str, exc: Exception) -> RegistryError:
    """A `RegistryError` that names the operation and the exception class, nothing else."""
    return RegistryError(f"animation registry {operation} failed ({type(exc).__name__})")


def _as_uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _to_row(values: Mapping[str, Any]) -> AnimationRow:
    """Build an `AnimationRow` from a result row; columns it does not know are ignored."""
    return AnimationRow(
        id=values["id"],
        owner_id=_as_uuid(values["owner_id"]),
        request_hash=values["request_hash"],
        source_sha256=values["source_sha256"],
        bundle_sha256=values["bundle_sha256"],
        s3_prefix=values["s3_prefix"],
        kind=values["kind"],
        meta=dict(values["meta"]),
        attempts=values["attempts"],
        model=values["model"],
        verifier_version=values["verifier_version"],
        contract_version=values["contract_version"],
        runtime_version=dict(values["runtime_version"]),
        source_bytes=values["source_bytes"],
        bundle_bytes=values["bundle_bytes"],
        created_at=values["created_at"],
    )


def _insert_params(row: NewRow, created_at: int) -> dict[str, Any]:
    """Bind values for `_INSERT_SQL`: jsonb columns go in as JSON text, like `projects.py`."""
    return {
        "id": row.id,
        "owner_id": row.owner_id,
        "request_hash": row.request_hash,
        "source_sha256": row.source_sha256,
        "bundle_sha256": row.bundle_sha256,
        "s3_prefix": row.s3_prefix,
        "kind": row.kind,
        "meta": json.dumps(row.meta),
        "attempts": row.attempts,
        "model": row.model,
        "verifier_version": row.verifier_version,
        "contract_version": row.contract_version,
        "runtime_version": json.dumps(row.runtime_version),
        "source_bytes": row.source_bytes,
        "bundle_bytes": row.bundle_bytes,
        "created_at": created_at,
    }


def _select_one(
    engine: Engine, operation: str, statement: Any, params: Mapping[str, Any]
) -> AnimationRow | None:
    try:
        with engine.connect() as conn:
            found = conn.execute(statement, params).mappings().first()
    except SQLAlchemyError as exc:
        raise _fail(operation, exc) from exc
    return None if found is None else _to_row(found)


def find(engine: Engine, owner: uuid.UUID, request_hash: str) -> AnimationRow | None:
    """The owner's row for `request_hash`, or None. This is the Idempotent_Hit lookup."""
    return _select_one(engine, "find", _FIND_SQL, {"owner": owner, "hash": request_hash})


def count(engine: Engine, owner: uuid.UUID) -> int:
    """How many rows the owner holds (other owners' rows are never counted)."""
    try:
        with engine.connect() as conn:
            return int(conn.execute(_COUNT_SQL, {"owner": owner}).scalar_one())
    except SQLAlchemyError as exc:
        raise _fail("count", exc) from exc


def get(engine: Engine, owner: uuid.UUID, animation_id: str) -> AnimationRow | None:
    """The owner's row with this `id`, or None. A row of another owner is None too."""
    return _select_one(engine, "get", _GET_SQL, {"id": animation_id, "owner": owner})


def register(engine: Engine, row: NewRow, limits: AnimationLimits) -> Registered | QuotaExceeded:
    """Record `row` for its owner, or return the row already recorded, or `QuotaExceeded`.

    One transaction, serialised per owner (see the module docstring). Raises `RegistryError` on
    any database failure; nothing is written in that case because the transaction rolls back.
    """
    owner = row.owner_id
    try:
        with engine.begin() as conn:
            conn.execute(_LOCK_SQL, {"owner_key": str(owner)})
            existing = (
                conn.execute(_FIND_SQL, {"owner": owner, "hash": row.request_hash})
                .mappings()
                .first()
            )
            if existing is not None:
                return Registered(_to_row(existing), created=False)
            if conn.execute(_COUNT_SQL, {"owner": owner}).scalar_one() >= (
                limits.owner_max_animations
            ):
                return QuotaExceeded()
            inserted = conn.execute(_INSERT_SQL, _insert_params(row, _now_ms())).mappings().first()
            if inserted is not None:
                return Registered(_to_row(inserted), created=True)
            # Safety net: the conflict clause fired although the lock should have prevented it.
            survivor = (
                conn.execute(_FIND_SQL, {"owner": owner, "hash": row.request_hash})
                .mappings()
                .first()
            )
            if survivor is None:
                raise RegistryError("animation registry register failed (no surviving row)")
            return Registered(_to_row(survivor), created=False)
    except SQLAlchemyError as exc:
        raise _fail("register", exc) from exc
