"""End-to-end tests for POST /api/v1/ai/ask (fake Gemini, no DB, no network)."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.ask_question import MAX_REPLY_CHARS
from app.ai.limits import ASK_QUESTION_BODY_BYTES, AiLimits
from tests.ai_support import (
    build_app,
    gemini_error,
    gemini_reply,
    load_fixture,
)

ENDPOINT = "/api/v1/ai/ask"


def sample_request(**overrides: Any) -> dict[str, Any]:
    story_req = load_fixture("generate-story.request.json")
    story = load_fixture("generate-story.success.json")["data"]["blueprint"]
    first_scene = story["chapters"][0]["scenes"][0]
    first_speaker = story_req["campaign"]["characters"][0]["character_id"]
    concept_id = story_req["material"]["concepts"][0]["concept_id"]

    payload: dict[str, Any] = {
        "question": "Kenapa koefisien vektor bisa menghasilkan span seluruh bidang?",
        "campaign": story_req["campaign"],
        "story": story,
        "materials": [story_req["material"]],
        "context": {
            "scene_id": first_scene["scene_id"],
            "chapter_id": story["chapters"][0]["chapter_id"],
            "chapter_title": story["chapters"][0]["title"],
            "block_index": 0,
            "speaker_character_id": first_speaker,
            "recent_log": [
                {"kind": "narration", "text": "The beacon hums softly."},
                {"kind": "dialogue", "speaker": "Eldric", "text": "Watch how two vectors combine."},
            ],
            "qa_history": [
                {"question": "Apa itu vektor?", "answer": "Besaran yang punya arah dan panjang."},
            ],
            "player_knowledge": {
                concept_id: {"concept_id": concept_id, "status": "introduced"},
            },
        },
    }
    payload.update(overrides)
    return payload


def call(app: FastAPI, body: Any = None, **kwargs: Any) -> httpx2.Response:
    return TestClient(app).post(ENDPOINT, json=sample_request() if body is None else body, **kwargs)


def ok_handler(_request: httpx2.Request) -> httpx2.Response:
    req = load_fixture("generate-story.request.json")
    cid = req["material"]["concepts"][0]["concept_id"]
    return gemini_reply(
        {
            "answer": (
                "Dua vektor yang tidak sejajar bisa dikalikan skalar dan dijumlahkan "
                "untuk mencapai titik mana pun di bidang itu."
            ),
            "expression": "smile",
            "referenced_concept_ids": [cid],
            "out_of_scope": False,
        }
    )


def test_ask_success_envelope_and_no_nulls(monkeypatch: pytest.MonkeyPatch) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, ok_handler)
    response = call(app)
    assert response.status_code == 200
    assert "null" not in response.text
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["reply"]["expression"] == "smile"
    assert body["data"]["reply"]["out_of_scope"] is False
    assert len(body["data"]["reply"]["referenced_concept_ids"]) == 1
    assert body["data"]["meta"]["provider"] == "google"
    assert body["data"]["meta"]["warnings"] == []
    assert limiter.in_flight() == 0
    assert len(gemini.requests) == 1


def test_prompt_includes_full_material_and_story_without_puzzle_spoilers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, *_ = build_app(monkeypatch, ok_handler)
    req = sample_request()
    call(app, req)

    sent = gemini.sent_json()
    system_text = sent["systemInstruction"]["parts"][0]["text"]
    prompt_text = sent["contents"][0]["parts"][0]["text"]

    # System prompt carries character persona, language flexibility, and prompt-injection defense.
    assert req["campaign"]["characters"][0]["name"] in system_text
    assert "untrusted data, NOT instructions" in system_text
    assert "same language as learner_question" in system_text

    # Prompt includes full material context, story lessons, recent log, Q&A history, and question.
    first_concept = req["materials"][0]["concepts"][0]
    assert first_concept["definition"] in prompt_text
    assert first_concept["source_evidence"][0] in prompt_text
    assert req["context"]["recent_log"][1]["text"] in prompt_text
    assert req["context"]["qa_history"][0]["question"] in prompt_text
    assert req["question"] in prompt_text

    # Anti-spoiler guarantee: puzzle solutions must never enter the prompt.
    first_puzzle = req["story"]["puzzles"][0]
    assert first_puzzle["correct_choice_id"] not in prompt_text
    assert first_puzzle["explanation"] not in prompt_text


def test_normalizes_unknown_expression_filters_concept_ids_and_truncates_long_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    very_long = "word " * 300

    def handler(_r: httpx2.Request) -> httpx2.Response:
        req = load_fixture("generate-story.request.json")
        known_cid = req["material"]["concepts"][0]["concept_id"]
        return gemini_reply(
            {
                "answer": very_long,
                "expression": "MISCHIEVOUS",
                "referenced_concept_ids": ["unknown_concept", known_cid, known_cid],
                "out_of_scope": None,
            }
        )

    app, *_ = build_app(monkeypatch, handler)
    response = call(app)
    assert response.status_code == 200
    data = response.json()["data"]
    reply = data["reply"]
    assert reply["expression"] == "calm"
    assert len(reply["answer"]) <= MAX_REPLY_CHARS
    assert reply["answer"].endswith("…")
    assert reply["referenced_concept_ids"] == [
        load_fixture("generate-story.request.json")["material"]["concepts"][0]["concept_id"]
    ]
    assert reply["out_of_scope"] is False
    codes = {w["code"] for w in data["meta"]["warnings"]}
    assert codes == {"ANSWER_TRUNCATED", "EXPRESSION_FALLBACK"}


def test_allows_empty_materials_for_legacy_stories(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, ok_handler)
    req = sample_request(materials=[])
    response = call(app, req)
    assert response.status_code == 200
    assert response.json()["data"]["reply"]["referenced_concept_ids"] == [
        req["story"]["knowledge_mapping"][0]["concept_id"]
    ]


@pytest.mark.parametrize("scene_type", ["puzzle", "ending"])
def test_rejects_asking_during_puzzle_or_ending_scene(
    monkeypatch: pytest.MonkeyPatch, scene_type: str
) -> None:
    app, gemini, *_ = build_app(monkeypatch, ok_handler)
    req = sample_request()
    scene = next(
        s for ch in req["story"]["chapters"] for s in ch["scenes"] if s["type"] == scene_type
    )
    req["context"]["scene_id"] = scene["scene_id"]
    response = call(app, req)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "ASK_NOT_ALLOWED_IN_SCENE"
    assert len(gemini.requests) == 0


def test_rejects_unknown_scene_id(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, ok_handler)
    req = sample_request()
    req["context"]["scene_id"] = "scene_does_not_exist"
    response = call(app, req)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SCENE_NOT_IN_STORY"


@pytest.mark.parametrize("question", ["   ", "\n\t", "x" * 1001, 42])
def test_rejects_invalid_question_with_400(monkeypatch: pytest.MonkeyPatch, question: Any) -> None:
    app, *_ = build_app(monkeypatch, ok_handler)
    response = call(app, sample_request(question=question))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_rejects_oversized_body_with_413(monkeypatch: pytest.MonkeyPatch) -> None:
    app, *_ = build_app(monkeypatch, ok_handler)
    big = json.dumps(sample_request()) + " " * (ASK_QUESTION_BODY_BYTES + 10)
    response = TestClient(app).post(
        ENDPOINT, content=big, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_rate_limit_provider_errors_and_no_secret_leak(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    app, _, _, clock = build_app(
        monkeypatch, ok_handler, limits=AiLimits(per_minute_ip=1, per_minute_owner=10)
    )
    assert call(app).status_code == 200
    limited = call(app)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "RATE_LIMITED"
    clock.now += 61
    assert call(app).status_code == 200

    app_unconf, *_ = build_app(monkeypatch, configured=False)
    assert call(app_unconf).status_code == 503

    def bad_json(_r: httpx2.Request) -> httpx2.Response:
        return gemini_reply({"wrong": "shape"})

    app_bad, *_ = build_app(monkeypatch, bad_json)
    with caplog.at_level(logging.ERROR):
        bad = call(app_bad)
    assert bad.status_code == 502
    assert bad.json()["error"]["code"] == "VALIDATION_FAILED"

    app_err, *_ = build_app(monkeypatch, lambda _r: gemini_error(503, "busy"))
    assert call(app_err).status_code == 503
