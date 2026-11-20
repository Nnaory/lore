"""Router for /api/v1/projects: routing, DB engine and rate-limit wiring.

Why: keeps HTTP concerns (limits, owner, 503 without a database) in one place so the endpoint
bodies added in later tasks only contain data access. The client address is request.client.host;
uvicorn (--proxy-headers) already resolves X-Forwarded-For from the trusted proxy, and the
application must not parse that header itself (the left-most entry is client-controlled).
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import Engine

from app.owner import get_owner_id
from app.ratelimit import RateLimiter

RETRY_AFTER_SECONDS = 60

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


def _not_implemented() -> HTTPException:
    return HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="not implemented")


@router.get("", dependencies=_READ)
def list_projects(engine: EngineDep, owner_id: OwnerDep) -> None:
    raise _not_implemented()


@router.post("", dependencies=_CREATE, status_code=status.HTTP_201_CREATED)
def create_project(engine: EngineDep, owner_id: OwnerDep) -> None:
    raise _not_implemented()


@router.post("/import", dependencies=_IMPORT)
def import_projects(engine: EngineDep, owner_id: OwnerDep) -> None:
    raise _not_implemented()


@router.get("/{project_id}", dependencies=_READ)
def get_project(project_id: str, engine: EngineDep, owner_id: OwnerDep) -> None:
    raise _not_implemented()


@router.delete("/{project_id}", dependencies=_WRITE, status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, engine: EngineDep, owner_id: OwnerDep) -> None:
    raise _not_implemented()


@router.put("/{project_id}/state", dependencies=_WRITE)
def put_state(project_id: str, engine: EngineDep, owner_id: OwnerDep) -> None:
    raise _not_implemented()
