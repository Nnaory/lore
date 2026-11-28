"""Tests that /api/v1/animations is covered by the device-token middleware.

Why: animation ownership (Requirements 15.11, 21.1) rests on the `lore_device` cookie, so the
prefix must issue and read it. The match is on a path-segment boundary, so a sibling such as
/api/v1/animationsx must stay outside it. test_owner.py covers the middleware itself.
"""

from __future__ import annotations

import uuid
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.owner import COOKIE_NAME, PROTECTED_PREFIXES, device_token_middleware, get_owner_id

ANIMATION_ID = "a" * 64


def _build_app() -> FastAPI:
    app = FastAPI()
    app.middleware("http")(device_token_middleware)

    @app.get("/api/v1/animations/{animation_id}")
    def get_animation(
        animation_id: str, owner_id: Annotated[uuid.UUID, Depends(get_owner_id)]
    ) -> dict[str, str]:
        return {"animation_id": animation_id, "owner_id": str(owner_id)}

    @app.get("/api/v1/animations")
    def list_animations(owner_id: Annotated[uuid.UUID, Depends(get_owner_id)]) -> dict[str, str]:
        return {"owner_id": str(owner_id)}

    @app.get("/api/v1/animationsx")
    def sibling() -> dict[str, str]:
        return {"status": "ok"}

    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_build_app())


def test_prefix_is_registered() -> None:
    assert "/api/v1/animations" in PROTECTED_PREFIXES


def test_cookie_is_issued_on_animation_id_path(client: TestClient) -> None:
    response = client.get(f"/api/v1/animations/{ANIMATION_ID}")
    header = response.headers["set-cookie"]
    value = header.split(";")[0].split("=", 1)[1]
    assert header.startswith(f"{COOKIE_NAME}=")
    assert str(uuid.UUID(value)) == value == response.json()["owner_id"]
    lowered = header.lower()
    assert "httponly" in lowered
    assert "samesite=lax" in lowered


def test_cookie_is_issued_on_the_bare_prefix(client: TestClient) -> None:
    response = client.get("/api/v1/animations")
    assert COOKIE_NAME in response.headers["set-cookie"]


def test_existing_cookie_is_read_on_animation_id_path(client: TestClient) -> None:
    token = str(uuid.uuid4())
    client.cookies.set(COOKIE_NAME, token)
    response = client.get(f"/api/v1/animations/{ANIMATION_ID}")
    assert response.json()["owner_id"] == token
    assert "set-cookie" not in response.headers


def test_sibling_prefix_animationsx_gets_no_cookie(client: TestClient) -> None:
    response = client.get("/api/v1/animationsx")
    assert response.status_code == 200
    assert "set-cookie" not in response.headers
