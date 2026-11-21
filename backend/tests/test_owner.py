"""Tests for the device-token middleware that identifies anonymous owners.

Why: owner_id comes only from this cookie, so every response (including errors) must carry it
and cross-owner isolation depends on it being stable and well-formed.
"""

from __future__ import annotations

import uuid
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.owner import COOKIE_NAME, device_token_middleware, get_owner_id


def _build_app() -> FastAPI:
    app = FastAPI()
    app.middleware("http")(device_token_middleware)

    @app.get("/api/v1/projects/whoami")
    def whoami(owner_id: Annotated[uuid.UUID, Depends(get_owner_id)]) -> dict[str, str]:
        return {"owner_id": str(owner_id)}

    @app.get("/api/v1/projects/fail/{code}")
    def fail(code: int) -> None:
        raise HTTPException(status_code=code, detail="nope")

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_build_app())


def test_no_cookie_issues_valid_uuid_with_attributes(client: TestClient) -> None:
    response = client.get("/api/v1/projects/whoami")
    header = response.headers["set-cookie"]
    value = header.split(";")[0].split("=", 1)[1]
    assert str(uuid.UUID(value)) == value == response.json()["owner_id"]
    lowered = header.lower()
    assert "httponly" in lowered
    assert "samesite=lax" in lowered
    assert "path=/" in lowered
    assert "max-age=31536000" in lowered
    assert "secure" not in lowered


def test_valid_cookie_is_reused_without_new_set_cookie(client: TestClient) -> None:
    token = str(uuid.uuid4())
    client.cookies.set(COOKIE_NAME, token)
    response = client.get("/api/v1/projects/whoami")
    assert response.json()["owner_id"] == token
    assert "set-cookie" not in response.headers


def test_malformed_cookie_gets_a_new_one(client: TestClient) -> None:
    client.cookies.set(COOKIE_NAME, "not-a-uuid")
    response = client.get("/api/v1/projects/whoami")
    assert "set-cookie" in response.headers
    assert str(uuid.UUID(response.json()["owner_id"]))


def test_secure_flag_only_with_forwarded_proto_https(client: TestClient) -> None:
    https = client.get("/api/v1/projects/whoami", headers={"X-Forwarded-Proto": "https"})
    assert "secure" in https.headers["set-cookie"].lower().split("; ")
    client.cookies.clear()
    http = client.get("/api/v1/projects/whoami", headers={"X-Forwarded-Proto": "http"})
    assert "secure" not in http.headers["set-cookie"].lower()


@pytest.mark.parametrize("code", [404, 409, 413, 422, 429])
def test_cookie_is_set_on_http_exception_responses(client: TestClient, code: int) -> None:
    response = client.get(f"/api/v1/projects/fail/{code}")
    assert response.status_code == code
    assert COOKIE_NAME in response.headers["set-cookie"]


def test_paths_outside_projects_get_no_cookie(client: TestClient) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert "set-cookie" not in response.headers
