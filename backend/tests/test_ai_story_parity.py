"""Cross-language parity of the Story Generator with the TypeScript implementation.

Why: the backend must give the same answers as the Next.js route it replaces. The snapshot
`fixtures/ai/story-parity.snapshot.json` was produced by running the REAL TypeScript code (story
engine, Gemini provider, service, both validators and `seededShuffle`) on the same inputs, with a
fake Gemini, so these tests compare Python with TypeScript without needing Node. Each run feeds
the same request and the same Gemini reply to the endpoint and compares the whole answer
(blueprint, warnings, errors with `detail`) and the prompt sent to Gemini.

Regenerate the snapshot with the helper script when the TypeScript code changes (it is not part
of the repo: it needs Node 22+ and the frontend's `typescript` and `zod` packages).
"""

from __future__ import annotations

import copy
import hashlib
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.ai.contracts.requests import GenerateStoryRequest
from app.ai.contracts.story import StoryBlueprint
from app.ai.hash import seeded_shuffle
from app.ai.story_generator_engine import StoryEngineError, build_story_blueprint
from app.ai.validation.generator import validate_generated_story
from app.ai.validation.story import validate_story
from tests.ai_support import build_app, gemini_reply, load_fixture

SNAPSHOT = load_fixture("story-parity.snapshot.json")
URL = "/api/v1/ai/generate-story"


def _id(run: dict[str, Any]) -> str:
    return f"{run['case']}-{run['variant']}"


@pytest.mark.parametrize("run", SNAPSHOT["runs"], ids=_id)
def test_endpoint_answers_like_the_typescript_service(
    monkeypatch: pytest.MonkeyPatch, run: dict[str, Any]
) -> None:
    app, gemini, *_ = build_app(monkeypatch, lambda _r: gemini_reply(run["content"]))
    response = TestClient(app).post(URL, json=SNAPSHOT["cases"][run["case"]]["request"])
    body = response.json()
    assert body == run["result"]
    assert response.status_code == (200 if run["result"]["ok"] else response.status_code)

    prompt = gemini.sent_json()["contents"][0]["parts"][0]["text"]
    assert len(prompt) == run["promptLength"]
    if "prompt" in run:
        assert prompt == run["prompt"]
    assert hashlib.sha256(prompt.encode()).hexdigest() == run["promptSha256"]


def test_every_snapshot_case_runs_the_engine_like_typescript() -> None:
    for name, case in SNAPSHOT["cases"].items():
        request = GenerateStoryRequest.model_validate(case["request"])
        engine = build_story_blueprint(request)
        assert not isinstance(engine, StoryEngineError), name
        assert engine.ok is case["engineOk"], name


def apply_patch(base: Any, patch: list[list[Any]]) -> Any:
    result = copy.deepcopy(base)
    for path, value in patch:
        if not path:
            return value
        target = result
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
    return result


@pytest.mark.parametrize("case", SNAPSHOT["validators"], ids=lambda c: c["name"])
def test_validators_report_the_same_errors_as_typescript(case: dict[str, Any]) -> None:
    from app.ai.contracts.campaign import StorySummaryEntry
    from app.ai.contracts.material import MaterialBlueprint

    base = SNAPSHOT["validatorBase"]
    story = StoryBlueprint.model_validate(apply_patch(base["blueprint"], case["blueprint"]))
    material = MaterialBlueprint.model_validate(apply_patch(base["material"], case["material"]))
    entry = StorySummaryEntry.model_validate(apply_patch(base["entry"], case["entry"]))
    previous = [
        StoryBlueprint.model_validate(apply_patch(base["blueprint"], patch))
        for patch in case.get("previous", [])
    ]
    assert validate_generated_story(story, material, entry, previous) == case["generator"]
    assert validate_story(story, material) == case["legacy"]


def test_snapshot_covers_every_error_code_of_the_generator_validator() -> None:
    codes = {e["code"] for case in SNAPSHOT["validators"] for e in case["generator"]}
    assert codes >= {
        "DUPLICATE_CHAPTER_ID",
        "DUPLICATE_PUZZLE_ID",
        "DUPLICATE_CHOICE_ID",
        "DUPLICATE_ENDING_ID",
        "ENDING_SCENE_COUNT",
        "DEAD_END_SCENE",
        "UNREACHABLE_SCENE",
        "ENDING_UNREACHABLE",
        "CONCEPT_NOT_INTRODUCED",
        "CONCEPT_INTRODUCED_TWICE",
        "CONCEPT_NOT_TESTED",
        "CONCEPT_TESTED_TWICE",
        "INVALID_CONCEPT_REF",
        "DUPLICATE_KNOWLEDGE_MAPPING",
        "MISSING_KNOWLEDGE_MAPPING",
        "REQUIRED_KNOWLEDGE_SELF_REFERENCE",
        "REQUIRED_KNOWLEDGE_UNTESTABLE",
        "CONCEPT_PREREQUISITE_CYCLE",
        "INVALID_PUZZLE_REF",
    }


@pytest.mark.parametrize(
    "case", SNAPSHOT["shuffles"], ids=lambda c: f"{c['seed'][:12]!r}-{len(c['items'])}"
)
def test_seeded_shuffle_matches_typescript(case: dict[str, Any]) -> None:
    assert seeded_shuffle(case["items"], case["seed"]) == case["result"]
