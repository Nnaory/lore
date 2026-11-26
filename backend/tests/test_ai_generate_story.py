"""End-to-end tests for POST /api/v1/ai/generate-story (fake Gemini, no DB, no network).

Why: the endpoint must keep the contract of the Next.js route `/api/ai/generate-story`: same
envelopes, same status per error code, same `detail` shapes, and the same behaviour when the
model's text is partly unusable (template text is kept, the story still plays). The shared
protections (rate limits, concurrency, body cap, no leaks) are tested in depth for
analyze-material; here we check that this endpoint uses them. Contract fixtures were produced
by running the TypeScript engine, provider and service and checked against the frontend's Zod
schemas, so they are the oracle for the success and error bodies.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.ai.routes as routes
from app.ai.chunking import MAX_CHUNK_CHARS
from app.ai.contracts.story import StoryBlueprint
from app.ai.limits import GENERATE_STORY_BODY_BYTES, AiLimits
from app.ai.prompts.story_generator import SYSTEM_PROMPT
from app.ai.story_generator_engine import StoryEngineError, build_story_blueprint
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

STORY = "/api/v1/ai/generate-story"
REQUEST = load_fixture("generate-story.request.json")
CONTENT = load_fixture("generate-story.gemini-output.json")
WITH_SUMMARIES = load_fixture("generate-story.with-summaries.request.json")


def content_handler(content: Any = CONTENT) -> Any:
    return lambda _request: gemini_reply(content)


def call(app: FastAPI, body: Any = REQUEST, **kwargs: Any) -> httpx2.Response:
    return TestClient(app).post(STORY, json=body, **kwargs)


def error_of(response: httpx2.Response) -> dict[str, Any]:
    body = response.json()
    assert body["ok"] is False
    return body["error"]


# --- success and contract fixtures ------------------------------------------------------------


def test_success_matches_contract_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, content_handler())
    response = call(app)
    assert response.status_code == 200
    assert response.json() == load_fixture("generate-story.success.json")
    assert response.headers["cache-control"] == "no-store"
    assert len(gemini.requests) == 1
    assert limiter.in_flight() == 0


def test_invalid_illustration_is_dropped_with_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, content_handler())
    data = call(app).json()["data"]
    assert data["meta"]["warnings"] == [
        {
            "code": "VISUAL_DROPPED",
            "message": "Illustrations were invalid and are shown as text for: concept_1xfqqww_01.",
            "path": "story",
        }
    ]
    blocks = [
        b
        for chapter in data["blueprint"]["chapters"]
        for scene in chapter["scenes"]
        for b in scene.get("content", [])
        if b["type"] == "learning_info"
    ]
    kinds = [b.get("visual", {}).get("kind") for b in blocks]
    # Concept 1: vectors kept, table kept, the null visual dropped, a fourth step without one;
    # the fifth step is cut. Concept 2: the single-lesson form with a table.
    assert kinds == ["vectors", "table", None, None, "table"]
    assert blocks[0]["visual"]["vectors"][0]["label"] == "v"  # trimmed like Zod does


def _text_blocks(blueprint: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        b
        for chapter in blueprint["chapters"]
        for scene in chapter["scenes"]
        for b in scene.get("content", [])
        if b["type"] in ("narration", "dialogue", "learning_info")
    ]


def test_long_text_is_split_and_a_puzzle_visual_reaches_the_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = json.loads(json.dumps(CONTENT))
    first = content["concepts"][0]
    long_body = " ".join(
        f"Idea {i} says that a vector keeps its length when moved." for i in range(12)
    )
    first["lesson_steps"][0]["body"] = long_body
    first["puzzle"]["visual"] = {
        "kind": "table",
        "headers": ["Side", "Length"],
        "rows": [["a", "3"], ["b", "4"], ["c", "?"]],
    }
    app, *_ = build_app(monkeypatch, content_handler(content))
    response = call(app)
    assert response.status_code == 200
    blueprint = response.json()["data"]["blueprint"]
    StoryBlueprint.model_validate(blueprint)

    # No text block is longer than the dialogue box, and the long step became several blocks.
    blocks = _text_blocks(blueprint)
    assert all(len(b.get("text", b.get("body", ""))) <= MAX_CHUNK_CHARS for b in blocks)
    step = [b for b in blocks if b["type"] == "learning_info" and b["body"].startswith("Idea 0")]
    assert step and step[0]["title"] == "Vector and magnitude: the idea"
    chunks = [b for b in blocks if b["type"] == "learning_info" and b["title"] == step[0]["title"]]
    assert len(chunks) >= 3
    assert " ".join(b["body"] for b in chunks) == long_body
    assert all(
        b["visual"] == chunks[0]["visual"] and b["visual"]["kind"] == "vectors" for b in chunks
    )

    # The puzzle's picture is on the puzzle; puzzles without one have no `visual` key at all.
    puzzles = {p["puzzle_id"]: p for p in blueprint["puzzles"]}
    assert puzzles["puzzle_story_01_c01"]["visual"] == {
        "kind": "table",
        "headers": ["Side", "Length"],
        "rows": [["a", "3"], ["b", "4"], ["c", "?"]],
    }
    assert "visual" not in puzzles["puzzle_story_01_c02"]


def test_an_invalid_puzzle_visual_is_dropped_with_the_same_warning_as_a_lesson_visual(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = json.loads(json.dumps(CONTENT))
    # Concept 2 has no lesson visual problems; only its puzzle picture is bad.
    content["concepts"][1]["puzzle"]["visual"] = {"kind": "plot", "series": []}
    app, *_ = build_app(monkeypatch, content_handler(content))
    data = call(app).json()["data"]
    puzzle = next(
        p for p in data["blueprint"]["puzzles"] if p["puzzle_id"] == "puzzle_story_01_c02"
    )
    assert "visual" not in puzzle
    assert (
        puzzle["question"] != "Which statement correctly describes Vector addition?"
    )  # still written
    warning = next(w for w in data["meta"]["warnings"] if w["code"] == "VISUAL_DROPPED")
    assert warning["message"].endswith("concept_1xfqqww_01, concept_1xfqqww_02.")


def test_two_stories_with_summaries_match_contract_fixture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, *_ = build_app(
        monkeypatch,
        content_handler(load_fixture("generate-story.with-summaries.gemini-output.json")),
    )
    response = call(app, WITH_SUMMARIES)
    assert response.status_code == 200
    assert response.json() == load_fixture("generate-story.with-summaries.success.json")
    prompt = gemini.sent_json()["contents"][0]["parts"][0]["text"]
    # Only the LAST summary reaches the prompt, and the intro scene mentions it too.
    assert "What happened before: The story's central problem is fully resolved." in prompt
    assert "The Cold Open" not in prompt
    assert "Player's wishes (follow them unless unsafe): Keep it short." in prompt


def test_partial_content_keeps_template_text_and_warns(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(
        monkeypatch,
        content_handler(load_fixture("generate-story.partial-content.gemini-output.json")),
    )
    response = call(app)
    assert response.status_code == 200
    assert response.json() == load_fixture("generate-story.partial-content.success.json")
    warning = response.json()["data"]["meta"]["warnings"][0]
    assert warning["code"] == "CONTENT_PARTIAL_FALLBACK"
    assert warning["message"] == (
        "Template text was kept for: intro.narration, puzzle:puzzle_story_01_c01, "
        "concept:concept_1xfqqww_02, ending.narration."
    )


def test_success_has_the_envelope_keys_and_only_the_documented_nulls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, *_ = build_app(monkeypatch, content_handler())
    body = call(app).json()
    assert set(body) == {"ok", "data"}
    assert set(body["data"]) == {"blueprint", "meta"}
    assert set(body["data"]["meta"]) == {"provider", "model", "latencyMs", "warnings"}
    assert body["data"]["meta"]["provider"] == "google"
    assert body["data"]["meta"]["model"] == "test-model"
    assert body["data"]["meta"]["latencyMs"] == 1234
    assert "null" not in json.dumps(body)  # a linear story has no null next_scene_id


def test_gemini_call_carries_prompt_key_header_and_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler())
    call(app)
    sent = gemini.requests[0]
    assert sent.headers["x-goog-api-key"] == KEY
    assert KEY not in str(sent.url)
    body = gemini.sent_json()
    system = body["systemInstruction"]["parts"][0]["text"]
    assert system == SYSTEM_PROMPT
    assert system.startswith(
        "You write accurate, engaging educational visual-novel content. Respond with JSON only."
    )
    assert f"holds about {MAX_CHUNK_CHARS} characters" in system
    prompt = body["contents"][0]["parts"][0]["text"]
    assert prompt.startswith(
        "Write the text for one story of an interactive learning visual novel."
    )
    assert "Write everything in English." in prompt
    assert '"concept_id": "concept_1xfqqww_01"' in prompt
    assert "The material does NOT cover (never teach or mention these): " in prompt
    assert body["generationConfig"]["maxOutputTokens"] == 20000
    assert body["generationConfig"]["temperature"] == 0.8
    assert body["generationConfig"]["responseMimeType"] == "application/json"


def test_language_option_switches_the_prompt_language(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler())
    call(app, {**REQUEST, "options": {"language": "id"}})
    prompt = gemini.sent_json()["contents"][0]["parts"][0]["text"]
    assert "Write everything in Indonesian." in prompt
    assert "1. Konsep \u2014 the definition" in prompt


def test_story_requests_get_a_longer_gemini_timeout_than_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler())
    monkeypatch.setenv("AI_TIMEOUT_MS", "10000")
    monkeypatch.setenv("AI_DEADLINE_MS", "20000")
    call(app)
    assert gemini.requests[0].extensions["timeout"]["read"] == 90.0


# --- the model's text is partly or wholly unusable --------------------------------------------


@pytest.mark.parametrize(
    "content",
    [{}, {"intro": None}, {"concepts": "nope"}, ["a", "list"], "text", 5, None],
    ids=["empty", "null-intro", "bad-concepts", "list", "string", "number", "null"],
)
def test_unusable_model_content_gives_the_template_story_with_a_warning(
    monkeypatch: pytest.MonkeyPatch, content: Any
) -> None:
    app, *_ = build_app(monkeypatch, content_handler(content))
    response = call(app)
    assert response.status_code == 200
    data = response.json()["data"]
    warning = data["meta"]["warnings"][0]
    assert warning["code"] == "CONTENT_PARTIAL_FALLBACK"
    assert warning["message"].startswith("Template text was kept for: intro.narration, concept:")
    assert warning["message"].endswith("ending.narration.")
    skeleton = build_story_blueprint(_request_model(REQUEST))
    assert not isinstance(skeleton, StoryEngineError)
    story_ids = {s["scene_id"] for c in data["blueprint"]["chapters"] for s in c["scenes"]}
    expected_ids = {s["scene_id"] for c in skeleton.blueprint["chapters"] for s in c["scenes"]}
    assert story_ids == expected_ids


def _request_model(body: dict[str, Any]) -> Any:
    from app.ai.contracts.requests import GenerateStoryRequest

    return GenerateStoryRequest.model_validate(body)


def test_puzzle_choices_are_shuffled_but_keep_the_correct_answer_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, *_ = build_app(monkeypatch, content_handler())
    puzzles = call(app).json()["data"]["blueprint"]["puzzles"]
    for puzzle in puzzles:
        ids = [c["choice_id"] for c in puzzle["choices"]]
        assert puzzle["correct_choice_id"] in ids
        assert len(ids) == len(set(ids))
    # Deterministic: the same request shuffles the same way.
    app2, *_ = build_app(monkeypatch, content_handler())
    assert call(app2).json()["data"]["blueprint"]["puzzles"] == puzzles


# --- Gemini failures: no template-only story --------------------------------------------------


def test_gemini_server_error_is_503_and_matches_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, lambda _r: gemini_error(500))
    response = call(app)
    assert response.status_code == 503
    assert response.json() == load_fixture("error-story-provider-unavailable.json")
    assert len(gemini.requests) == 2  # two attempts on the one configured model
    assert limiter.in_flight() == 0


def test_non_json_answer_is_502_output_parse_failed_and_matches_fixture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_r: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": "not json at all"}]}, "finishReason": "STOP"}
                ]
            },
        )

    app, *_ = build_app(monkeypatch, handler)
    response = call(app)
    assert response.status_code == 502
    assert response.json() == load_fixture("error-story-output-parse-failed.json")


@pytest.mark.parametrize(
    "handler",
    [
        lambda _r: gemini_error(429),
        lambda _r: gemini_error(403, "denied"),
        lambda _r: gemini_error(404, "no such model"),
    ],
    ids=["rate-limited", "denied", "unknown-model"],
)
def test_other_gemini_failures_are_all_provider_unavailable(
    monkeypatch: pytest.MonkeyPatch, handler: Any
) -> None:
    app, *_ = build_app(monkeypatch, handler)
    response = call(app)
    assert response.status_code == 503
    error = error_of(response)
    # The story provider reports every failure except bad JSON as PROVIDER_UNAVAILABLE.
    assert error["code"] == "PROVIDER_UNAVAILABLE"
    assert error["message"] == "The AI storyteller is unavailable right now. Try again in a moment."
    assert isinstance(error["detail"], list)


def test_gemini_timeout_is_provider_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_r: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("slow")

    app, *_ = build_app(monkeypatch, handler)
    response = call(app)
    assert response.status_code == 503
    assert error_of(response)["code"] == "PROVIDER_UNAVAILABLE"
    assert error_of(response)["detail"] == [{"model": "test-model", "reason": "timeout"}]


# --- semantic failures (422) ------------------------------------------------------------------


def test_story_not_in_campaign_is_422_and_matches_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, content_handler())
    body = {**REQUEST, "story": {**REQUEST["story"], "story_id": "story_99"}}
    response = call(app, body)
    assert response.status_code == 422
    assert response.json() == load_fixture("error-story-not-in-campaign.json")
    assert gemini.requests == []  # unusable input never reaches Gemini
    assert limiter.in_flight() == 0


def test_material_mismatch_is_422_and_matches_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler())
    body = {**REQUEST, "material": {**REQUEST["material"], "material_id": "material_other"}}
    response = call(app, body)
    assert response.status_code == 422
    assert response.json() == load_fixture("error-material-mismatch.json")
    assert gemini.requests == []


def test_story_check_comes_before_material_check(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, content_handler())
    body = {
        **REQUEST,
        "story": {**REQUEST["story"], "story_id": "story_99"},
        "material": {**REQUEST["material"], "material_id": "material_other"},
    }
    assert error_of(call(app, body))["code"] == "STORY_NOT_IN_CAMPAIGN"


def test_concept_coverage_fixture_comes_from_the_engine() -> None:
    # A material without concepts is rejected by the request schema (400, tested below) before
    # the engine can see it, so CONCEPT_COVERAGE is only reachable below the HTTP layer.
    request = _request_model(REQUEST)
    empty = request.model_copy(
        update={"material": request.material.model_copy(update={"concepts": []})}
    )
    result = build_story_blueprint(empty)
    assert isinstance(result, StoryEngineError)
    expected = load_fixture("error-concept-coverage.json")
    assert {"ok": False, "error": {"code": result.code, "message": result.message}} == expected


def test_concept_coverage_over_http_is_a_400_for_the_empty_concepts_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, *_ = build_app(monkeypatch, content_handler())
    body = {**REQUEST, "material": {**REQUEST["material"], "concepts": []}}
    response = call(app, body)
    assert response.status_code == 400
    assert error_of(response)["detail"]["fieldErrors"] == {
        "material": ["at least one concept is required"]
    }


def test_required_knowledge_of_its_own_material_is_a_502_with_the_error_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler())
    response = call(app, load_fixture("generate-story.self-reference.request.json"))
    assert response.status_code == 502
    assert response.json() == load_fixture("error-story-validation-failed.json")
    error = error_of(response)
    assert error["code"] == "VALIDATION_FAILED"
    assert error["detail"][0]["code"] == "REQUIRED_KNOWLEDGE_SELF_REFERENCE"
    assert len(gemini.requests) == 1  # Gemini was called first, the rule fails afterwards


def test_prerequisite_cycle_inside_the_material_is_a_502_validation_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    concepts = [dict(c) for c in REQUEST["material"]["concepts"]]
    concepts[0]["prerequisites"] = [concepts[1]["concept_id"]]
    body = {**REQUEST, "material": {**REQUEST["material"], "concepts": concepts}}
    app, *_ = build_app(monkeypatch, content_handler())
    response = call(app, body)
    assert response.status_code == 502
    assert [e["code"] for e in error_of(response)["detail"]] == ["CONCEPT_PREREQUISITE_CYCLE"]


# --- INVALID_REQUEST (400 / 413) --------------------------------------------------------------


@pytest.mark.parametrize(
    ("mutate", "field", "message"),
    [
        (lambda b: b.pop("campaign"), "campaign", "Required"),
        (lambda b: b.pop("story"), "story", "Required"),
        (lambda b: b.pop("material"), "material", "Required"),
        (
            lambda b: b.update(story={**b["story"], "story_id": ""}),
            "story",
            "story_id must not be empty",
        ),
        (
            lambda b: b.update(material={**b["material"], "material_id": ""}),
            "material",
            "material_id must not be empty",
        ),
        (
            lambda b: b.update(campaign={"campaign_id": ""}),
            "campaign",
            "campaign_id must not be empty",
        ),
        (
            lambda b: b.update(previousSummaries=[{"story_id": ""}]),
            "previousSummaries",
            "story_id must not be empty",
        ),
        (
            lambda b: b.update(previousSummaries=[{"story_id": "s", "title": ""}]),
            "previousSummaries",
            "title must not be empty",
        ),
        (
            lambda b: b.update(previousSummaries="x"),
            "previousSummaries",
            "Expected array, received string",
        ),
        (
            lambda b: b.update(options={"conceptsPerChapter": 0}),
            "options",
            "Number must be greater than or equal to 1",
        ),
        (
            lambda b: b.update(options={"conceptsPerChapter": 1.5}),
            "options",
            "Expected integer, received float",
        ),
        (
            lambda b: b.update(options={"conceptsPerChapter": "2"}),
            "options",
            "Expected number, received string",
        ),
        (
            lambda b: b.update(options={"language": 5}),
            "options",
            "Expected string, received number",
        ),
        (lambda b: b.update(campaign=None), "campaign", "Expected object, received null"),
    ],
)
def test_invalid_body_is_400_with_zod_style_detail(
    monkeypatch: pytest.MonkeyPatch, mutate: Any, field: str, message: str
) -> None:
    body = json.loads(json.dumps(REQUEST))
    mutate(body)
    app, gemini, limiter, _ = build_app(monkeypatch, content_handler())
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
    app, *_ = build_app(monkeypatch, content_handler())
    response = call(app, {"garbage": True})
    assert response.status_code == 400
    assert error_of(response)["detail"] == {
        "formErrors": [],
        "fieldErrors": {
            "campaign": ["Required"],
            "story": ["Required"],
            "material": ["Required"],
        },
    }


def test_an_integral_float_for_concepts_per_chapter_is_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # JSON "2.0" is the number 2 in JavaScript, which Zod accepts as an integer.
    app, *_ = build_app(monkeypatch, content_handler())
    raw = json.dumps({**REQUEST, "options": {"conceptsPerChapter": 2}}).replace(
        '"conceptsPerChapter": 2', '"conceptsPerChapter": 2.0'
    )
    response = TestClient(app).post(STORY, content=raw)
    assert response.status_code == 200
    assert len(response.json()["data"]["blueprint"]["chapters"]) == 1


def test_unknown_keys_are_ignored_and_empty_summaries_are_fine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, *_ = build_app(monkeypatch, content_handler())
    body = {**REQUEST, "extra": 1, "previousSummaries": [], "options": {}}
    assert call(app, body).status_code == 200


@pytest.mark.parametrize("raw", [b"", b"{not json", b'{"campaign": NaN}', b"[" * 100_000])
def test_broken_json_is_400_never_500(monkeypatch: pytest.MonkeyPatch, raw: bytes) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler())
    response = TestClient(app).post(
        STORY, content=raw, headers={"content-type": "application/json"}
    )
    assert response.status_code == 400
    assert error_of(response)["message"] == "Request body must be valid JSON"
    assert gemini.requests == []


def test_body_over_the_cap_is_413(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler())
    raw = b'{"campaign": "' + b"x" * GENERATE_STORY_BODY_BYTES + b'"}'
    response = TestClient(app).post(STORY, content=raw)
    assert response.status_code == 413
    assert error_of(response)["code"] == "INVALID_REQUEST"
    assert gemini.requests == []


def test_cap_is_far_below_caddy_limit() -> None:
    assert 256 * 1024 <= GENERATE_STORY_BODY_BYTES < 5 * 1024 * 1024


def _worst_realistic_request() -> dict[str, Any]:
    """5 stories, a material of about 72 KB (30 concepts of 3-byte text) and 10 summaries."""
    text = "\u4e2d\u6587" * 400  # 800 characters, 2,400 bytes of UTF-8
    concepts = [
        {
            **REQUEST["material"]["concepts"][0],
            "concept_id": f"c{i:02d}",
            "name": f"Concept {i}",
            "definition": text,
            "principles": [],
            "methods": [],
            "prerequisites": [],
            "misconceptions": [],
            "source_evidence": [],
            "notation": None,
            "examples": None,
        }
        for i in range(30)
    ]
    for c in concepts:
        del c["notation"], c["examples"]
    material = {**REQUEST["material"], "concepts": concepts}
    entries = [
        {
            **REQUEST["story"],
            "story_id": f"story_{i:02d}",
            "purpose": "p" * 300,
            "main_conflict": "m" * 300,
        }
        for i in range(5)
    ]
    campaign = {**REQUEST["campaign"], "story_sequence": entries}
    summaries = [
        {
            "story_id": f"story_{i:02d}",
            "title": "Title " * 10,
            "outcome_description": "o" * 300,
            "world_state_snapshot": {f"key_{k}": k for k in range(15)},
            "relationship_snapshot": {f"char_{k}": 10 for k in range(5)},
        }
        for i in range(10)
    ]
    return {
        "campaign": campaign,
        "story": entries[0],
        "material": material,
        "previousSummaries": summaries,
        "options": {"customInstructions": "i" * 500, "language": "en"},
    }


def test_a_realistic_largest_request_fits_under_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    body = _worst_realistic_request()
    raw = json.dumps(body, ensure_ascii=False).encode()
    # About 72 KB of material plus campaign, story entry, summaries and options: roughly 100 KB,
    # a fifth of the cap.
    assert 80_000 < len(raw) < GENERATE_STORY_BODY_BYTES // 3
    app, *_ = build_app(monkeypatch, content_handler({}))
    response = TestClient(app).post(STORY, content=raw)
    assert response.status_code == 200
    assert len(response.json()["data"]["blueprint"]["puzzles"]) == 30


# --- PROVIDER_NOT_CONFIGURED ------------------------------------------------------------------


def test_not_configured_is_503_and_matches_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, *_ = build_app(monkeypatch, content_handler(), configured=False)
    response = call(app)
    assert response.status_code == 503
    assert response.json() == load_fixture("error-provider-not-configured.json")
    assert gemini.requests == []


def test_request_is_validated_before_the_provider_check(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, content_handler(), configured=False)
    assert call(app, {}).status_code == 400


def test_semantic_checks_wait_for_a_configured_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    # The cross-reference checks run in the service, after the "AI configured" gate.
    app, *_ = build_app(monkeypatch, content_handler(), configured=False)
    body = {**REQUEST, "story": {**REQUEST["story"], "story_id": "story_99"}}
    assert error_of(call(app, body))["code"] == "PROVIDER_NOT_CONFIGURED"


# --- UNKNOWN (500) and no leaks ---------------------------------------------------------------


def test_unexpected_error_is_500_unknown_without_internals(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def explode(_request: Any, _ctx: Any) -> Any:
        raise RuntimeError(f"internal detail {KEY} Vectors")

    monkeypatch.setattr(
        routes,
        "GENERATE_STORY",
        routes.GENERATE_STORY.__class__(
            name="generate-story",
            request_model=routes.GENERATE_STORY.request_model,
            body_limit=routes.GENERATE_STORY.body_limit,
            run=explode,
        ),
    )
    app, _, limiter, _ = build_app(monkeypatch, content_handler())
    with caplog.at_level(logging.DEBUG):
        response = call(app)
    assert response.status_code == 500
    assert response.json() == load_fixture("error-unknown.json")
    assert KEY not in response.text
    assert limiter.in_flight() == 0
    assert "generate-story" in caplog.text
    assert KEY not in caplog.text
    assert "internal detail" not in caplog.text


def test_key_and_prompt_never_reach_responses_or_logs(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    scenarios = [
        content_handler(),
        lambda _r: gemini_error(500),
        lambda _r: gemini_error(429),
        content_handler({"intro": None}),
    ]
    with caplog.at_level(logging.DEBUG):
        for handler in scenarios:
            app, *_ = build_app(monkeypatch, handler)
            response = call(app)
            assert KEY not in response.text
            assert KEY not in json.dumps(dict(response.headers))
        app, *_ = build_app(monkeypatch, content_handler())
        call(app, load_fixture("generate-story.self-reference.request.json"))
    assert KEY not in caplog.text
    assert "A vector has a magnitude" not in caplog.text
    assert "Write the text for one story" not in caplog.text


# --- shared protections apply to this endpoint ------------------------------------------------


def test_device_cookie_is_issued_and_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, content_handler())
    client = TestClient(app)
    assert COOKIE_NAME in client.post(STORY, json=REQUEST).headers["set-cookie"]
    assert "set-cookie" not in client.post(STORY, json=REQUEST).headers


def test_endpoint_uses_the_shared_limiter_for_rate_concurrency_and_daily_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, limiter, clock = build_app(
        monkeypatch,
        content_handler(),
        limits=AiLimits(per_minute_ip=3, per_minute_owner=100, daily_per_ip=2),
    )
    client = TestClient(app)
    client.post(ANALYZE_ENDPOINT, json={})  # counts against the same IP window
    assert client.post(STORY, json=REQUEST).status_code == 200
    assert client.post(STORY, json=REQUEST).status_code == 200
    limited = client.post(STORY, json=REQUEST)
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"
    assert error_of(limited)["detail"] == {"scope": "ip", "retryAfterSeconds": 60}
    assert len(gemini.requests) == 2
    assert limiter.in_flight() == 0

    clock.now += 60
    daily = client.post(STORY, json=REQUEST)  # the daily quota of 2 is used up
    assert daily.status_code == 429
    assert error_of(daily)["detail"]["scope"] == "daily"


def test_a_busy_server_refuses_with_429_and_slots_are_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, limiter, _ = build_app(
        monkeypatch,
        content_handler(),
        limits=AiLimits(per_minute_ip=100, per_minute_owner=100, max_concurrent_global=1),
    )
    assert limiter.try_acquire("other") is None
    busy = call(app)
    assert busy.status_code == 429
    assert error_of(busy)["detail"]["scope"] == "concurrency-global"
    assert gemini.requests == []
    limiter.release("other")
    assert call(app).status_code == 200
    assert limiter.in_flight() == 0
