"""Router for /api/v1/projects: endpoints, DB engine, rate limits, body limits, storage caps.

Why: keeps HTTP concerns (limits, owner, 503 without a database) in one place next to the data
access they guard. The client address is request.client.host;
uvicorn (--proxy-headers) already resolves X-Forwarded-For from the trusted proxy, and the
application must not parse that header itself (the left-most entry is client-controlled).
"""

from __future__ import annotations

import enum
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import DataError

from app.models import (
    CampaignStateUpdate,
    ImportRejection,
    ImportRequest,
    ImportResponse,
    ProjectCreate,
    ProjectResponse,
    ProjectSummaryResponse,
    StateConflictResponse,
)
from app.owner import get_owner_id
from app.ratelimit import RateLimiter

RETRY_AFTER_SECONDS = 60


@dataclass(frozen=True)
class Limits:
    """Body size limits and storage caps (FR-7.1, FR-7.3). Tests replace app.state.limits.

    Sizes are decimal bytes, matching Caddy's `max_size 5MB` (5,000,000 bytes). The body limits
    rest on the ~170 KB per-project estimate in design.md, which T0 has not measured yet.
    """

    create_body_bytes: int = 2_000_000  # TODO(T0): sesuaikan setelah pengukuran
    import_body_bytes: int = 5_000_000  # TODO(T0): sesuaikan setelah pengukuran
    state_body_bytes: int = 500_000  # TODO(T0): sesuaikan setelah pengukuran
    owner_max_projects: int = 100  # TODO(T0): sesuaikan setelah pengukuran
    owner_max_bytes: int = 50_000_000  # TODO(T0): sesuaikan setelah pengukuran
    global_max_projects: int = 10_000  # TODO(T0): sesuaikan setelah pengukuran


DEFAULT_LIMITS = Limits()


def get_limits(request: Request) -> Limits:
    return getattr(request.app.state, "limits", DEFAULT_LIMITS)


def _payload_too_large() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="request body too large"
    )


def _body_reader(field: str) -> Callable[[Request], Awaitable[bytes]]:
    """Dependency that reads the raw body and stops as soon as it passes the limit.

    The endpoint must not declare a body model: FastAPI reads a declared body before it runs
    any dependency, which would defeat the limit. Content-Length is checked first; a chunked
    body without it is counted while streaming, so a missing header cannot bypass the cap.
    """

    async def read(request: Request) -> bytes:
        limit = getattr(get_limits(request), field)
        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                declared_size = int(declared)
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail="invalid Content-Length"
                ) from None
            if declared_size > limit:
                raise _payload_too_large()
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > limit:
                raise _payload_too_large()
        return bytes(body)

    return read


def _parse[M: BaseModel](model: type[M], raw: bytes) -> M:
    """Validate a raw JSON body; errors keep FastAPI's 422 shape (loc starts with "body")."""
    try:
        return model.model_validate_json(raw)
    except ValidationError as exc:
        errors = exc.errors(include_url=False, include_context=False)
        raise RequestValidationError(
            [{**err, "loc": ("body", *err["loc"])} for err in errors]
        ) from None


CreateBody = Annotated[bytes, Depends(_body_reader("create_body_bytes"))]
ImportBody = Annotated[bytes, Depends(_body_reader("import_body_bytes"))]
StateBody = Annotated[bytes, Depends(_body_reader("state_body_bytes"))]
LimitsDep = Annotated[Limits, Depends(get_limits)]
router = APIRouter(prefix="/api/v1/projects", tags=["projects"])


def _too_many_requests() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="rate limit exceeded",
        headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
    )


def get_limiter(request: Request) -> RateLimiter:
    limiter = request.app.state.rate_limiter
    assert limiter is not None
    return limiter


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def limit_ip(request: Request, limiter: Annotated[RateLimiter, Depends(get_limiter)]) -> None:
    """Per-IP limit for every projects endpoint (checked first)."""
    if not limiter.check_ip(client_ip(request)):
        raise _too_many_requests()


def limit_owner_write(
    request: Request,
    owner_id: Annotated[uuid.UUID, Depends(get_owner_id)],
    limiter: Annotated[RateLimiter, Depends(get_limiter)],
) -> None:
    """Per-owner write limit (POST, DELETE, PUT state)."""
    if not limiter.check_owner_write(str(owner_id)):
        raise _too_many_requests()


def limit_import(request: Request, limiter: Annotated[RateLimiter, Depends(get_limiter)]) -> None:
    """Heavy-operation limit for the bulk import."""
    if not limiter.check_import(client_ip(request)):
        raise _too_many_requests()


def limit_daily_create(
    request: Request, limiter: Annotated[RateLimiter, Depends(get_limiter)]
) -> None:
    """Per-IP daily quota for project creation."""
    if not limiter.check_daily_create(client_ip(request)):
        raise _too_many_requests()


def get_engine(request: Request) -> Engine:
    """The app's DB engine, or 503 when the database is not configured."""
    engine = getattr(request.app.state, "db_engine", None)
    if not isinstance(engine, Engine):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database not configured",
        )
    return engine


EngineDep = Annotated[Engine, Depends(get_engine)]
OwnerDep = Annotated[uuid.UUID, Depends(get_owner_id)]

# Dependency order is the limit order: per-IP, then per-owner (or import), then the daily quota,
# then the engine. A request refused early does not consume later budgets.
_READ = [Depends(limit_ip), Depends(get_engine)]
_WRITE = [Depends(limit_ip), Depends(limit_owner_write), Depends(get_engine)]
_CREATE = [
    Depends(limit_ip),
    Depends(limit_owner_write),
    Depends(limit_daily_create),
    Depends(get_engine),
]
_IMPORT = [Depends(limit_ip), Depends(limit_import), Depends(get_engine)]


def _not_found() -> HTTPException:
    # One body for "missing" and "not yours", so a caller cannot tell them apart.
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="project not found")


_LIST_SQL = text(
    "SELECT id, title, genre, source_name, updated_at, stories_total, stories_completed "
    "FROM projects WHERE owner_id = :owner_id ORDER BY updated_at DESC"
)
_GET_SQL = text(
    "SELECT p.id, p.created_at, p.updated_at, p.source, p.campaign, p.materials, "
    "ps.campaign_state FROM projects p "
    "LEFT JOIN project_state ps ON ps.project_id = p.id "
    "WHERE p.id = :id AND p.owner_id = :owner_id"
)
_GET_STORIES_SQL = text("SELECT story_id, blueprint FROM project_stories WHERE project_id = :id")
_DELETE_SQL = text("DELETE FROM projects WHERE id = :id AND owner_id = :owner_id")

# Create/import upsert. The WHERE makes the update conditional on ownership and on a strictly
# newer copy: an older or same-version copy (equal updated_at) and a foreign row are left alone
# (no row returned). xmax = 0 marks a freshly inserted row. stories_completed is not taken from
# the request; _SYNC_COMPLETED_SQL derives it from the stored state afterwards.
_UPSERT_PROJECT_SQL = text(
    """
    INSERT INTO projects (id, owner_id, created_at, updated_at, source, campaign, materials,
                          title, genre, source_name, stories_total, stories_completed,
                          schema_version)
    VALUES (:id, :owner_id, :created_at, :updated_at, CAST(:source AS jsonb),
            CAST(:campaign AS jsonb), CAST(:materials AS jsonb), :title, :genre, :source_name,
            jsonb_array_length(CAST(:campaign AS jsonb) -> 'story_sequence'), 0, 1)
    ON CONFLICT (id) DO UPDATE
    SET campaign = EXCLUDED.campaign,
        materials = EXCLUDED.materials,
        updated_at = EXCLUDED.updated_at,
        source = EXCLUDED.source,
        title = EXCLUDED.title,
        genre = EXCLUDED.genre,
        source_name = EXCLUDED.source_name,
        stories_total = EXCLUDED.stories_total
    WHERE projects.owner_id = EXCLUDED.owner_id
      AND projects.updated_at < EXCLUDED.updated_at
    RETURNING (xmax = 0) AS inserted
    """
)
# The list's progress count always mirrors the stored state, whichever copy of it won.
_SYNC_COMPLETED_SQL = text(
    """
    UPDATE projects SET stories_completed = coalesce(
        (SELECT jsonb_array_length(campaign_state -> 'completed_stories')
         FROM project_state WHERE project_id = :id), 0)
    WHERE id = :id
    """
)
_OWNER_OF_SQL = text("SELECT owner_id FROM projects WHERE id = :id")
_DELETE_STORIES_SQL = text("DELETE FROM project_stories WHERE project_id = :id")
_INSERT_STORY_SQL = text(
    "INSERT INTO project_stories (project_id, story_id, blueprint) "
    "VALUES (:id, :story_id, CAST(:blueprint AS jsonb))"
)
# Same rule as PUT state: never overwrite newer stored progress.
_UPSERT_STATE_SQL = text(
    """
    INSERT INTO project_state (project_id, campaign_state, updated_at)
    VALUES (:id, CAST(:campaign_state AS jsonb), :updated_at)
    ON CONFLICT (project_id) DO UPDATE
    SET campaign_state = EXCLUDED.campaign_state, updated_at = EXCLUDED.updated_at
    WHERE project_state.updated_at <= EXCLUDED.updated_at
    """
)
_OWNED_SQL = text("SELECT 1 FROM projects WHERE id = :id AND owner_id = :owner_id")
_STATE_UPDATED_AT_SQL = text("SELECT updated_at FROM project_state WHERE project_id = :id")
# projects.updated_at only moves forward: it orders the list and feeds the client's sync check.
_TOUCH_PROJECT_SQL = text(
    "UPDATE projects SET stories_completed = :stories_completed, "
    "updated_at = GREATEST(updated_at, :updated_at) "
    "WHERE id = :id AND owner_id = :owner_id"
)
_OWNER_COUNT_SQL = text("SELECT count(*) FROM projects WHERE owner_id = :owner_id")
_GLOBAL_COUNT_SQL = text("SELECT count(*) FROM projects")
# Per-owner stored size, as in design.md "Storage caps".
_OWNER_BYTES_SQL = text(
    """
    SELECT coalesce(sum(octet_length(campaign::text)
                        + coalesce(octet_length(materials::text), 0)), 0)
         + (SELECT coalesce(sum(octet_length(blueprint::text)), 0) FROM project_stories
            WHERE project_id IN (SELECT id FROM projects WHERE owner_id = :owner_id))
    FROM projects WHERE owner_id = :owner_id
    """
)


def _cap_error(
    conn: Connection, body: ProjectCreate, owner_id: uuid.UUID, limits: Limits
) -> str | None:
    """Return why a new project would exceed a storage cap, or None (FR-7.3).

    Only a new id is counted. An existing id is either the caller's own (replaced in place) or
    another owner's (409 / skipped), and neither adds a row.
    """
    if body.id and conn.execute(_OWNER_OF_SQL, {"id": body.id}).first() is not None:
        return None
    if conn.execute(_OWNER_COUNT_SQL, {"owner_id": owner_id}).scalar_one() >= (
        limits.owner_max_projects
    ):
        return f"project limit reached ({limits.owner_max_projects} per device)"
    incoming = sum(
        len((_dump(part) or "").encode("utf-8"))
        for part in (body.campaign, body.materials, *body.stories.values())
    )
    stored = conn.execute(_OWNER_BYTES_SQL, {"owner_id": owner_id}).scalar_one()
    if stored + incoming > limits.owner_max_bytes:
        return "storage limit reached for this device"
    if conn.execute(_GLOBAL_COUNT_SQL).scalar_one() >= limits.global_max_projects:
        return "server project limit reached"
    return None


def _cap_exceeded(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=message)


class UpsertOutcome(enum.Enum):
    INSERTED = "inserted"  # new row
    UPDATED = "updated"  # caller's own row, incoming updated_at strictly newer
    UNCHANGED = "unchanged"  # caller's own row, stored copy is newer or the same version
    FOREIGN = "foreign"  # id belongs to another owner, or to a row without owner


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _dump(value: Any) -> str | None:
    return None if value is None else json.dumps(value, ensure_ascii=False)


def upsert_project(conn: Connection, body: ProjectCreate, owner_id: uuid.UUID) -> UpsertOutcome:
    """Write one project, its stories and optional state inside the caller's transaction.

    Returns the outcome and leaves the id in body.id. Raises nothing on a collision: the caller
    maps FOREIGN to 409 (create) or to a skipped count (import).
    """
    now = _now_ms()
    project_id = body.id or str(uuid.uuid4())
    updated_at = body.updated_at if body.updated_at is not None else now
    created_at = body.created_at if body.created_at is not None else updated_at
    body.id, body.created_at, body.updated_at = project_id, created_at, updated_at

    row = conn.execute(
        _UPSERT_PROJECT_SQL,
        {
            "id": project_id,
            "owner_id": owner_id,
            "created_at": created_at,
            "updated_at": updated_at,
            "source": _dump(body.source.model_dump()),
            "campaign": _dump(body.campaign),
            "materials": _dump(body.materials),
            "title": body.campaign["title"],
            "genre": body.campaign["genre"],
            "source_name": body.source.file_name,
        },
    ).first()

    if row is None:
        stored_owner = conn.execute(_OWNER_OF_SQL, {"id": project_id}).scalar_one_or_none()
        return UpsertOutcome.UNCHANGED if stored_owner == owner_id else UpsertOutcome.FOREIGN

    conn.execute(_DELETE_STORIES_SQL, {"id": project_id})
    for story_id, blueprint in body.stories.items():
        conn.execute(
            _INSERT_STORY_SQL,
            {"id": project_id, "story_id": story_id, "blueprint": _dump(blueprint)},
        )
    if body.campaign_state is not None:
        conn.execute(
            _UPSERT_STATE_SQL,
            {
                "id": project_id,
                "campaign_state": _dump(body.campaign_state),
                "updated_at": updated_at,
            },
        )
    conn.execute(_SYNC_COMPLETED_SQL, {"id": project_id})
    return UpsertOutcome.INSERTED if row.inserted else UpsertOutcome.UPDATED


def _load_project(conn: Connection, project_id: str, owner_id: uuid.UUID) -> ProjectResponse | None:
    row = conn.execute(_GET_SQL, {"id": project_id, "owner_id": owner_id}).mappings().first()
    if row is None:
        return None
    stories = conn.execute(_GET_STORIES_SQL, {"id": project_id}).all()
    return ProjectResponse(
        **dict(row),
        stories={story_id: blueprint for story_id, blueprint in stories},
    )


@router.get("", dependencies=_READ)
def list_projects(engine: EngineDep, owner_id: OwnerDep) -> list[ProjectSummaryResponse]:
    """Summaries only: the query never touches campaign, stories or state (NFR-2.1)."""
    with engine.connect() as conn:
        rows = conn.execute(_LIST_SQL, {"owner_id": owner_id}).mappings().all()
    return [ProjectSummaryResponse.model_validate(dict(row)) for row in rows]


@router.post("", dependencies=_CREATE, status_code=status.HTTP_201_CREATED)
def create_project(
    raw: CreateBody,
    response: Response,
    engine: EngineDep,
    owner_id: OwnerDep,
    limits: LimitsDep,
) -> ProjectResponse:
    """201 for a new row; 200 with the stored project when the caller already owns the id."""
    body = _parse(ProjectCreate, raw)
    with engine.begin() as conn:
        cap = _cap_error(conn, body, owner_id, limits)
        if cap is not None:
            raise _cap_exceeded(cap)
        outcome = upsert_project(conn, body, owner_id)
        if outcome is UpsertOutcome.FOREIGN:
            # Raised inside the block, so the transaction rolls back. Nothing about the
            # other owner goes into the body.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="project id already in use"
            )
        assert body.id is not None
        project = _load_project(conn, body.id, owner_id)
    assert project is not None
    if outcome is not UpsertOutcome.INSERTED:
        response.status_code = status.HTTP_200_OK
    return project


@router.post("/import", dependencies=_IMPORT)
def import_projects(
    raw: ImportBody, engine: EngineDep, owner_id: OwnerDep, limits: LimitsDep
) -> ImportResponse:
    """Per-item validation and one transaction per project, so one bad item blocks nothing.

    imported: rows written (new, or the caller's own row replaced by a strictly newer copy).
    skipped: rows not written (stored copy is newer or the same version, or the id belongs to
    another owner).
    rejected: items that failed validation, would exceed a storage cap, or that the database
    refused as invalid data. The remaining items are still processed.
    """
    body = _parse(ImportRequest, raw)
    imported = skipped = 0
    rejected: list[ImportRejection] = []
    for index, item in enumerate(body.projects):
        raw_id = item.get("id") if isinstance(item, dict) else None
        item_id = raw_id if isinstance(raw_id, str) else None
        try:
            project = ProjectCreate.model_validate(item)
        except ValidationError as exc:
            rejected.append(ImportRejection(index=index, id=item_id, error=_errors(exc)))
            continue
        try:
            with engine.begin() as conn:
                cap = _cap_error(conn, project, owner_id, limits)
                if cap is None:
                    outcome = upsert_project(conn, project, owner_id)
        except DataError:
            rejected.append(ImportRejection(index=index, id=item_id, error="invalid data"))
            continue
        if cap is not None:
            rejected.append(ImportRejection(index=index, id=item_id, error=cap))
        elif outcome in (UpsertOutcome.INSERTED, UpsertOutcome.UPDATED):
            imported += 1
        else:
            skipped += 1
    return ImportResponse(imported=imported, skipped=skipped, rejected=rejected)


def _errors(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in err['loc']) or 'project'}: {err['msg']}" for err in exc.errors()
    )


@router.get("/{project_id}", dependencies=_READ)
def get_project(project_id: str, engine: EngineDep, owner_id: OwnerDep) -> ProjectResponse:
    """Full project; campaign_state is returned as stored, the client's Zod decides on it."""
    with engine.connect() as conn:
        project = _load_project(conn, project_id, owner_id)
    if project is None:
        raise _not_found()
    return project


@router.delete("/{project_id}", dependencies=_WRITE, status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, engine: EngineDep, owner_id: OwnerDep) -> Response:
    """Owner-filtered delete; stories and state go with it through ON DELETE CASCADE."""
    with engine.begin() as conn:
        result = conn.execute(_DELETE_SQL, {"id": project_id, "owner_id": owner_id})
    if result.rowcount == 0:
        raise _not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{project_id}/state", dependencies=_WRITE, response_model=None)
def put_state(
    project_id: str, raw: StateBody, engine: EngineDep, owner_id: OwnerDep
) -> dict[str, int] | JSONResponse:
    """Ownership first (404), then one atomic upsert whose WHERE rejects stale writes (409)."""
    body = _parse(CampaignStateUpdate, raw)
    with engine.begin() as conn:
        owned = conn.execute(_OWNED_SQL, {"id": project_id, "owner_id": owner_id}).first()
        if owned is None:
            raise _not_found()
        result = conn.execute(
            _UPSERT_STATE_SQL,
            {
                "id": project_id,
                "campaign_state": _dump(body.campaign_state),
                "updated_at": body.updated_at,
            },
        )
        if result.rowcount == 0:
            # Nothing was written, so there is nothing to roll back; projects stays untouched.
            stored = conn.execute(_STATE_UPDATED_AT_SQL, {"id": project_id}).scalar_one()
            conflict = StateConflictResponse(detail="stale state", stored_updated_at=stored)
            return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=conflict.model_dump())
        conn.execute(
            _TOUCH_PROJECT_SQL,
            {
                "id": project_id,
                "owner_id": owner_id,
                "stories_completed": len(body.campaign_state["completed_stories"]),
                "updated_at": body.updated_at,
            },
        )
    return {"updated_at": body.updated_at}
