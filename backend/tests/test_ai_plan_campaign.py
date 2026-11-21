"""End-to-end tests for POST /api/v1/ai/plan-campaign (fake Gemini, no DB, no network).

Why: the endpoint must keep the contract of the Next.js route `/api/ai/plan-campaign`: same
envelopes, same status per error code, `detail` shapes for validation failures, and the
behaviour that planning never fails because the creative step did. The shared protections
(rate limits, concurrency, body cap, no leaks) are tested in depth for analyze-material; here we
check that this endpoint uses them. Contract fixtures were produced by the TypeScript code and
checked against the frontend's Zod schemas, so they are the oracle for the success bodies.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.ai.campaign_planner as planner
import app.ai.routes as routes
from app.ai.campaign_output_parser import CandidateCampaign, parse_campaign_provider_result
from app.ai.campaign_templates import GENRE_TEMPLATES
from app.ai.contracts.requests import PlanCampaignRequest
from app.ai.limits import PLAN_CAMPAIGN_BODY_BYTES, AiLimits
from app.owner import COOKIE_NAME
from tests.ai_support import (
    ENDPOINT as ANALYZE_ENDPOINT,
)
from tests.ai_support import (
    KEY,
    build_app,
    gemini_error,
    gemini_reply,
    load_fixture,
)

PLAN = "/api/v1/ai/plan-campaign"
REQUEST = load_fixture("plan-campaign.request.json")
CREATIVE = load_fixture("plan-campaign.gemini-output.json")
TWO_REQUEST = load_fixture("plan-campaign.two-materials.request.json")
TWO_CREATIVE = load_fixture("plan-campaign.two-materials.gemini-output.json")


def creative_handler(creative: Any = CREATIVE) -> Any:
    return lambda _request: gemini_reply(creative)


def call(app: FastAPI, body: Any = REQUEST, **kwargs: Any) -> httpx2.Response:
    return TestClient(app).post(PLAN, json=body, **kwargs)


def error_of(response: httpx2.Response) -> dict[str, Any]:
    body = response.json()
    assert body["ok"] is False
    return body["error"]


def with_options(**options: Any) -> dict[str, Any]:
    return {**REQUEST, "options": {**REQUEST["options"], **options}}


# --- success and contract fixtures ------------------------------------------------------------


def test_success_matches_contract_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, creative_handler())
    response = call(app)
    assert response.status_code == 200
    assert response.json() == load_fixture("plan-campaign.success.json")
    assert response.headers["cache-control"] == "no-store"
    assert len(gemini.requests) == 1
    assert limiter.in_flight() == 0


def test_two_materials_are_ordered_and_gated_like_the_typescript_planner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, *_ = build_app(monkeypatch, creative_handler(TWO_CREATIVE))
    response = call(app, TWO_REQUEST)
    assert response.status_code == 200
    body = response.json()
    assert body == load_fixture("plan-campaign.two-materials.success.json")
    stories = body["data"]["blueprint"]["story_sequence"]
    assert [s["material_id"] for s in stories] == ["material_1xfqqww", "material_2abcdef"]
    assert stories[1]["required_knowledge"] == ["concept_1xfqqww_01"]
    assert body["data"]["meta"]["warnings"][0]["code"] == "PREREQUISITE_TESTABILITY_PENDING"


def test_success_has_no_null_and_meta_has_only_the_planner_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, *_ = build_app(monkeypatch, creative_handler())
    response = call(app)
    assert "null" not in response.text
    assert set(response.json()["data"]) == {"blueprint", "meta"}
    assert set(response.json()["data"]["meta"]) == {"provider", "model", "latencyMs", "warnings"}


def test_gemini_call_carries_prompt_key_header_and_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, *_ = build_app(monkeypatch, creative_handler())
    call(app)
    sent = gemini.requests[0]
    assert sent.headers["x-goog-api-key"] == KEY
    assert KEY not in str(sent.url)
    body = gemini.sent_json()
    assert body["systemInstruction"]["parts"][0]["text"] == (
        "You are a narrative designer for educational games. Respond with JSON only."
    )
    prompt = body["contents"][0]["parts"][0]["text"]
    assert "Genre: fantasy (ancient realms, fading magic)." in prompt
    assert "Player's wishes (follow them unless unsafe): Keep it short." in prompt
    assert '"material_title": "Vectors"' in prompt
    assert '"story_id": "story_01"' in prompt
    assert body["generationConfig"]["maxOutputTokens"] == 2000
    assert body["generationConfig"]["temperature"] == 0.9
    assert body["generationConfig"]["responseMimeType"] == "application/json"


def test_partial_creative_output_keeps_template_text_for_the_rest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, *_ = build_app(monkeypatch, creative_handler({"title": "Only a title"}))
    data = call(app).json()["data"]
    assert data["meta"]["model"] == "test-model"
    assert data["meta"]["warnings"] == []
    assert data["blueprint"]["title"] == "Only a title"
    assert data["blueprint"]["setting"] == GENRE_TEMPLATES["fantasy"].setting
    assert data["blueprint"]["characters"][0]["name"] == "The Keeper"


# --- creative step failures never fail the request --------------------------------------------


@pytest.mark.parametrize(
    ("handler", "reason"),
    [
        (lambda _r: gemini_error(500), "PROVIDER_UNAVAILABLE"),
        (lambda _r: gemini_error(403, "denied"), "PROVIDER_UNAVAILABLE"),
        (lambda _r: gemini_error(429), "RATE_LIMITED"),
    ],
)
def test_gemini_failure_keeps_the_template_campaign_with_a_warning(
    monkeypatch: pytest.MonkeyPatch, handler: Any, reason: str
) -> None:
    app, _, limiter, _ = build_app(monkeypatch, handler)
    response = call(app)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["meta"]["model"] == "deterministic-template"
    assert data["meta"]["warnings"] == [
        {
            "code": "CREATIVE_FALLBACK",
            "message": f"The AI provider was unavailable ({reason}); "
            "template campaign text was used.",
            "path": "campaign",
        }
    ]
    assert data["blueprint"]["title"].startswith("The Keeper's Campaign: Vectors")
    assert data["blueprint"]["story_sequence"][0]["story_id"] == "story_01"
    assert limiter.in_flight() == 0


def test_gemini_timeout_is_also_a_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_r: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("slow")

    app, *_ = build_app(monkeypatch, handler)
    response = call(app)
    assert response.status_code == 200
    assert "(TIMEOUT)" in response.json()["data"]["meta"]["warnings"][0]["message"]


def test_non_json_gemini_answer_is_a_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_r: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200, json={"candidates": [{"content": {"parts": [{"text": "not json at all"}]}}]}
        )

    app, *_ = build_app(monkeypatch, handler)
    response = call(app)
    assert response.status_code == 200
    assert "(OUTPUT_PARSE_FAILED)" in response.json()["data"]["meta"]["warnings"][0]["message"]


@pytest.mark.parametrize(
    "creative",
    [
        ["a", "list"],
        {"title": None},
        {"title": "x" * 601},
        {"title": 5},
        {"world_rules": ["r"] * 7},
        {"characters": [{"name": "No role or description"}]},
    ],
)
def test_unusable_creative_output_is_a_fallback(
    monkeypatch: pytest.MonkeyPatch, creative: Any
) -> None:
    app, *_ = build_app(monkeypatch, creative_handler(creative))
    response = call(app)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["meta"]["model"] == "deterministic-template"
    assert data["meta"]["warnings"] == [
        {
            "code": "CREATIVE_FALLBACK",
            "message": "The AI world design was unusable; template campaign text was used.",
            "path": "campaign",
        }
    ]


def test_creative_text_that_breaks_the_schema_is_dropped_not_returned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # An empty tone option makes the skeleton invalid; a valid tone from Gemini repairs it.
    app, *_ = build_app(monkeypatch, creative_handler({"tone": "hushed"}))
    response = call(app, with_options(tone=""))
    assert response.status_code == 200
    assert response.json()["data"]["blueprint"]["tone"] == "hushed"


# --- INVALID_REQUEST (400 / 413) --------------------------------------------------------------


def material() -> dict[str, Any]:
    return REQUEST["materials"][0]


@pytest.mark.parametrize(
    ("body", "field", "message"),
    [
        ({"options": {"genre": "fantasy"}}, "materials", "Required"),
        (
            {"materials": [], "options": {"genre": "fantasy"}},
            "materials",
            "at least one material is required",
        ),
        ({"materials": [material()]}, "options", "Required"),
        (
            {"materials": [{"material_id": ""}], "options": {"genre": "fantasy"}},
            "materials",
            "material_id must not be empty",
        ),
        (
            {"materials": [material()], "options": {"genre": "romance"}},
            "options",
            "Invalid enum value. Expected 'fantasy' | 'modern' | 'science_fiction' | "
            "'mystery' | 'historical' | 'survival' | 'horror' | 'custom', received 'romance'",
        ),
        (
            {"materials": [material()], "options": {"genre": "fantasy", "tone": 123}},
            "options",
            "Expected string, received number",
        ),
        (
            {"materials": "x", "options": {"genre": "fantasy"}},
            "materials",
            "Expected array, received string",
        ),
    ],
)
def test_invalid_body_is_400_with_zod_style_detail(
    monkeypatch: pytest.MonkeyPatch, body: dict[str, Any], field: str, message: str
) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, creative_handler())
    response = call(app, body)
    assert response.status_code == 400
    error = error_of(response)
    assert error["code"] == "INVALID_REQUEST"
    assert error["message"] == "Invalid request body"
    assert message in error["detail"]["fieldErrors"][field]
    assert error["detail"]["formErrors"] == []
    assert gemini.requests == []
    assert limiter.in_flight() == 0


def test_invalid_request_matches_the_error_fixture_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, creative_handler())
    response = call(app, {"garbage": True})
    assert response.status_code == 400
    assert error_of(response)["detail"] == {
        "formErrors": [],
        "fieldErrors": {"materials": ["Required"], "options": ["Required"]},
    }


@pytest.mark.parametrize("raw", [b"", b"{not json", b'{"materials": NaN}', b"[" * 100_000])
def test_broken_json_is_400_never_500(monkeypatch: pytest.MonkeyPatch, raw: bytes) -> None:
    app, gemini, *_ = build_app(monkeypatch, creative_handler())
    response = TestClient(app).post(PLAN, content=raw, headers={"content-type": "application/json"})
    assert response.status_code == 400
    assert error_of(response)["message"] == "Request body must be valid JSON"
    assert gemini.requests == []


def test_body_over_the_cap_is_413(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, *_ = build_app(monkeypatch, creative_handler())
    raw = b'{"materials": "' + b"x" * PLAN_CAMPAIGN_BODY_BYTES + b'"}'
    response = TestClient(app).post(PLAN, content=raw)
    assert response.status_code == 413
    assert error_of(response)["code"] == "INVALID_REQUEST"
    assert gemini.requests == []


def test_cap_is_far_below_caddy_limit_and_above_the_analyze_cap() -> None:
    assert 512 * 1024 < PLAN_CAMPAIGN_BODY_BYTES < 5 * 1024 * 1024


def test_a_realistic_largest_blueprint_fits_under_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    # Gemini's 6,000 output tokens is at most ~72 KB of text; build a 5-concept blueprint of
    # about 90 KB of multi-byte text and send three of them.
    text = "\u00e9\u4e2d" * 1_500  # 3,000 characters, 5 bytes in UTF-8 per pair
    concept = {
        **material()["concepts"][0],
        "definition": text,
        "principles": [text, text],
        "source_evidence": [text],
    }

    def big(index: int) -> dict[str, Any]:
        concepts = [
            {**concept, "concept_id": f"m{index}_c{i}", "prerequisites": []} for i in range(5)
        ]
        return {**material(), "material_id": f"m{index}", "concepts": concepts}

    body = {"materials": [big(i) for i in range(3)], "options": {"genre": "fantasy"}}
    raw = json.dumps(body, ensure_ascii=False).encode()
    assert 150_000 < len(raw) < PLAN_CAMPAIGN_BODY_BYTES
    app, *_ = build_app(monkeypatch, creative_handler({}))
    response = TestClient(app).post(PLAN, content=raw)
    assert response.status_code == 200
    assert len(response.json()["data"]["blueprint"]["story_sequence"]) == 3


# --- PROVIDER_NOT_CONFIGURED ------------------------------------------------------------------


def test_not_configured_is_503_and_matches_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, *_ = build_app(monkeypatch, creative_handler(), configured=False)
    response = call(app)
    assert response.status_code == 503
    assert response.json() == load_fixture("error-provider-not-configured.json")
    assert gemini.requests == []


def test_request_is_validated_before_the_provider_check(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, creative_handler(), configured=False)
    assert call(app, {}).status_code == 400


# --- semantic failures (422) ------------------------------------------------------------------


def test_duplicate_concept_ids_is_422_and_matches_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, *_ = build_app(monkeypatch, creative_handler())
    response = call(app, load_fixture("plan-campaign.error-duplicate-concept.request.json"))
    assert response.status_code == 422
    assert response.json() == load_fixture("error-duplicate-concept-id.json")
    assert gemini.requests == []  # unusable input never reaches Gemini


def concept_of(material_id: str, concept_id: str, prerequisites: list[str]) -> dict[str, Any]:
    return {
        **material(),
        "material_id": material_id,
        "concepts": [
            {**material()["concepts"][0], "concept_id": concept_id, "prerequisites": prerequisites}
        ],
    }


@pytest.mark.parametrize(
    ("materials", "code", "fragment"),
    [
        (
            [concept_of("m1", "a", []), concept_of("m1", "b", [])],
            "DUPLICATE_MATERIAL_ID",
            'Duplicate material_id "m1"',
        ),
        (
            [concept_of("m1", "a", ["ghost"])],
            "INVALID_PREREQUISITE_REF",
            'unknown prerequisite "ghost"',
        ),
        (
            [concept_of("m1", "a", ["b"]), concept_of("m2", "b", ["a"])],
            "PREREQUISITE_CYCLE",
            "form a cycle",
        ),
    ],
)
def test_other_unusable_planning_input_is_422(
    monkeypatch: pytest.MonkeyPatch, materials: list[dict[str, Any]], code: str, fragment: str
) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, creative_handler())
    response = call(app, {"materials": materials, "options": {"genre": "fantasy"}})
    assert response.status_code == 422
    error = error_of(response)
    assert error["code"] == code
    assert fragment in error["message"]
    assert gemini.requests == []
    assert limiter.in_flight() == 0


def test_cycle_error_carries_the_edges_as_detail(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, creative_handler())
    materials = [concept_of("m1", "a", ["b"]), concept_of("m2", "b", ["a"])]
    error = error_of(call(app, {"materials": materials, "options": {"genre": "fantasy"}}))
    assert error["detail"] == {"edges": "m1: [m2]; m2: [m1]"}


# --- VALIDATION_FAILED (502) ------------------------------------------------------------------


def test_invalid_template_value_is_502_with_flatten_detail(monkeypatch: pytest.MonkeyPatch) -> None:
    # An empty tone option leaves an empty tone in the template; Gemini fails, so it stays.
    app, *_ = build_app(monkeypatch, lambda _r: gemini_error(500))
    response = call(app, with_options(tone=""))
    assert response.status_code == 502
    error = error_of(response)
    assert error["code"] == "VALIDATION_FAILED"
    assert error["message"] == "Provider output does not match the CampaignBlueprint schema."
    assert error["detail"] == {
        "formErrors": [],
        "fieldErrors": {"tone": ["tone must not be empty"]},
    }


def test_semantic_failure_detail_matches_fixture() -> None:
    request = PlanCampaignRequest.model_validate(REQUEST)
    bad = load_fixture("plan-campaign.semantic-invalid-blueprint.json")
    result = parse_campaign_provider_result(
        CandidateCampaign(bad, "google", "test-model", 1), request.materials
    )
    expected = load_fixture("error-validation-semantic.json")["error"]
    assert (result.code, result.message, result.detail) == (
        expected["code"],
        expected["message"],
        expected["detail"],
    )


def test_semantic_failure_is_502_through_the_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = load_fixture("plan-campaign.semantic-invalid-blueprint.json")

    async def candidate(_request: Any, _ctx: Any) -> Any:
        return CandidateCampaign(bad, "google", "test-model", 1)

    monkeypatch.setattr(planner, "generate_candidate", candidate)
    app, *_ = build_app(monkeypatch, creative_handler())
    response = call(app)
    assert response.status_code == 502
    assert response.json() == load_fixture("error-validation-semantic.json")


# --- UNKNOWN (500) and no leaks ---------------------------------------------------------------


def test_unexpected_error_is_500_unknown_without_internals(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def explode(_request: Any, _ctx: Any) -> Any:
        raise RuntimeError(f"internal detail {KEY} Vectors")

    monkeypatch.setattr(
        routes,
        "PLAN_CAMPAIGN",
        routes.PLAN_CAMPAIGN.__class__(
            name="plan-campaign",
            request_model=routes.PLAN_CAMPAIGN.request_model,
            body_limit=routes.PLAN_CAMPAIGN.body_limit,
            run=explode,
        ),
    )
    app, _, limiter, _ = build_app(monkeypatch, creative_handler())
    with caplog.at_level(logging.DEBUG):
        response = call(app)
    assert response.status_code == 500
    assert response.json() == load_fixture("error-unknown.json")
    assert KEY not in response.text
    assert limiter.in_flight() == 0
    assert "plan-campaign" in caplog.text
    assert KEY not in caplog.text
    assert "internal detail" not in caplog.text


def test_key_and_prompt_never_reach_responses_or_logs(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    scenarios = [
        creative_handler(),
        lambda _r: gemini_error(500),
        lambda _r: gemini_error(429),
        creative_handler({"title": 5}),
    ]
    with caplog.at_level(logging.DEBUG):
        for handler in scenarios:
            app, *_ = build_app(monkeypatch, handler)
            response = call(app)
            assert KEY not in response.text
            assert KEY not in json.dumps(dict(response.headers))
        call(app, with_options(tone=""))
    assert KEY not in caplog.text
    assert "Keep it short." not in caplog.text
    assert "A vector has a magnitude" not in caplog.text


# --- shared protections apply to this endpoint ------------------------------------------------


def test_device_cookie_is_issued_and_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, creative_handler())
    client = TestClient(app)
    assert COOKIE_NAME in client.post(PLAN, json=REQUEST).headers["set-cookie"]
    assert "set-cookie" not in client.post(PLAN, json=REQUEST).headers


def test_rate_limit_applies_and_is_shared_with_the_other_ai_endpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, _, clock = build_app(
        monkeypatch, creative_handler(), limits=AiLimits(per_minute_ip=2, per_minute_owner=100)
    )
    client = TestClient(app)
    client.post(ANALYZE_ENDPOINT, json={})  # counts against the same IP window
    assert client.post(PLAN, json=REQUEST).status_code == 200
    limited = client.post(PLAN, json=REQUEST)
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"
    assert error_of(limited)["detail"] == {"scope": "ip", "retryAfterSeconds": 60}
    assert len(gemini.requests) == 1
    clock.now += 60
    assert client.post(PLAN, json=REQUEST).status_code == 200


def test_concurrency_and_daily_limits_apply_and_slots_are_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, limiter, _ = build_app(
        monkeypatch,
        creative_handler(),
        limits=AiLimits(
            per_minute_ip=100, per_minute_owner=100, daily_per_ip=2, max_concurrent_global=2
        ),
    )
    # Two other clients hold both global slots, so this endpoint must be refused.
    assert limiter.try_acquire("other") is None
    assert limiter.try_acquire("other-2") is None
    busy = call(app)
    assert busy.status_code == 429
    assert error_of(busy)["detail"]["scope"] == "concurrency-global"
    limiter.release("other")
    limiter.release("other-2")
    client = TestClient(app)
    assert client.post(PLAN, json=REQUEST).status_code == 200
    assert client.post(PLAN, json=REQUEST).status_code == 200
    daily = client.post(PLAN, json=REQUEST)
    assert daily.status_code == 429
    assert error_of(daily)["detail"]["scope"] == "daily"
    assert len(gemini.requests) == 2
    assert limiter.in_flight() == 0
