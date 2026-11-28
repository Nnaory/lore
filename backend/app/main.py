"""FastAPI application entrypoint and health endpoints for LORE."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
from sqlalchemy import Engine

from app.ai.animation.endpoint import animation_health, animations_router
from app.ai.animation.limits import AnimationLimits, animation_limiter_from_env
from app.ai.animation.logconfig import configure_animation_logging
from app.ai.limits import AiLimiter
from app.ai.routes import router as ai_router
from app.ai.runtime import AiRuntime
from app.ai.settings import ai_provider_ready
from app.db import check_db_health, create_db_engine
from app.owner import device_token_middleware
from app.projects import router as projects_router
from app.ratelimit import RateLimiter

_ENGINE_UNSET = object()


def _no_store_json(content: dict[str, str], status_code: int) -> JSONResponse:
    """Return a non-cacheable JSON response for probe endpoints."""
    return JSONResponse(
        content=content,
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def _resolve_engine(application: FastAPI) -> Engine | None:
    """Return the app's DB engine, lazily loading env config if lifespan did not run."""
    engine = getattr(application.state, "db_engine", _ENGINE_UNSET)
    if engine is _ENGINE_UNSET:
        engine = create_db_engine()
        application.state.db_engine = engine
    return engine  # type: ignore[return-value]


@asynccontextmanager
async def _lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Manage the SQLAlchemy connection pool lifecycle and the animation log handler."""
    configure_animation_logging()  # at startup, not at import: importing app.main stays inert
    if getattr(application.state, "db_engine", _ENGINE_UNSET) is _ENGINE_UNSET:
        application.state.db_engine = create_db_engine()
    try:
        yield
    finally:
        engine = getattr(application.state, "db_engine", _ENGINE_UNSET)
        if isinstance(engine, Engine):
            engine.dispose()
        application.state.db_engine = _ENGINE_UNSET


def create_app(db_engine: Engine | None | object = _ENGINE_UNSET) -> FastAPI:
    """Build and configure the FastAPI application instance."""
    application = FastAPI(title="LORE API", version="0.1.0", lifespan=_lifespan)
    application.state.db_engine = db_engine
    application.state.rate_limiter = RateLimiter()
    application.state.ai_limiter = AiLimiter()  # tests replace it to inject fake clocks
    application.state.ai_runtime = AiRuntime()  # tests inject the Gemini HTTP client here
    # The animation endpoint has its own limiter and per-owner cap; it shares no counters with the
    # JSON AI endpoints or with `app.state.limits` of projects. The runtime (S3, Lambda) is built
    # on the first request that passes the configuration checks, never here.
    application.state.animation_limiter = animation_limiter_from_env()
    application.state.animation_limits = AnimationLimits()
    application.state.animation_runtime = None
    application.middleware("http")(device_token_middleware)

    @application.get("/health", include_in_schema=False)
    def health() -> JSONResponse:
        """Internal liveness probe used by container healthchecks."""
        return _no_store_json({"status": "ok"}, status.HTTP_200_OK)

    @application.get("/health/db", include_in_schema=False)
    def health_db() -> JSONResponse:
        """Internal database readiness probe used by deploy.sh."""
        engine = _resolve_engine(application)
        if engine is None:
            return _no_store_json(
                {"status": "unavailable", "detail": "database not configured"},
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not check_db_health(engine):
            return _no_store_json(
                {"status": "unavailable", "detail": "database check failed"},
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return _no_store_json({"status": "ok"}, status.HTTP_200_OK)

    @application.get("/health/ai", include_in_schema=False)
    def health_ai() -> JSONResponse:
        """Internal probe: is the AI provider configured, and is the animation feature?

        `configured` is the Gemini key, as before. `animation` says whether the feature flag is on
        and whether everything it needs is set. It reads the environment only: it never calls
        Gemini or AWS, never creates the animation runtime and never leaks a key or a name.
        """
        return JSONResponse(
            content={
                "configured": ai_provider_ready(),
                "animation": animation_health(application),
            },
            headers={"Cache-Control": "no-store"},
        )

    @application.get("/api/v1/health", tags=["health"])
    def api_health() -> JSONResponse:
        """Public liveness probe routed behind Caddy."""
        return _no_store_json({"status": "ok"}, status.HTTP_200_OK)

    application.include_router(projects_router)
    application.include_router(ai_router)
    application.include_router(animations_router)

    return application


app = create_app()
