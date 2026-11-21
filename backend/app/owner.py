"""Anonymous device-token identity for /api/v1/projects/* and /api/v1/ai/*.

Why: R13 has no accounts (Q4 option A). A random UUID in an HttpOnly cookie is the owner id.
It is a middleware, not a dependency, because a Response injected into a dependency is lost
when an endpoint raises HTTPException; middleware sets the cookie on the final response.
An unhandled exception (500) is built outside user middleware and gets no cookie.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

COOKIE_NAME = "lore_device"
COOKIE_MAX_AGE = 31536000  # 1 year, in seconds
PROTECTED_PREFIXES = ("/api/v1/projects", "/api/v1/ai")


def _is_https(request: Request) -> bool:
    """Caddy sets X-Forwarded-Proto; the scheme seen by uvicorn is always http behind it."""
    return request.headers.get("x-forwarded-proto", "") == "https"


def _parse_token(value: str | None) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


async def device_token_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """Resolve or issue the device token and attach it to request.state and the response."""
    path = request.url.path
    if not any(path == p or path.startswith(p + "/") for p in PROTECTED_PREFIXES):
        return await call_next(request)

    existing = _parse_token(request.cookies.get(COOKIE_NAME))
    owner_id = existing or uuid.uuid4()
    request.state.owner_id = owner_id

    response = await call_next(request)

    if existing is None:
        response.set_cookie(
            COOKIE_NAME,
            str(owner_id),
            httponly=True,
            secure=_is_https(request),
            samesite="lax",
            max_age=COOKIE_MAX_AGE,
            path="/",
        )
    return response


def get_owner_id(request: Request) -> uuid.UUID:
    """Dependency: the owner id the middleware attached to this request."""
    owner_id = getattr(request.state, "owner_id", None)
    if owner_id is None:
        owner_id = uuid.uuid4()  # fallback; the middleware should always have set it
        request.state.owner_id = owner_id
    return owner_id
