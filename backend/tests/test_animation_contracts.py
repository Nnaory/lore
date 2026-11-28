"""Tests for the optional `animation` field on `learning_info` blocks and puzzles (task 14.2).

Why: a story may point at an AI-written animation (Requirement 22). The pointer is optional and
lenient like `visual`: a bad one is dropped without losing the block, the puzzle or the story, and
a story that never had the key must not gain it. Pydantic and Zod must decide alike, so this file
reads the same `reference-*.json` fixtures as `frontend/tests/schemas/animation-reference.test.ts`
(Requirements 22.6, 38.4). `generate-story` must never write the key, even when Gemini sends it
(22.13), and the existing AI fixtures must come out byte-for-byte the same (22.7, 22.15). No
network, no database, no `langgraph` or `boto3`.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.ai.animation import models as models_module
from app.ai.animation.contract import ContractInvalid
from app.ai.animation.models import AnimationReference
from app.ai.contracts.requests import GenerateStoryRequest
from app.ai.contracts.story import LearningContent, Puzzle, StoryBlueprint
from app.ai.prompts.story_generator import SYSTEM_PROMPT, build_story_prompt
from app.ai.story_generator import StoryContent, merge_story_content
from app.ai.story_generator_engine import StoryEngineSuccess, build_story_blueprint
from tests.ai_support import FIXTURES as AI_FIXTURES
from tests.ai_support import build_app, gemini_reply, load_fixture

FIXTURES = Path(__file__).parent / "fixtures" / "animation"
BACKEND_DIR = Path(__file__).resolve().parent.parent
STORY = "/api/v1/ai/generate-story"
REQUEST = load_fixture("generate-story.request.json")
GEMINI_OUTPUT = load_fixture("generate-story.gemini-output.json")

LESSON_BLOCK: dict[str, Any] = {
    "type": "learning_info",
    "title": "Vectors",
    "body": "A vector has a length and a direction.",
    "concept_ids": ["concept_1"],
}
PUZZLE: dict[str, Any] = {
    "puzzle_id": "puzzle_1",
    "concept_ids": ["concept_1"],
    "narrative_context": "The lantern flickers.",
    "question": "Which statement is correct?",
    "choices": [{"choice_id": "a", "text": "This one"}, {"choice_id": "b", "text": "That one"}],
    "correct_choice_id": "a",
    "explanation": "It follows from the definition.",
    "incorrect_feedback": "Try again.",
    "correct_feedback": "Yes.",
    "retry_allowed": True,
}
KNOWN_KEYS = set(AnimationReference.model_fields)


def _load(stem: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{stem}.json").read_text(encoding="utf-8"))


def _stems(pattern: str) -> list[str]:
    return sorted(path.stem for path in FIXTURES.glob(f"{pattern}.json"))


VALID = _stems("reference-valid-*")
INVALID = _stems("reference-invalid-*")


def _known(raw: dict[str, Any]) -> dict[str, Any]:
    """What a valid reference dumps to: known keys only, whole-number floats as integers."""
    return {
        key: int(value) if isinstance(value, float) else value
        for key, value in raw.items()
        if key in KNOWN_KEYS
    }


def _lesson(animation: object) -> LearningContent:
    return LearningContent.model_validate({**LESSON_BLOCK, "animation": animation})


def _puzzle(animation: object) -> Puzzle:
    return Puzzle.model_validate({**PUZZLE, "animation": animation})


def _keys_named(node: object, name: str) -> list[str]:
    """JSON paths of every dict key called `name` anywhere under `node`."""
    found: list[str] = []

    def walk(value: object, path: str) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                here = f"{path}.{key}" if path else str(key)
                if key == name:
                    found.append(here)
                walk(child, here)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{path}[{index}]")

    walk(node, "")
    return found


def _learning_blocks(blueprint: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        block
        for chapter in blueprint["chapters"]
        for scene in chapter["scenes"]
        for block in scene.get("content", [])
        if block["type"] == "learning_info"
    ]


def _with_animation(
    blueprint: dict[str, Any], *, lesson: object = None, puzzle: object = None
) -> dict[str, Any]:
    """A copy of `blueprint` with `animation` set on every lesson block and every puzzle."""
    copied = copy.deepcopy(blueprint)
    for block in _learning_blocks(copied):
        block["animation"] = lesson
    for item in copied["puzzles"]:
        item["animation"] = puzzle
    return copied


SUCCESS_FILES = sorted(path.name for path in AI_FIXTURES.glob("generate-story*.success.json"))
# The story the endpoint returns for the standard request: lesson blocks, puzzles, no animation.
BASE: dict[str, Any] = load_fixture("generate-story.success.json")["data"]["blueprint"]


# --- the shared fixtures (same decisions as Vitest) --------------------------------------------


def test_the_reference_fixture_folder_has_valid_and_invalid_files() -> None:
    assert VALID
    assert INVALID


@pytest.mark.parametrize("stem", VALID)
def test_a_valid_reference_is_kept_only_where_its_pause_rule_allows(stem: str) -> None:
    raw = _load(stem)
    at_puzzle = "pause_at_frame" in raw
    lesson, puzzle = _lesson(raw), _puzzle(raw)
    kept, dropped = (puzzle, lesson) if at_puzzle else (lesson, puzzle)
    assert kept.dump()["animation"] == _known(raw)
    assert dropped.animation is None
    assert "animation" not in dropped.dump()
    # The block or puzzle itself is unchanged by the field.
    expected_lesson = LESSON_BLOCK if at_puzzle else {**LESSON_BLOCK, "animation": _known(raw)}
    expected_puzzle = {**PUZZLE, "animation": _known(raw)} if at_puzzle else PUZZLE
    assert lesson.dump() == expected_lesson
    assert puzzle.dump() == expected_puzzle


@pytest.mark.parametrize("stem", INVALID)
def test_an_invalid_reference_is_dropped_and_the_block_stays_valid(stem: str) -> None:
    raw = _load(stem)
    # Not dropped only because of the pause rule: the reference itself is invalid.
    with pytest.raises(ValidationError):
        AnimationReference.model_validate(raw)
    lesson, puzzle = _lesson(raw), _puzzle(raw)
    assert lesson.animation is None
    assert puzzle.animation is None
    assert lesson.dump() == LESSON_BLOCK
    assert puzzle.dump() == PUZZLE


@pytest.mark.parametrize("stem", VALID)
def test_the_lesson_and_puzzle_readers_agree_with_the_strict_reference(stem: str) -> None:
    raw = _load(stem)
    strict = AnimationReference.model_validate(raw).dump()
    where = _puzzle(raw) if "pause_at_frame" in raw else _lesson(raw)
    assert where.dump()["animation"] == strict


def test_unknown_keys_of_a_reference_are_dropped() -> None:
    raw = _load("reference-valid-unknown-key-dropped")
    assert "future_field" in raw
    dumped = _lesson(raw).dump()
    assert dumped["animation"] == _known(raw)
    assert "future_field" not in json.dumps(dumped)


# --- the pause rule (Requirement 22.4) ---------------------------------------------------------


@pytest.mark.parametrize("pause", [1, 100, 0, None, "x", 12.5])
def test_a_lesson_reference_with_a_pause_key_is_dropped_whatever_its_value(pause: object) -> None:
    raw = {**_load("reference-valid-lesson"), "pause_at_frame": pause}
    assert _lesson(raw).animation is None


def test_a_puzzle_reference_without_a_pause_key_is_dropped() -> None:
    assert _puzzle(_load("reference-valid-lesson")).animation is None


def test_a_puzzle_reference_with_a_null_pause_is_dropped() -> None:
    raw = {**_load("reference-valid-puzzle"), "pause_at_frame": None}
    assert _puzzle(raw).animation is None


def test_a_puzzle_pause_must_be_before_the_last_frame() -> None:
    raw = _load("reference-valid-puzzle")
    last = raw["duration_in_frames"]
    assert _puzzle({**raw, "pause_at_frame": last - 1}).animation is not None
    assert _puzzle({**raw, "pause_at_frame": last}).animation is None
    assert _puzzle({**raw, "pause_at_frame": 0}).animation is None


def test_a_lesson_dump_has_no_pause_key_and_a_puzzle_dump_has_one() -> None:
    lesson = _lesson(_load("reference-valid-lesson")).dump()["animation"]
    puzzle = _puzzle(_load("reference-valid-puzzle")).dump()["animation"]
    assert "pause_at_frame" not in lesson
    assert puzzle["pause_at_frame"] == _load("reference-valid-puzzle")["pause_at_frame"]


# --- lenient: anything that is not a valid reference is dropped (Requirement 22.3) -------------


@pytest.mark.parametrize(
    "junk",
    [
        None,
        "an animation",
        7,
        True,
        [],
        [_load("reference-valid-lesson")],
        {},
        _load("reference-invalid-camelcase-keys"),
        _load("reference-invalid-id-uppercase"),
    ],
    ids=[
        "null",
        "string",
        "number",
        "boolean",
        "empty-array",
        "array",
        "empty-object",
        "camel-case",
        "bad-id",
    ],
)
def test_junk_is_dropped_without_failing_the_block_or_the_puzzle(junk: object) -> None:
    assert _lesson(junk).animation is None
    assert _puzzle(junk).animation is None
    assert _lesson(junk).dump() == LESSON_BLOCK
    assert _puzzle(junk).dump() == PUZZLE


def test_a_valid_visual_survives_next_to_a_dropped_reference() -> None:
    visual = {"kind": "formula", "expression": "a + b", "terms": [{"symbol": "a", "meaning": "x"}]}
    block = LearningContent.model_validate({**LESSON_BLOCK, "visual": visual, "animation": "no"})
    puzzle = Puzzle.model_validate({**PUZZLE, "visual": visual, "animation": None})
    assert block.dump()["visual"]["kind"] == "formula"
    assert puzzle.dump()["visual"]["kind"] == "formula"
    assert "animation" not in block.dump()
    assert "animation" not in puzzle.dump()


def test_the_rest_of_the_puzzle_is_still_validated() -> None:
    with pytest.raises(ValidationError):
        Puzzle.model_validate(
            {**PUZZLE, "correct_choice_id": "nope", "animation": _load("reference-valid-puzzle")}
        )


def test_a_missing_contract_drops_the_reference_and_keeps_the_story(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(models_module, "load_contract", lambda: ContractInvalid("broken"))
    assert _lesson(_load("reference-valid-lesson")).dump() == LESSON_BLOCK
    assert _puzzle(_load("reference-valid-puzzle")).dump() == PUZZLE


# --- a story without the key does not gain it (Requirement 22.15) ------------------------------


def test_a_block_and_a_puzzle_without_the_key_do_not_gain_it() -> None:
    block = LearningContent.model_validate(LESSON_BLOCK)
    puzzle = Puzzle.model_validate(PUZZLE)
    assert block.dump() == LESSON_BLOCK
    assert puzzle.dump() == PUZZLE
    assert "animation" not in block.model_fields_set
    assert "animation" not in puzzle.model_fields_set


def test_there_are_existing_ai_stories_to_compare() -> None:
    assert len(SUCCESS_FILES) >= 2


@pytest.mark.parametrize("name", SUCCESS_FILES)
def test_existing_ai_stories_round_trip_with_no_animation_key(name: str) -> None:
    blueprint = load_fixture(name)["data"]["blueprint"]
    dumped = StoryBlueprint.model_validate(blueprint).dump()
    assert dumped == blueprint
    assert _keys_named(dumped, "animation") == []


# --- inside a whole story ----------------------------------------------------------------------


def test_a_story_keeps_valid_references_on_lessons_and_puzzles() -> None:
    base = BASE
    lesson, puzzle = _load("reference-valid-lesson"), _load("reference-valid-puzzle")
    story = StoryBlueprint.model_validate(_with_animation(base, lesson=lesson, puzzle=puzzle))
    dumped = story.dump()
    assert all(block["animation"] == _known(lesson) for block in _learning_blocks(dumped))
    assert all(item["animation"] == _known(puzzle) for item in dumped["puzzles"])
    assert len(_keys_named(dumped, "animation")) == len(_learning_blocks(base)) + len(
        base["puzzles"]
    )


def test_a_story_round_trips_through_json_unchanged() -> None:
    base = BASE
    raw = _with_animation(
        base, lesson=_load("reference-valid-lesson"), puzzle=_load("reference-valid-puzzle")
    )
    first = StoryBlueprint.model_validate(raw).dump()
    second = StoryBlueprint.model_validate(json.loads(json.dumps(first))).dump()
    assert second == first


@pytest.mark.parametrize("stem", INVALID)
def test_invalid_references_leave_the_story_exactly_as_it_was(stem: str) -> None:
    base = BASE
    raw = _load(stem)
    story = StoryBlueprint.model_validate(_with_animation(base, lesson=raw, puzzle=raw))
    assert story.dump() == StoryBlueprint.model_validate(base).dump()


def test_references_at_the_wrong_location_are_dropped_from_a_story() -> None:
    base = BASE
    swapped = _with_animation(
        base, lesson=_load("reference-valid-puzzle"), puzzle=_load("reference-valid-lesson")
    )
    assert _keys_named(StoryBlueprint.model_validate(swapped).dump(), "animation") == []


# --- generate-story never writes the key (Requirements 22.7, 22.13) ----------------------------


def _inject(content: dict[str, Any], lesson: object, puzzle: object) -> dict[str, Any]:
    """Gemini's output with `animation` added at every level it could be sent."""
    out = copy.deepcopy(content)
    out["animation"] = lesson
    out["intro"]["animation"] = lesson
    out["ending"]["animation"] = lesson
    for concept in out["concepts"]:
        concept["animation"] = lesson
        concept["puzzle"]["animation"] = puzzle
        if isinstance(concept["puzzle"].get("visual"), dict):
            concept["puzzle"]["visual"]["animation"] = puzzle
        for step in concept.get("lesson_steps", []):
            step["animation"] = lesson
            if isinstance(step.get("visual"), dict):
                step["visual"]["animation"] = lesson
        if isinstance(concept.get("lesson_visual"), dict):
            concept["lesson_visual"]["animation"] = lesson
    return out


def _generate(monkeypatch: pytest.MonkeyPatch, content: dict[str, Any]) -> httpx2.Response:
    app, *_ = build_app(monkeypatch, lambda _request: gemini_reply(content))
    return TestClient(app).post(STORY, json=REQUEST)


INJECTED = {
    "valid-references": (_load("reference-valid-lesson"), _load("reference-valid-puzzle")),
    "null": (None, None),
    "junk": ("an animation", {"animation_id": "x"}),
}


@pytest.mark.parametrize("which", sorted(INJECTED))
def test_generate_story_drops_animation_sent_by_gemini(
    monkeypatch: pytest.MonkeyPatch, which: str
) -> None:
    lesson, puzzle = INJECTED[which]
    sent = _inject(GEMINI_OUTPUT, lesson, puzzle)
    assert len(_keys_named(sent, "animation")) > 5  # the injection really happened
    response = _generate(monkeypatch, sent)
    assert response.status_code == 200
    body = response.json()
    assert _keys_named(body, "animation") == []
    # Same answer as for the plain Gemini output: nothing else moved (Requirement 22.7).
    assert body == load_fixture("generate-story.success.json")


def test_the_merge_ignores_animation_in_gemini_content() -> None:
    request = GenerateStoryRequest.model_validate(REQUEST)
    skeleton = build_story_blueprint(request)
    assert isinstance(skeleton, StoryEngineSuccess)
    reference = _load("reference-valid-lesson")
    sent = _inject(GEMINI_OUTPUT, reference, reference)
    assert _keys_named(sent, "animation")
    content = StoryContent.model_validate(sent)
    merged = merge_story_content(skeleton.blueprint, content).blueprint
    assert _keys_named(merged, "animation") == []
    assert _keys_named(StoryBlueprint.model_validate(merged).dump(), "animation") == []
    plain = merge_story_content(skeleton.blueprint, StoryContent.model_validate(GEMINI_OUTPUT))
    assert merged == plain.blueprint


def test_the_story_prompt_never_asks_for_an_animation() -> None:
    request = GenerateStoryRequest.model_validate(REQUEST)
    skeleton = build_story_blueprint(request)
    assert isinstance(skeleton, StoryEngineSuccess)
    prompt = SYSTEM_PROMPT + build_story_prompt(request, skeleton.blueprint)
    assert "animation" not in prompt.lower()


# --- imports (Requirement 41.1) ----------------------------------------------------------------


def test_importing_the_story_contract_imports_no_heavy_packages() -> None:
    """`app.main` loads the story contract on every start, so it must stay cheap."""
    code = (
        "import sys\n"
        "import app.ai.contracts.story\n"
        "heavy = ['boto3', 'botocore', 'langgraph']\n"
        "found = [m for m in heavy if m in sys.modules]\n"
        "assert not found, found\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert done.returncode == 0, done.stderr
