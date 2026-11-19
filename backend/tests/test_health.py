"""Unit tests for backend health and readiness endpoints."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError

from app.main import create_app


def test_health_returns_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PGHOST", raising=False)
    with TestClient(create_app()) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"status": "ok"}


def test_api_v1_health_returns_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PGHOST", raising=False)
    with TestClient(create_app()) as client:
        response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"status": "ok"}


def test_health_db_returns_503_when_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PGHOST", raising=False)
    with TestClient(create_app()) as client:
        response = client.get("/health/db")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "status": "unavailable",
        "detail": "database not configured",
    }


def test_health_db_returns_503_when_query_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_engine("sqlite:///:memory:")

    def _fail_connect() -> object:
        raise OperationalError("SELECT 1", {}, Exception("super-secret-password"))

    monkeypatch.setattr(engine, "connect", _fail_connect)
    with TestClient(create_app(db_engine=engine)) as client:
        response = client.get("/health/db")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "status": "unavailable",
        "detail": "database check failed",
    }
    assert "super-secret-password" not in response.text


def test_health_db_returns_200_when_query_succeeds() -> None:
    engine = create_engine("sqlite:///:memory:")
    with TestClient(create_app(db_engine=engine)) as client:
        response = client.get("/health/db")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"status": "ok"}
