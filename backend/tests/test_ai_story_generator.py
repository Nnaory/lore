"""Unit tests for the Story Generator pieces (no network, no database).

Why: parity with the TypeScript tests `story-generator-engine`, `story-generator-types`,
`generator-validator`, `story.schema`, `scene.schema`, `puzzle.schema` and the Gemini story
provider's merge. They use a three-material campaign taken from the frontend's dummy data (the
same fixture the TypeScript tests plan with) so the cases are realistic: several concepts,
misconceptions, notation and cross-story `required_knowledge`. End-to-end behaviour of the
endpoint is in `test_ai_generate_story.py`; byte-for-byte agreement with the TypeScript answers
is in `test_ai_story_parity.py`.
"""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest
from pydantic import ValidationError

from app.ai.contracts.requests import GenerateStoryRequest
from app.ai.contracts.story import (
    Ending,
    LearningContent,
    Puzzle,
    StoryBlueprint,
)
from app.ai.hash import seeded_shuffle
from app.ai.story_generator import (
    MAX_LESSON_STEPS,
    StoryContent,
    merge_story_content,
)
from app.ai.story_generator_engine import (
    StoryEngineError,
    StoryEngineSuccess,
    build_story_blueprint,
    order_concepts,
)
from app.ai.validation.generator import validate_generated_story
from app.ai.validation.story import validate_story
from app.ai.zod_compat import zod_flatten
from tests.ai_support import load_fixture

CASES = load_fixture("story-parity.snapshot.json")["cases"]


def request_of(name: str = "dummy0", **overrides: Any) -> GenerateStoryRequest:
    body = copy.deepcopy(CASES[name]["request"])
    body.update(overrides)
    return GenerateStoryRequest.model_validate(body)


def dummy_request(index: int) -> GenerateStoryRequest:
    """Story `index` of the dummy campaign with its own material."""
    base = CASES["dummy0"]["request"]
    entry = base["campaign"]["story_sequence"][index]
    materials = {
        CASES["dummy0"]["request"]["material"]["material_id"]: CASES["dummy0"]["request"][
            "material"
        ],
        CASES["dummy1"]["request"]["material"]["material_id"]: CASES["dummy1"]["request"][
            "material"
        ],
        CASES["dummy2"]["request"]["material"]["material_id"]: CASES["dummy2"]["request"][
            "material"
        ],
    }
    return GenerateStoryRequest.model_validate(
        {"campaign": base["campaign"], "story": entry, "material": materials[entry["material_id"]]}
    )


def build(request: GenerateStoryRequest) -> dict[str, Any]:
    result = build_story_blueprint(request)
    assert isinstance(result, StoryEngineSuccess), getattr(result, "message", "")
    return result.blueprint


def scenes_of(blueprint: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for chapter in blueprint["chapters"] for s in chapter["scenes"]]


STORIES = [0, 1, 2]


# --- engine: structure ------------------------------------------------------------------------


@pytest.mark.parametrize("index", STORIES)
def test_engine_output_passes_the_schema_and_both_validators(index: int) -> None:
    request = dummy_request(index)
    blueprint = build(request)
    model = StoryBlueprint.model_validate(blueprint)
    assert validate_story(model, request.material) == []
    assert validate_generated_story(model, request.material, request.story, []) == []


@pytest.mark.parametrize("index", STORIES)
def test_engine_binds_ids_to_the_campaign_entry(index: int) -> None:
    request = dummy_request(index)
    blueprint = build(request)
    assert blueprint["story_id"] == request.story.story_id
    assert blueprint["material_id"] == request.story.material_id
    assert blueprint["title"] == request.story.title
    campaign_characters = {c.character_id for c in request.campaign.characters}
    assert set(blueprint["character_ids"]) <= campaign_characters


def test_engine_emits_one_ending_and_one_ending_scene() -> None:
    blueprint = build(dummy_request(0))
    assert len(blueprint["endings"]) == 1
    assert [s["type"] for s in scenes_of(blueprint)].count("ending") == 1


def test_engine_walks_from_the_intro_to_the_ending_without_dead_ends() -> None:
    blueprint = build(dummy_request(0))
    index = {s["scene_id"]: s for s in scenes_of(blueprint)}
    current = blueprint["chapters"][0]["scenes"][0]
    assert "intro" in current["scene_id"]
    visited: set[str] = set()
    while current["type"] != "ending":
        assert current["scene_id"] not in visited
        visited.add(current["scene_id"])
        assert current["next_scene_id"] is not None
        current = index[current["next_scene_id"]]
    assert len(visited) == len(index) - 1


def test_engine_orders_learning_then_puzzle_then_result_for_each_concept() -> None:
    scenes = scenes_of(build(dummy_request(0)))
    for i, scene in enumerate(scenes):
        if scene["type"] == "learning":
            assert scenes[i + 1]["type"] == "puzzle"
            assert scenes[i + 2]["type"] == "consequence"


def test_engine_teaches_and_tests_every_concept_once() -> None:
    for index in STORIES:
        request = dummy_request(index)
        blueprint = build(request)
        mapped = [m["concept_id"] for m in blueprint["knowledge_mapping"]]
        assert sorted(mapped) == sorted(c.concept_id for c in request.material.concepts)
        for mapping in blueprint["knowledge_mapping"]:
            puzzle = next(
                p for p in blueprint["puzzles"] if p["puzzle_id"] == mapping["tested_in_puzzle_id"]
            )
            assert puzzle["concept_ids"] == [mapping["concept_id"]]


def test_engine_uses_expression_keys_the_character_owns() -> None:
    request = dummy_request(0)
    blueprint = build(request)
    by_id = {c.character_id: c for c in request.campaign.characters}
    dialogue = [
        b for s in scenes_of(blueprint) for b in s.get("content", []) if b["type"] == "dialogue"
    ]
    assert dialogue
    for block in dialogue:
        assert block["expression"] in by_id[block["character_id"]].expressions


def test_engine_expression_falls_back_to_integer_like_keys_first_like_javascript() -> None:
    # `Object.keys` lists "1" and "2" before "zeta"; none of the preferred names exist.
    blueprint = build(request_of("intKeys"))
    first_dialogue = next(
        b for b in blueprint["chapters"][0]["scenes"][0]["content"] if b["type"] == "dialogue"
    )
    assert first_dialogue["expression"] == "1"


def test_engine_puzzles_are_multiple_choice_with_a_resolvable_answer() -> None:
    request = dummy_request(0)
    blueprint = build(request)
    concepts = {c.concept_id: c for c in request.material.concepts}
    for puzzle in blueprint["puzzles"]:
        ids = [c["choice_id"] for c in puzzle["choices"]]
        assert len(ids) >= 2 and len(set(ids)) == len(ids)
        assert puzzle["correct_choice_id"] in ids
        concept = concepts[puzzle["concept_ids"][0]]
        correct = next(
            c for c in puzzle["choices"] if c["choice_id"] == puzzle["correct_choice_id"]
        )
        assert correct["text"] == concept.definition
        wrong = [
            c["text"] for c in puzzle["choices"] if c["choice_id"] != puzzle["correct_choice_id"]
        ]
        if concept.misconceptions:
            assert wrong[0] in concept.misconceptions
        assert puzzle["retry_allowed"] is True


def test_engine_uses_fallback_distractors_and_warns_when_there_are_no_misconceptions() -> None:
    result = build_story_blueprint(request_of("noMisconceptions"))
    assert isinstance(result, StoryEngineSuccess)
    assert [w["code"] for w in result.warnings] == ["PUZZLE_DISTRACTOR_SUBSTITUTED"] * 2
    puzzle = result.blueprint["puzzles"][0]
    assert puzzle["choices"][1]["text"].startswith("Any rule applies to ")
    assert result.warnings[0]["path"] == "puzzles[puzzle_story_01_c01].choices"


def test_engine_is_deterministic_and_does_not_mutate_the_request() -> None:
    request = dummy_request(0)
    before = request.model_dump_json()
    first = build_story_blueprint(request)
    second = build_story_blueprint(request)
    assert first == second
    assert request.model_dump_json() == before


def test_engine_result_does_not_share_state_with_the_request() -> None:
    request = dummy_request(0)
    blueprint = build(request)
    blueprint["endings"][0]["world_state_changes"]["injected"] = 1
    again = build(request)
    assert "injected" not in again["endings"][0]["world_state_changes"]
    assert "injected" not in request.story.outcomes[0].world_state_changes


# --- engine: errors, continuity, chapters -----------------------------------------------------


def test_engine_rejects_a_story_that_is_not_in_the_campaign() -> None:
    request = dummy_request(0)
    other = request.story.model_copy(update={"story_id": "story_missing"})
    result = build_story_blueprint(request.model_copy(update={"story": other}))
    assert isinstance(result, StoryEngineError)
    assert result.code == "STORY_NOT_IN_CAMPAIGN"
    assert result.message == (
        f'Story "story_missing" is not part of campaign "{request.campaign.campaign_id}".'
    )


def test_engine_rejects_a_material_that_does_not_match_the_entry() -> None:
    request = dummy_request(0)
    result = build_story_blueprint(
        request.model_copy(update={"material": dummy_request(1).material})
    )
    assert isinstance(result, StoryEngineError)
    assert result.code == "MATERIAL_MISMATCH"


def test_engine_rejects_a_material_without_concepts() -> None:
    request = dummy_request(0)
    empty = request.material.model_copy(update={"concepts": []})
    result = build_story_blueprint(request.model_copy(update={"material": empty}))
    assert isinstance(result, StoryEngineError)
    assert result.code == "CONCEPT_COVERAGE"


def test_engine_fills_the_continuity_summary_from_the_entry_outcome() -> None:
    request = dummy_request(0)
    blueprint = build(request)
    summary = blueprint["continuity_summary"]
    assert summary["story_id"] == request.story.story_id
    assert summary["key_decisions"] == []
    outcome = request.story.outcomes[0]
    assert summary["outcome_description"] == outcome.description
    assert blueprint["endings"][0]["world_state_changes"] == outcome.world_state_changes
    assert summary["world_state_snapshot"] == outcome.world_state_changes
    assert summary["relationship_snapshot"] == blueprint["endings"][0]["relationship_changes"]


def test_engine_warns_about_missing_context_only_without_previous_summaries() -> None:
    request = dummy_request(1)
    assert request.story.required_knowledge
    result = build_story_blueprint(request)
    assert isinstance(result, StoryEngineSuccess)
    assert [w["code"] for w in result.warnings] == ["CONTINUITY_CONTEXT_MISSING"]
    with_summary = request_of(
        "dummy0",
        story=CASES["dummy0"]["request"]["campaign"]["story_sequence"][1],
        material=CASES["dummy1"]["request"]["material"],
        previousSummaries=[
            {
                "story_id": "story_01",
                "title": "Done",
                "outcome_description": "Resolved",
                "world_state_snapshot": {"stability": 10},
                "relationship_snapshot": {},
            }
        ],
    )
    result = build_story_blueprint(with_summary)
    assert isinstance(result, StoryEngineSuccess)
    assert result.warnings == []


def test_intro_mentions_the_last_summary_and_falls_back_to_its_title() -> None:
    plain = build(request_of("one"))
    assert len(plain["chapters"][0]["scenes"][0]["content"]) == 2
    fallback = build(request_of("emptyPrev"))
    last = fallback["chapters"][0]["scenes"][0]["content"][-1]
    assert last == {
        "type": "narration",
        "text": "What came before still shapes this moment: Fallback title.",
    }


def test_intro_dialogue_strips_the_planner_prefix_from_the_purpose() -> None:
    blueprint = build(request_of("introducePurpose"))
    dialogue = blueprint["chapters"][0]["scenes"][0]["content"][1]
    assert dialogue["text"] == (
        "We are here because of vectors \u2014 \u00e9\u4e2d. Nothing about that is optional."
    )


def test_a_single_character_campaign_has_no_companion_lines() -> None:
    blueprint = build(request_of("oneChar"))
    assert blueprint["character_ids"] == ["char_01"]
    learning = next(s for s in scenes_of(blueprint) if s["type"] == "learning")
    assert [b["type"] for b in learning["content"]] == ["learning_info"]


def test_concepts_are_ordered_by_prerequisites_then_material_order() -> None:
    concepts = request_of("one").material.concepts
    assert [c.concept_id for c in order_concepts(list(reversed(concepts)))] == [
        "concept_1xfqqww_01",
        "concept_1xfqqww_02",
    ]
    cyclic = request_of("cyclic").material.concepts
    # A cycle keeps the input order so generation stays total (the validator reports it).
    assert [c.concept_id for c in order_concepts(list(cyclic))] == [
        "concept_1xfqqww_01",
        "concept_1xfqqww_02",
    ]


def test_default_is_one_chapter_and_a_small_option_splits_them() -> None:
    assert len(build(dummy_request(0))["chapters"]) == 1
    request = dummy_request(0).model_copy(
        update={"options": request_of("dummy2").options}  # conceptsPerChapter: 1
    )
    chapters = build(request)["chapters"]
    assert len(chapters) == len(request.material.concepts)
    flat = [s for c in chapters for s in c["scenes"]]
    for scene, following in zip(flat, flat[1:], strict=False):
        if scene["type"] != "ending":
            assert scene["next_scene_id"] == following["scene_id"]
    assert chapters[0]["title"].endswith("\u2014 Part 1")
    assert chapters[0]["chapter_id"].endswith("_01")


# --- merge ------------------------------------------------------------------------------------


def skeleton_of(name: str = "one") -> tuple[GenerateStoryRequest, dict[str, Any]]:
    request = request_of(name)
    return request, build(request)


def learning_blocks(blueprint: dict[str, Any], scene_id: str) -> list[dict[str, Any]]:
    scene = next(s for s in scenes_of(blueprint) if s["scene_id"] == scene_id)
    return scene["content"]


C1, C2 = "concept_1xfqqww_01", "concept_1xfqqww_02"
L1 = "scene_story_01_c01_learning"
STEP = {"title": "A step", "body": "Some body text."}
GOOD_VISUAL = {"kind": "formula", "expression": "a + b", "terms": [{"symbol": "a", "meaning": "x"}]}
GOOD_PUZZLE = {
    "narrative_context": "ctx",
    "question": "Q?",
    "correct_answer": "Right",
    "wrong_answers": ["Wrong one", "Wrong two"],
    "explanation": "why",
    "correct_feedback": "yes",
    "incorrect_feedback": "hint",
}


def merge(content: dict[str, Any], name: str = "one") -> Any:
    _, skeleton = skeleton_of(name)
    return merge_story_content(skeleton, StoryContent.model_validate(content))


def test_merge_does_not_touch_the_skeleton() -> None:
    _, skeleton = skeleton_of()
    before = copy.deepcopy(skeleton)
    merge_story_content(
        skeleton,
        StoryContent.model_validate(
            {"intro": {"narration": "n"}, "concepts": [{"concept_id": C1, "lesson_steps": [STEP]}]}
        ),
    )
    assert skeleton == before


def test_at_most_four_lesson_steps_are_kept_and_companion_lines_sit_between_them() -> None:
    steps = [{**STEP, "title": f"Step {i}", "companion_line": f"Line {i}"} for i in range(1, 7)]
    result = merge({"concepts": [{"concept_id": C1, "lesson_steps": steps}]})
    blocks = learning_blocks(result.blueprint, L1)
    lessons = [b for b in blocks if b["type"] == "learning_info"]
    assert [b["title"] for b in lessons] == ["Step 1", "Step 2", "Step 3", "Step 4"]
    assert len(lessons) == MAX_LESSON_STEPS
    assert [b["type"] for b in blocks] == [
        "dialogue",  # the companion's opening line
        "learning_info",
        "dialogue",
        "learning_info",
        "dialogue",
        "learning_info",
        "dialogue",
        "learning_info",
    ]
    # Step 1's own companion line is ignored; steps 2 to 4 speak as the same character.
    assert [b["text"] for b in blocks if b["type"] == "dialogue"][1:] == [
        "Line 2",
        "Line 3",
        "Line 4",
    ]
    assert all(b["concept_ids"] == [C1] for b in lessons)


def test_an_unusable_step_is_skipped_and_the_rest_are_kept() -> None:
    steps = ["text", {"title": "", "body": "x"}, {**STEP, "body": "b" * 1601}, STEP]
    result = merge({"concepts": [{"concept_id": C1, "lesson_steps": steps}]})
    lessons = [b for b in learning_blocks(result.blueprint, L1) if b["type"] == "learning_info"]
    assert [b["title"] for b in lessons] == ["A step"]


def test_without_usable_steps_the_single_lesson_form_is_used() -> None:
    result = merge(
        {
            "concepts": [
                {
                    "concept_id": C1,
                    "lesson_steps": [],
                    "lesson_title": "Single",
                    "lesson_body": "Single body.",
                    "lesson_visual": GOOD_VISUAL,
                }
            ]
        }
    )
    lesson = learning_blocks(result.blueprint, L1)[-1]
    assert lesson["title"] == "Single"
    assert lesson["body"] == "Single body."
    assert lesson["visual"]["kind"] == "formula"
    assert result.templated.count(f"lesson:{C1}") == 0


def test_without_a_lesson_body_the_template_body_stays_and_is_reported() -> None:
    result = merge({"concepts": [{"concept_id": C1, "lesson_title": "Only a title"}]})
    lesson = learning_blocks(result.blueprint, L1)[-1]
    assert lesson["title"] == "Only a title"
    assert lesson["body"].startswith("A vector is a quantity")
    assert f"lesson:{C1}" in result.templated


def test_invalid_visuals_are_dropped_once_per_concept_and_the_step_stays() -> None:
    steps = [
        {**STEP, "visual": {"kind": "plot", "series": []}},
        {**STEP, "visual": None},
        {**STEP, "visual": "text"},
        {**STEP, "visual": GOOD_VISUAL},
        STEP,
    ]
    result = merge({"concepts": [{"concept_id": C1, "lesson_steps": steps}]})
    lessons = [b for b in learning_blocks(result.blueprint, L1) if b["type"] == "learning_info"]
    assert [("visual" in b) for b in lessons] == [False, False, False, True]
    assert result.dropped_visuals == [C1]


def test_a_valid_visual_is_returned_in_its_normalised_form() -> None:
    visual = {
        "kind": "vectors",
        "vectors": [{"from": [0, 0], "to": [3, 4], "label": "  v  ", "unknown": 1}],
        "extra": True,
    }
    result = merge({"concepts": [{"concept_id": C1, "lesson_steps": [{**STEP, "visual": visual}]}]})
    block = learning_blocks(result.blueprint, L1)[-1]
    assert block["visual"] == {
        "kind": "vectors",
        "vectors": [{"from": [0.0, 0.0], "to": [3.0, 4.0], "label": "v"}],
    }
    StoryBlueprint.model_validate(result.blueprint)


def test_a_concept_the_model_did_not_write_keeps_its_template() -> None:
    result = merge({"concepts": [{"concept_id": C1, "lesson_steps": [STEP]}]})
    assert result.templated == [
        "intro.narration",
        "puzzle:puzzle_story_01_c01",
        f"concept:{C2}",
        "ending.narration",
    ]
    skeleton = skeleton_of()[1]
    second = next(s for s in scenes_of(result.blueprint) if s["scene_id"].endswith("c02_learning"))
    assert second == next(s for s in scenes_of(skeleton) if s["scene_id"].endswith("c02_learning"))


def test_unknown_concepts_and_malformed_entries_are_ignored() -> None:
    content = {"concepts": [{"concept_id": "ghost", "lesson_body": "x"}, 5, {"no_id": True}]}
    result = merge(content)
    assert result.templated == [
        "intro.narration",
        f"concept:{C1}",
        f"concept:{C2}",
        "ending.narration",
    ]


def test_puzzle_wording_replaces_the_template_and_keeps_the_correct_choice_id() -> None:
    result = merge({"concepts": [{"concept_id": C1, "puzzle": GOOD_PUZZLE}]})
    puzzle = next(p for p in result.blueprint["puzzles"] if p["puzzle_id"] == "puzzle_story_01_c01")
    assert puzzle["question"] == "Q?"
    assert puzzle["correct_choice_id"] == "choice_story_01_c01_a"
    texts = {c["choice_id"]: c["text"] for c in puzzle["choices"]}
    assert texts == {
        "choice_story_01_c01_a": "Right",
        "puzzle_story_01_c01_w1": "Wrong one",
        "puzzle_story_01_c01_w2": "Wrong two",
    }
    assert puzzle["retry_allowed"] is True
    assert puzzle["concept_ids"] == [C1]


@pytest.mark.parametrize(
    "puzzle",
    [
        None,
        "text",
        {**GOOD_PUZZLE, "wrong_answers": ["only one"]},
        {**GOOD_PUZZLE, "wrong_answers": ["a", "b", "c", "d"]},
        {**GOOD_PUZZLE, "wrong_answers": ["Right", " RIGHT "]},  # duplicates of the answer
        {**GOOD_PUZZLE, "wrong_answers": ["Same", "same  "]},  # duplicates of each other
        {**GOOD_PUZZLE, "question": "q" * 401},
        {**GOOD_PUZZLE, "explanation": ""},
        {key: value for key, value in GOOD_PUZZLE.items() if key != "correct_feedback"},
    ],
)
def test_an_unusable_puzzle_keeps_the_template_puzzle(puzzle: Any) -> None:
    result = merge({"concepts": [{"concept_id": C1, "puzzle": puzzle}]})
    assert "puzzle:puzzle_story_01_c01" in result.templated
    stored = next(p for p in result.blueprint["puzzles"] if p["puzzle_id"] == "puzzle_story_01_c01")
    assert stored["question"] == "Which statement correctly describes Vector and magnitude?"


def test_choices_are_shuffled_deterministically_without_losing_any() -> None:
    result = merge({})
    for puzzle in result.blueprint["puzzles"]:
        skeleton = next(
            p for p in skeleton_of()[1]["puzzles"] if p["puzzle_id"] == puzzle["puzzle_id"]
        )
        assert sorted(c["choice_id"] for c in puzzle["choices"]) == sorted(
            c["choice_id"] for c in skeleton["choices"]
        )
    assert merge({}).blueprint["puzzles"] == result.blueprint["puzzles"]


def test_result_scene_and_ending_text_are_written() -> None:
    result = merge(
        {
            "intro": {"narration": "Intro text", "guide_line": "Guide says"},
            "concepts": [
                {"concept_id": C1, "result_narration": "It worked.", "guide_line": "Well done."}
            ],
            "ending": {"title": "Finale", "narration": "Everything ends."},
        }
    )
    scenes = {s["scene_id"]: s for s in scenes_of(result.blueprint)}
    assert scenes["scene_story_01_intro"]["content"][0]["text"] == "Intro text"
    assert scenes["scene_story_01_intro"]["content"][1]["text"] == "Guide says"
    assert scenes["scene_story_01_c01_result"]["content"][0]["text"] == "It worked."
    assert scenes["scene_story_01_c01_result"]["content"][1]["text"] == "Well done."
    ending = result.blueprint["endings"][0]
    assert (ending["title"], ending["narration"]) == ("Finale", "Everything ends.")
    assert "intro.narration" not in result.templated
    assert "ending.narration" not in result.templated


def test_model_text_is_trimmed_and_length_checked_like_zod() -> None:
    content = StoryContent.model_validate({"intro": {"narration": "  padded \u00a0\ufeff"}})
    assert content.intro is not None and content.intro.narration == "padded"
    for bad in (
        {"intro": {"narration": "   "}},
        {"intro": {"narration": "x" * 1601}},
        {"intro": None},
    ):
        with pytest.raises(ValidationError):
            StoryContent.model_validate(bad)
    # 1,600 UTF-16 code units: an emoji counts as two.
    with pytest.raises(ValidationError):
        StoryContent.model_validate({"intro": {"narration": "\U0001f600" * 801}})
    StoryContent.model_validate({"intro": {"narration": "\U0001f600" * 800}})


# --- models -----------------------------------------------------------------------------------


def blueprint_dict() -> dict[str, Any]:
    return build(request_of("one"))


def test_story_blueprint_dump_keeps_a_null_continuity_summary_and_omits_other_optionals() -> None:
    data = blueprint_dict()
    data["continuity_summary"] = None
    model = StoryBlueprint.model_validate(data)
    dumped = model.dump()
    assert dumped["continuity_summary"] is None
    puzzle_scene = next(s for s in scenes_of(dumped) if s["type"] == "puzzle")
    assert "on_incorrect_scene_id" not in puzzle_scene
    assert dumped == data  # nothing else changes on the way through the model


def test_continuity_summary_is_required_even_when_null_is_allowed() -> None:
    data = blueprint_dict()
    del data["continuity_summary"]
    with pytest.raises(ValidationError) as caught:
        StoryBlueprint.model_validate(data)
    assert zod_flatten(caught.value)["fieldErrors"] == {"continuity_summary": ["Required"]}


def test_next_scene_id_may_be_null_but_not_missing() -> None:
    data = blueprint_dict()
    data["chapters"][0]["scenes"][0]["next_scene_id"] = None
    StoryBlueprint.model_validate(data)
    del data["chapters"][0]["scenes"][0]["next_scene_id"]
    with pytest.raises(ValidationError):
        StoryBlueprint.model_validate(data)


def test_a_learning_visual_that_is_invalid_or_null_is_dropped_not_rejected() -> None:
    for visual in ({"kind": "plot", "series": []}, None, 5, "x"):
        block = LearningContent.model_validate(
            {
                "type": "learning_info",
                "title": "t",
                "body": "b",
                "concept_ids": ["c"],
                "visual": visual,
            }
        )
        assert block.visual is None
        assert "visual" not in block.dump()
    kept = LearningContent.model_validate(
        {
            "type": "learning_info",
            "title": "t",
            "body": "b",
            "concept_ids": ["c"],
            "visual": GOOD_VISUAL,
        }
    )
    assert kept.dump()["visual"]["kind"] == "formula"


def test_scene_union_is_discriminated_by_type_and_content_is_required() -> None:
    data = blueprint_dict()
    data["chapters"][0]["scenes"][0]["type"] = "mystery"
    with pytest.raises(ValidationError):
        StoryBlueprint.model_validate(data)
    data = blueprint_dict()
    data["chapters"][0]["scenes"][0]["content"] = []
    with pytest.raises(ValidationError):
        StoryBlueprint.model_validate(data)
    data = blueprint_dict()
    data["chapters"] = []
    with pytest.raises(ValidationError):
        StoryBlueprint.model_validate(data)


def test_puzzle_needs_two_choices_and_a_correct_choice_among_them() -> None:
    puzzle = blueprint_dict()["puzzles"][0]
    Puzzle.model_validate(puzzle)
    with pytest.raises(ValidationError):
        Puzzle.model_validate({**puzzle, "choices": puzzle["choices"][:1]})
    with pytest.raises(ValidationError) as caught:
        Puzzle.model_validate({**puzzle, "correct_choice_id": "nope"})
    assert "correct_choice_id must match one of the choice_id values in choices" in str(
        caught.value
    )
    with pytest.raises(ValidationError):
        Puzzle.model_validate({**puzzle, "retry_allowed": "yes"})
    with pytest.raises(ValidationError):
        Puzzle.model_validate({**puzzle, "concept_ids": []})


def test_ending_type_is_an_enum() -> None:
    ending = blueprint_dict()["endings"][0]
    for kind in ("success", "failure", "partial_success"):
        Ending.model_validate({**ending, "type": kind})
    with pytest.raises(ValidationError):
        Ending.model_validate({**ending, "type": "draw"})


def test_world_state_numbers_keep_their_int_or_float_form() -> None:
    data = blueprint_dict()
    data["endings"][0]["world_state_changes"] = {"a": 10, "b": 2.5}
    dumped = StoryBlueprint.model_validate(data).dump()
    assert json.dumps(dumped["endings"][0]["world_state_changes"]) == '{"a": 10, "b": 2.5}'


def test_request_model_accepts_the_documented_optional_parts() -> None:
    request = request_of("two")
    assert len(request.previous_summaries or []) == 2
    assert request.options is not None and request.options.concepts_per_chapter == 1
    bare = request_of("one")
    assert bare.previous_summaries is None and bare.options is None
    summary = {
        "story_id": "s",
        "title": "t",
        "outcome_description": "",  # an empty outcome is allowed (the ending may have no title)
        "world_state_snapshot": {},
        "relationship_snapshot": {},
    }
    assert request_of("one", previousSummaries=[summary]).previous_summaries is not None


def test_request_model_rejects_what_zod_rejects() -> None:
    for patch in (
        {"previousSummaries": [{"story_id": "s"}]},
        {
            "previousSummaries": [
                {
                    "story_id": "s",
                    "title": "t",
                    "outcome_description": "o",
                    "world_state_snapshot": {"a": "x"},
                    "relationship_snapshot": {},
                }
            ]
        },
        {"options": {"conceptsPerChapter": 0}},
        {"options": {"conceptsPerChapter": True}},
        {"options": {"language": None}},
        {"previousSummaries": None},
    ):
        with pytest.raises(ValidationError):
            request_of("one", **patch)


# --- hash -------------------------------------------------------------------------------------


def test_seeded_shuffle_is_a_deterministic_permutation_that_does_not_mutate() -> None:
    items = list(range(10))
    shuffled = seeded_shuffle(items, "seed")
    assert sorted(shuffled) == items
    assert items == list(range(10))
    assert seeded_shuffle(items, "seed") == shuffled
    assert seeded_shuffle(items, "other seed") != shuffled
    assert seeded_shuffle([], "x") == []
    assert seeded_shuffle(["only"], "x") == ["only"]
