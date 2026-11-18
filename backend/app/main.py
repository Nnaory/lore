"""FastAPI application entrypoint and health endpoints for LORE."""

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse


def _ok_response() -> JSONResponse:
    """Return a non-cacheable JSON liveness payload."""
    return JSONResponse(
        content={"status": "ok"},
        status_code=status.HTTP_200_OK,
        headers={"Cache-Control": "no-store"},
    )


def create_app() -> FastAPI:
    """Build and configure the FastAPI application instance."""
    application = FastAPI(title="LORE API", version="0.1.0")

    @application.get("/health", include_in_schema=False)
    def health() -> JSONResponse:
        """Internal liveness probe used by container healthchecks."""
        return _ok_response()

    @application.get("/health/db", include_in_schema=False)
    def health_db() -> JSONResponse:
        """Database readiness probe (enabled when RDS is wired in R10)."""
        return JSONResponse(
            content={"status": "unavailable", "detail": "database not configured"},
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            headers={"Cache-Control": "no-store"},
        )

    @application.get("/api/v1/health", tags=["health"])
    def api_health() -> JSONResponse:
        """Public liveness probe routed behind Caddy."""
        return _ok_response()

    return application


app = create_app()
