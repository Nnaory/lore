"""Tests for the `animation` part of `GET /health/ai` (task 18.4; Requirements 16.9, 16.12).

Why: operators read this probe to learn whether the animation feature is on and whether it can
work, so `enabled` and `configured` must follow the environment exactly, and the probe must stay a
cheap, secret-free read. The tests pin:

1. the body: `configured` (the Gemini key) as before, plus `animation: {enabled, configured}` and
   nothing else, with `Cache-Control: no-store`;
2. `enabled`: true only for the text `true` (any letter case, surrounding spaces ignored);
3. `configured`: true only when `enabled`, bucket, verifier function and region are set, there is a
   database engine and the animation contract is valid, for all 32 combinations of the first
   five, and independent of the Gemini key;
4. that the probe makes no Gemini or AWS call, creates no runtime and shows no name or key.

The older test of the `configured` field is `test_health.py::test_health_ai_reports_configured`.
"""

from __future__ import annotations

import itertools
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.ai.animation.endpoint as endpoint_module
from app.ai.animation.contract import ContractInvalid
from app.main import create_app
from tests.ai_support import configure_env
from tests.animation_endpoint_support import ANIMATION_ENV, World, build_world

OFF = {"enabled": False, "configured": False}


def probe(world: World) -> dict[str, Any]:
    """`GET /health/ai` of the world's application, after checking the parts every answer shares."""
    response = TestClient(world.app).get("/health/ai")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body: dict[str, Any] = response.json()
    assert set(body) == {"configured", "animation"}
    assert set(body["animation"]) == {"enabled", "configured"}
    assert all(type(value) is bool for value in (body["configured"], *body["animation"].values()))
    return body


def test_with_no_animation_environment_both_flags_are_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_env(monkeypatch, configured=True)
    for name in ANIMATION_ENV:
        monkeypatch.delenv(name, raising=False)
    response = TestClient(create_app()).get("/health/ai")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"configured": True, "animation": OFF}


@pytest.mark.parametrize(
    ("enabled", "bucket", "function", "region", "engine"),
    list(itertools.product([False, True], repeat=5)),
)
def test_enabled_and_configured_follow_the_environment_and_the_engine(
    monkeypatch: pytest.MonkeyPatch,
    enabled: bool,
    bucket: bool,
    function: bool,
    region: bool,
    engine: bool,
) -> None:
    world = build_world(
        monkeypatch,
        enabled=enabled,
        bucket="lore-bucket" if bucket else "",
        function="lore-verifier" if function else "",
        region="ap-southeast-3" if region else "",
        with_engine=engine,
    )

    body = probe(world)

    assert body["animation"] == {
        "enabled": enabled,
        "configured": enabled and bucket and function and region and engine,
    }


@pytest.mark.parametrize("provider", [True, False])
@pytest.mark.parametrize("enabled", [True, False])
def test_the_gemini_key_and_the_animation_state_do_not_affect_each_other(
    monkeypatch: pytest.MonkeyPatch, provider: bool, enabled: bool
) -> None:
    world = build_world(monkeypatch, provider=provider, enabled=enabled)

    body = probe(world)

    assert body["configured"] is provider
    assert body["animation"] == {"enabled": enabled, "configured": enabled}


@pytest.mark.parametrize("raw", ["true", "TRUE", "True", "tRuE", " true ", "\ttrue\n"])
def test_the_flag_is_true_for_the_text_true_in_any_letter_case(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    world = build_world(monkeypatch, env={"ANIMATION_ENABLED": raw})

    assert probe(world)["animation"] == {"enabled": True, "configured": True}


@pytest.mark.parametrize(
    "raw", ["", " ", "false", "yes", "1", "on", "tru e", "truee", "no", "\uff54\uff52\uff55\uff45"]
)
def test_any_other_text_leaves_the_feature_off(monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
    world = build_world(monkeypatch, env={"ANIMATION_ENABLED": raw})

    assert probe(world)["animation"] == OFF


@pytest.mark.parametrize("name", ["ANIMATION_BUCKET", "ANIMATION_VERIFIER_FUNCTION", "AWS_REGION"])
def test_a_blank_setting_counts_as_not_set(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    world = build_world(monkeypatch, env={name: "  \t "})

    assert probe(world)["animation"] == {"enabled": True, "configured": False}


def test_an_invalid_contract_keeps_the_feature_enabled_but_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch)
    assert probe(world)["animation"] == {"enabled": True, "configured": True}

    monkeypatch.setattr(endpoint_module, "load_contract", lambda: ContractInvalid("broken"))

    assert probe(world)["animation"] == {"enabled": True, "configured": False}


def test_the_probe_calls_neither_gemini_nor_aws_and_creates_no_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch)
    world.app.state.animation_runtime = None

    probe(world)
    probe(world)

    assert world.gemini.requests == []
    assert world.verifier.payloads == []
    assert world.s3.calls == []
    assert world.registry.calls == []
    assert world.app.state.animation_runtime is None
    assert world.limiter.in_flight() == 0


def test_the_probe_shows_no_name_and_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    world = build_world(
        monkeypatch, bucket="secret-bucket-name", function="secret-function-name", region="xx-1"
    )
    response = TestClient(world.app).get("/health/ai")

    for secret in ("secret-bucket-name", "secret-function-name", "xx-1", "AIza"):
        assert secret not in response.text
