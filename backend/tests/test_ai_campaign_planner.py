"""Tests for the Campaign Planner pieces: contracts, engine, validators, parser, merge, prompt.

Why: parity with the TypeScript tests (`campaign-planner-engine`, `campaign-output-parser`,
`campaign-planner-types`, `planner-validator`, `campaign-validator`, `campaign.schema`) and with
the Gemini provider's merge and prompt, which have no direct TS test. The engine, prompt and
merge were also compared case by case with the real TypeScript code while writing this port.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from pydantic import ValidationError

from app.ai.campaign_output_parser import (
    CandidateCampaign,
    ParsedCampaign,
    parse_and_validate_campaign_output,
    parse_campaign_provider_result,
)
from app.ai.campaign_planner import Creative, merge_creative_fields
from app.ai.campaign_planner_engine import (
    EngineError,
    EngineSuccess,
    build_campaign_blueprint,
    js_replace_first,
)
from app.ai.campaign_templates import GENRE_TEMPLATES
from app.ai.contracts.campaign import CampaignBlueprint
from app.ai.contracts.material import MaterialBlueprint
from app.ai.contracts.requests import CampaignPlannerOptions, PlanCampaignRequest
from app.ai.envelope import AiError, status_for_code
from app.ai.prompts.campaign_planner import SYSTEM_PROMPT, build_campaign_prompt
from app.ai.validation.campaign import validate_campaign
from app.ai.validation.planner import validate_planned_campaign
from app.ai.zod_compat import zod_flatten

GENRES = [
    "fantasy",
    "modern",
    "science_fiction",
    "mystery",
    "historical",
    "survival",
    "horror",
    "custom",
]


def material(
    material_id: str, concepts: list[tuple[str, list[str]]] | None = None, **extra: Any
) -> MaterialBlueprint:
    """A valid material; `concepts` is a list of (concept_id, prerequisites)."""
    spec = concepts if concepts is not None else [(f"c_{material_id}", [])]
    raw: dict[str, Any] = {
        "material_id": material_id,
        "title": f"Title of {material_id}",
        "summary": f"Summary of {material_id}",
        "learning_objectives": [f"Objective of {material_id}"],
        "concepts": [
            {
                "concept_id": cid,
                "name": f"Name of {cid}",
                "definition": f"Definition of {cid}",
                "principles": [],
                "methods": [],
                "prerequisites": prerequisites,
                "misconceptions": [],
                "source_evidence": ["e"],
            }
            for cid, prerequisites in spec
        ],
        "scope_limitations": [],
        **extra,
    }
    return MaterialBlueprint.model_validate(raw)


def options(**raw: Any) -> CampaignPlannerOptions:
    return CampaignPlannerOptions.model_validate({"genre": "fantasy", **raw})


M1 = material("m1", [("c1", [])])
M2 = material("m2", [("c2", ["c1"])])
M3 = material("m3", [("c3", [])])


def plan(materials: list[MaterialBlueprint], **raw: Any) -> EngineSuccess:
    result = build_campaign_blueprint(materials, options(**raw))
    assert isinstance(result, EngineSuccess), result
    return result


def failure(materials: list[MaterialBlueprint], **raw: Any) -> EngineError:
    result = build_campaign_blueprint(materials, options(**raw))
    assert isinstance(result, EngineError), result
    return result


def order(result: EngineSuccess) -> list[str]:
    return [s["material_id"] for s in result.blueprint["story_sequence"]]


# --- request and blueprint contracts ----------------------------------------------------------


def valid_request(**overrides: Any) -> dict[str, Any]:
    base = {"materials": [M1.dump()], "options": {"genre": "fantasy"}}
    return {**base, **overrides}


def request_errors(payload: Any) -> dict[str, Any]:
    with pytest.raises(ValidationError) as info:
        PlanCampaignRequest.model_validate(payload)
    return zod_flatten(info.value)["fieldErrors"]


def test_request_accepts_single_and_multi_material() -> None:
    assert PlanCampaignRequest.model_validate(valid_request())
    two = PlanCampaignRequest.model_validate(
        valid_request(materials=[M1.dump(), M2.dump()], options={"genre": "horror"})
    )
    assert len(two.materials) == 2


def test_options_accept_every_optional_field_with_camel_case_wire_names() -> None:
    parsed = options(
        genre="science_fiction",
        tone="mysterious",
        setting="orbital station",
        customInstructions="More puzzles",
        campaignId="campaign_042",
        language="en",
    )
    assert parsed.custom_instructions == "More puzzles"
    assert parsed.campaign_id == "campaign_042"
    assert parsed.dump() == {
        "genre": "science_fiction",
        "tone": "mysterious",
        "setting": "orbital station",
        "customInstructions": "More puzzles",
        "campaignId": "campaign_042",
        "language": "en",
    }


@pytest.mark.parametrize("genre", GENRES)
def test_every_genre_is_accepted(genre: str) -> None:
    assert options(genre=genre).genre == genre


def test_request_rejections_and_messages_match_zod() -> None:
    assert request_errors({"options": {"genre": "fantasy"}}) == {"materials": ["Required"]}
    assert request_errors(valid_request(materials=[])) == {
        "materials": ["at least one material is required"]
    }
    assert request_errors({"materials": [M1.dump()]}) == {"options": ["Required"]}
    assert request_errors(valid_request(options={"genre": "romance"})) == {
        "options": [
            "Invalid enum value. Expected 'fantasy' | 'modern' | 'science_fiction' | 'mystery' | "
            "'historical' | 'survival' | 'horror' | 'custom', received 'romance'"
        ]
    }
    assert request_errors(valid_request(options={"tone": "dark"})) == {"options": ["Required"]}
    assert request_errors(valid_request(options={"genre": "fantasy", "tone": 123})) == {
        "options": ["Expected string, received number"]
    }
    assert request_errors(valid_request(materials=[{**M1.dump(), "material_id": ""}])) == {
        "materials": ["material_id must not be empty"]
    }
    assert request_errors(valid_request(materials=[{**M1.dump(), "concepts": []}])) == {
        "materials": ["at least one concept is required"]
    }


def test_request_rejects_null_for_optional_options() -> None:
    assert request_errors(valid_request(options={"genre": "fantasy", "tone": None}))


def test_request_strips_unknown_keys_and_keeps_material_extras() -> None:
    parsed = PlanCampaignRequest.model_validate(
        valid_request(extra=1, options={"genre": "fantasy", "bogus": True})
    )
    assert parsed.options.dump() == {"genre": "fantasy"}


def campaign_dict(**overrides: Any) -> dict[str, Any]:
    result = plan([M1, M2])
    return {**result.blueprint, **overrides}


def campaign_errors(raw: Any) -> dict[str, list[str]]:
    with pytest.raises(ValidationError) as info:
        CampaignBlueprint.model_validate(raw)
    return zod_flatten(info.value)["fieldErrors"]


def test_blueprint_accepts_engine_output_and_round_trips_without_nulls() -> None:
    raw = campaign_dict()
    dumped = CampaignBlueprint.model_validate(raw).dump()
    assert dumped == raw
    assert isinstance(
        dumped["story_sequence"][0]["outcomes"][0]["world_state_changes"]["stability"], int
    )


@pytest.mark.parametrize("genre", GENRES)
def test_blueprint_accepts_every_genre(genre: str) -> None:
    CampaignBlueprint.model_validate(campaign_dict(genre=genre))


def test_blueprint_rejects_like_the_zod_schema() -> None:
    assert campaign_errors(campaign_dict(genre="romance"))["genre"][0].startswith(
        "Invalid enum value."
    )
    assert campaign_errors(campaign_dict(campaign_id="")) == {
        "campaign_id": ["campaign_id must not be empty"]
    }
    assert campaign_errors(campaign_dict(characters=[])) == {
        "characters": ["at least one character is required"]
    }
    assert campaign_errors(campaign_dict(story_sequence=[])) == {
        "story_sequence": ["story_sequence must contain at least one story"]
    }


def test_blueprint_empty_string_messages_follow_the_field_that_failed() -> None:
    raw = campaign_dict()
    raw["title"] = ""
    raw["tone"] = ""
    raw["characters"] = [{**raw["characters"][0], "name": "", "role": "", "description": ""}]
    raw["story_sequence"] = [
        {**raw["story_sequence"][0], "title": "", "purpose": "", "story_id": ""}
    ]
    errors = campaign_errors(raw)
    assert errors["title"] == ["campaign title must not be empty"]
    assert errors["tone"] == ["tone must not be empty"]
    assert errors["characters"] == [
        "character name must not be empty",
        "character role must not be empty",
        "character description must not be empty",
    ]
    assert errors["story_sequence"] == [
        "story_id must not be empty",
        "story title must not be empty",
        "story purpose must not be empty",
    ]


def test_blueprint_world_state_values_must_be_finite_numbers() -> None:
    raw = campaign_dict()
    for bad in (True, "5", None, float("inf")):
        outcome = {**raw["story_sequence"][0]["outcomes"][0], "world_state_changes": {"s": bad}}
        story = {**raw["story_sequence"][0], "outcomes": [outcome]}
        assert campaign_errors({**raw, "story_sequence": [story]})
    ok = {**raw["story_sequence"][0]["outcomes"][0], "world_state_changes": {"s": 1.5, "t": -3}}
    story = {**raw["story_sequence"][0], "outcomes": [ok]}
    CampaignBlueprint.model_validate({**raw, "story_sequence": [story]})


def test_blueprint_expressions_must_map_strings_to_strings() -> None:
    raw = campaign_dict()
    character = {**raw["characters"][0], "expressions": {"neutral": 5}}
    assert campaign_errors({**raw, "characters": [character]})


# --- engine: one material ---------------------------------------------------------------------


def test_single_material_has_one_story_without_knowledge_or_warnings() -> None:
    result = plan([M1])
    assert len(result.blueprint["story_sequence"]) == 1
    assert result.blueprint["story_sequence"][0]["required_knowledge"] == []
    assert result.warnings == []


def test_material_fields_map_into_the_story() -> None:
    story = plan([M1]).blueprint["story_sequence"][0]
    assert story["story_id"] == "story_01"
    assert story["material_id"] == "m1"
    assert story["title"] == "Title of m1"
    assert "Objective of m1" in story["purpose"]
    assert len(story["outcomes"]) == 1
    assert story["outcomes"][0]["outcome_id"] == "outcome_story_01_success"
    assert story["outcomes"][0]["world_state_changes"] == {"stability": 10}


def test_character_ids_are_stable_and_carry_the_expressions() -> None:
    characters = plan([M1]).blueprint["characters"]
    assert [c["character_id"] for c in characters] == ["char_01", "char_02"]
    assert characters[0]["expressions"]["thinking"] == "(\u00ac_\u00ac)"
    assert characters[0]["expressions"]["stern"] == "(\u0ca0_\u0ca0)"
    assert "(campaign campaign_001)" in characters[0]["description"]


def test_purpose_falls_back_to_the_summary_only_without_objectives() -> None:
    # MaterialBlueprint requires one objective, so build the case with model_construct.
    empty = M1.model_copy(update={"learning_objectives": []})
    assert (
        plan([empty]).blueprint["story_sequence"][0]["purpose"]
        == "Introduce and apply: Summary of m1"
    )
    blank = M1.model_copy(update={"learning_objectives": [""]})
    assert plan([blank]).blueprint["story_sequence"][0]["purpose"] == "Introduce and apply: "


# --- engine: ordering -------------------------------------------------------------------------


def test_input_order_is_kept_without_cross_material_prerequisites() -> None:
    assert order(plan([M1, material("m2", [("c2", [])]), M3])) == ["m1", "m2", "m3"]


def test_topological_sort_when_prerequisites_imply_an_order() -> None:
    assert order(plan([M2, M1])) == ["m1", "m2"]


def test_required_knowledge_only_comes_from_earlier_materials() -> None:
    first = material("m1", [("c1", []), ("c2", ["c1"])])
    second = material("m2", [("c3", ["c2"])])
    stories = plan([first, second]).blueprint["story_sequence"]
    assert stories[0]["required_knowledge"] == []
    assert stories[1]["required_knowledge"] == ["c2"]


def test_three_material_chain_in_reverse_input_order() -> None:
    m3 = material("m3", [("c3", ["c2"])])
    result = plan([m3, M1, M2])
    assert order(result) == ["m1", "m2", "m3"]
    assert result.blueprint["story_sequence"][2]["required_knowledge"] == ["c2"]


def test_required_knowledge_has_no_duplicates() -> None:
    m2 = material("m2", [("c2", ["c1"]), ("c3", ["c1"])])
    assert plan([M1, m2]).blueprint["story_sequence"][1]["required_knowledge"] == ["c1"]


def test_every_material_appears_exactly_once() -> None:
    ids = order(plan([M1, M2, M3]))
    assert sorted(ids) == ["m1", "m2", "m3"]


def test_outcome_stability_grows_with_the_story_number() -> None:
    stories = plan([M1, M2, M3]).blueprint["story_sequence"]
    assert [s["outcomes"][0]["world_state_changes"]["stability"] for s in stories] == [10, 15, 20]


def test_testability_warning_for_each_derived_prerequisite() -> None:
    warnings = plan([M1, M2]).warnings
    assert warnings == [
        {
            "code": "PREREQUISITE_TESTABILITY_PENDING",
            "message": 'Story 02 requires concept "c1". Layer 3 must provide a puzzle testing '
            "this concept in an earlier story, or the story cannot be unlocked.",
            "path": "story_sequence[story_02].required_knowledge",
        }
    ]


def test_ties_break_by_input_order_with_many_independent_materials() -> None:
    many = [material(f"m{i}", [(f"c{i}", [])]) for i in range(3000)]
    started = time.perf_counter()
    result = plan(many)
    assert order(result) == [f"m{i}" for i in range(3000)]
    assert time.perf_counter() - started < 5  # a re-sorting list would take minutes


# --- engine: errors ---------------------------------------------------------------------------


def test_duplicate_material_ids() -> None:
    error = failure([M1, material("m1", [("other", [])])])
    assert error.code == "DUPLICATE_MATERIAL_ID"
    assert error.message == 'Duplicate material_id "m1" in planner request.'


def test_duplicate_concept_ids_across_materials() -> None:
    error = failure([M1, material("m2", [("c1", [])])])
    assert error.code == "DUPLICATE_CONCEPT_ID"
    assert error.message == (
        'concept_id "c1" is defined by both "m1" and "m2". Concept IDs must be globally '
        "unique across all materials."
    )


def test_unresolved_prerequisite() -> None:
    error = failure([material("m1", [("c1", ["ghost"])])])
    assert error.code == "INVALID_PREREQUISITE_REF"
    assert error.message == (
        'Concept "c1" in material "m1" references unknown prerequisite "ghost".'
    )


def test_two_material_cycle_reports_the_edges() -> None:
    error = failure([material("m1", [("c1", ["c2"])]), material("m2", [("c2", ["c1"])])])
    assert error.code == "PREREQUISITE_CYCLE"
    assert error.detail == {"edges": "m1: [m2]; m2: [m1]"}


def test_three_material_cycle() -> None:
    cycle = [
        material("m1", [("c1", ["c3"])]),
        material("m2", [("c2", ["c1"])]),
        material("m3", [("c3", ["c2"])]),
    ]
    assert failure(cycle).code == "PREREQUISITE_CYCLE"


def test_intra_material_prerequisite_cycles_do_not_constrain_ordering() -> None:
    looping = material("m1", [("c1", ["c2"]), ("c2", ["c1"])])
    assert order(plan([looping, M3])) == ["m1", "m3"]


@pytest.mark.parametrize(
    "code",
    [
        "DUPLICATE_MATERIAL_ID",
        "DUPLICATE_CONCEPT_ID",
        "INVALID_PREREQUISITE_REF",
        "PREREQUISITE_CYCLE",
        "REQUIRED_KNOWLEDGE_ORDER",
    ],
)
def test_planner_semantic_codes_are_422(code: str) -> None:
    assert status_for_code(code) == 422


# --- engine: determinism, purity, options -----------------------------------------------------


def test_same_input_gives_equal_output_and_inputs_are_not_changed() -> None:
    materials = [M1, M2]
    before = [m.dump() for m in materials]
    opts = options(tone="grim")
    snapshot = opts.dump()
    first = build_campaign_blueprint(materials, opts)
    assert first == build_campaign_blueprint(materials, opts)
    assert [m.dump() for m in materials] == before
    assert opts.dump() == snapshot


def test_overrides_for_campaign_id_tone_and_setting() -> None:
    blueprint = plan([M1], campaignId="campaign_custom", tone="grim", setting="a frozen keep")
    assert blueprint.blueprint["campaign_id"] == "campaign_custom"
    assert blueprint.blueprint["tone"] == "grim"
    assert blueprint.blueprint["setting"] == "a frozen keep"
    assert "(campaign campaign_custom)" in blueprint.blueprint["characters"][0]["description"]


def test_empty_option_strings_are_kept_like_the_typescript_nullish_check() -> None:
    assert plan([M1], tone="").blueprint["tone"] == ""


@pytest.mark.parametrize("genre", GENRES)
def test_every_genre_builds_a_schema_valid_campaign(genre: str) -> None:
    result = plan([M1, M2], genre=genre)
    parsed = CampaignBlueprint.model_validate(result.blueprint)
    assert parsed.genre == genre
    assert parsed.tone == GENRE_TEMPLATES[genre].tone
    assert len(parsed.characters) == 2


def test_title_premise_and_conflict_text() -> None:
    blueprint = plan([M2, M1]).blueprint
    assert blueprint["title"] == "The Keeper's Campaign: Title of m1"
    assert blueprint["premise"].endswith(" The journey spans: Title of m1 \u2192 Title of m2.")
    assert blueprint["main_conflict"] == (
        "The campaign's central problem can only be resolved by mastering Title of m2."
    )
    assert blueprint["story_sequence"][0]["main_conflict"] == (
        "The central ward is failing, and only knowledge of Title of m1 can restore it."
    )


def test_js_replace_first_follows_javascript_replacement_patterns() -> None:
    assert js_replace_first("a {t} b {t}", "{t}", "X") == "a X b {t}"
    assert js_replace_first("a {t} b", "{t}", "Cost $$") == "a Cost $ b"
    assert js_replace_first("a {t} b", "{t}", "[$&]") == "a [{t}] b"
    assert js_replace_first("a {t} b", "{t}", "[$`]") == "a [a ] b"
    assert js_replace_first("a {t} b", "{t}", "[$']") == "a [ b] b"
    assert js_replace_first("a {t} b", "{t}", "$1 $<x> $") == "a $1 $<x> $ b"
    assert js_replace_first("no token", "{t}", "X") == "no token"


def test_dollar_signs_in_a_title_behave_like_the_nextjs_route() -> None:
    titled = material("m1", [("c1", [])]).model_copy(update={"title": "Cost $$ x"})
    story = plan([titled]).blueprint["story_sequence"][0]
    assert story["main_conflict"].endswith("knowledge of Cost $ x can restore it.")


# --- planner validator (planner-validator.test.ts) --------------------------------------------


def planned(materials: list[MaterialBlueprint]) -> CampaignBlueprint:
    return CampaignBlueprint.model_validate(plan(materials).blueprint)


def codes(errors: list[dict[str, str]]) -> list[str]:
    return [e["code"] for e in errors]


@pytest.mark.parametrize("materials", [[M1], [M1, M2], [M1, M3]])
def test_planner_output_is_valid(materials: list[MaterialBlueprint]) -> None:
    assert validate_planned_campaign(planned(materials), materials) == []


def test_material_with_two_stories_is_rejected() -> None:
    campaign = planned([M1, M3])
    extra = campaign.story_sequence[0].model_copy(update={"story_id": "story_99", "outcomes": []})
    campaign = campaign.model_copy(update={"story_sequence": [*campaign.story_sequence, extra]})
    errors = validate_planned_campaign(campaign, [M1, M3])
    assert "DUPLICATE_MATERIAL_STORY" in codes(errors)
    assert next(e for e in errors if e["code"] == "DUPLICATE_MATERIAL_STORY") == {
        "code": "DUPLICATE_MATERIAL_STORY",
        "message": 'Material "m1" is referenced by 2 stories; the Campaign Planner requires '
        "exactly one story per material.",
        "path": "story_sequence[material_id=m1]",
    }


def test_omitted_material_is_unplanned() -> None:
    errors = validate_planned_campaign(planned([M1]), [M1, M3])
    assert codes(errors) == ["UNPLANNED_MATERIAL"]
    assert errors[0]["path"] == "story_sequence[material_id=m3]"


def test_story_for_unknown_material() -> None:
    campaign = planned([M1])
    story = campaign.story_sequence[0].model_copy(update={"material_id": "m_ghost"})
    errors = validate_planned_campaign(
        campaign.model_copy(update={"story_sequence": [story]}), [M1]
    )
    assert codes(errors) == ["INVALID_MATERIAL_REF", "UNPLANNED_MATERIAL"]


def with_required(
    campaign: CampaignBlueprint, index: int, concepts: list[str]
) -> CampaignBlueprint:
    stories = list(campaign.story_sequence)
    stories[index] = stories[index].model_copy(update={"required_knowledge": concepts})
    return campaign.model_copy(update={"story_sequence": stories})


@pytest.mark.parametrize(
    ("materials", "required", "fragment"),
    [
        ([M1], ["c1"], "introduced by the SAME material/story"),
        ([M1, M3], ["c3"], "not introduced by any earlier story"),
        ([M1], ["c_ghost"], "not introduced by any earlier story"),
    ],
)
def test_required_knowledge_must_come_from_earlier_stories(
    materials: list[MaterialBlueprint], required: list[str], fragment: str
) -> None:
    errors = validate_planned_campaign(with_required(planned(materials), 0, required), materials)
    assert codes(errors) == ["REQUIRED_KNOWLEDGE_ORDER"]
    assert fragment in errors[0]["message"]
    assert errors[0]["path"] == "story_sequence[story_01].required_knowledge"


def test_duplicate_story_character_and_outcome_ids() -> None:
    campaign = planned([M1, M3])
    stories = list(campaign.story_sequence)
    stories[1] = stories[1].model_copy(
        update={"story_id": stories[0].story_id, "outcomes": stories[0].outcomes}
    )
    characters = [*campaign.characters, campaign.characters[0]]
    broken = campaign.model_copy(update={"story_sequence": stories, "characters": characters})
    errors = validate_planned_campaign(broken, [M1, M3])
    assert codes(errors) == ["DUPLICATE_STORY_ID", "DUPLICATE_CHARACTER_ID", "DUPLICATE_OUTCOME_ID"]


# --- legacy campaign validator (campaign-validator.test.ts) -----------------------------------


def two_stories_one_material() -> CampaignBlueprint:
    campaign = planned([M1])
    again = campaign.story_sequence[0].model_copy(update={"story_id": "story_02"})
    return campaign.model_copy(update={"story_sequence": [*campaign.story_sequence, again]})


def test_legacy_validator_allows_two_stories_on_one_material() -> None:
    assert validate_campaign(two_stories_one_material(), [M1]) == []


def test_legacy_validator_catches_each_problem() -> None:
    campaign = two_stories_one_material()
    stories = list(campaign.story_sequence)
    stories[1] = stories[1].model_copy(
        update={"story_id": "story_01", "material_id": "material_NONE", "required_knowledge": ["x"]}
    )
    broken = campaign.model_copy(
        update={
            "story_sequence": stories,
            "characters": [*campaign.characters, campaign.characters[0]],
        }
    )
    errors = validate_campaign(broken, [M1])
    assert codes(errors) == [
        "DUPLICATE_STORY_ID",
        "INVALID_MATERIAL_REF",
        "INVALID_REQUIRED_KNOWLEDGE_REF",
        "DUPLICATE_CHARACTER_ID",
    ]
    assert errors[2]["message"] == (
        'Story "story_01" requires concept_id "x" which does not exist in any provided material.'
    )


# --- output parser (campaign-output-parser.test.ts) -------------------------------------------


def candidate(
    materials: list[MaterialBlueprint], blueprint: dict[str, Any] | None = None
) -> CandidateCampaign:
    result = plan(materials)
    return CandidateCampaign(blueprint or result.blueprint, "dummy", "dummy-v1", 3, result.warnings)


def parsed(c: CandidateCampaign, materials: list[MaterialBlueprint]) -> ParsedCampaign:
    result = parse_and_validate_campaign_output(c, materials)
    assert isinstance(result, ParsedCampaign), result
    return result


def rejected(c: CandidateCampaign, materials: list[MaterialBlueprint]) -> AiError:
    result = parse_and_validate_campaign_output(c, materials)
    assert isinstance(result, AiError), result
    return result


def test_parser_accepts_valid_single_and_multi_material_output() -> None:
    assert len(parsed(candidate([M1]), [M1]).blueprint.story_sequence) == 1
    assert len(parsed(candidate([M1, M2]), [M1, M2]).blueprint.story_sequence) == 2


def test_parser_keeps_provider_warnings_in_meta() -> None:
    result = parsed(candidate([M1, M2]), [M1, M2])
    assert result.meta == {
        "provider": "dummy",
        "model": "dummy-v1",
        "latencyMs": 3,
        "warnings": [
            {
                "code": "PREREQUISITE_TESTABILITY_PENDING",
                "message": 'Story 02 requires concept "c1". Layer 3 must provide a puzzle '
                "testing this concept in an earlier story, or the story cannot be unlocked.",
                "path": "story_sequence[story_02].required_knowledge",
            }
        ],
    }


def test_parser_does_not_change_its_input() -> None:
    c = candidate([M1, M2])
    snapshot = repr(c)
    parsed(c, [M1, M2])
    assert repr(c) == snapshot


@pytest.mark.parametrize(
    "change",
    [
        {"campaign_id": ""},
        {"story_sequence": []},
        {"genre": "romance"},
        {"tone": ""},
    ],
)
def test_parser_rejects_schema_failures_with_flatten_detail(change: dict[str, Any]) -> None:
    base = plan([M1]).blueprint
    error = rejected(candidate([M1], {**base, **change}), [M1])
    assert error.code == "VALIDATION_FAILED"
    assert error.message == "Provider output does not match the CampaignBlueprint schema."
    assert set(error.detail) == {"formErrors", "fieldErrors"}
    assert status_for_code(error.code) == 502


def test_parser_semantic_failure_detail_is_a_list_of_validation_errors() -> None:
    blueprint = plan([M1]).blueprint
    stories = [*blueprint["story_sequence"], {**blueprint["story_sequence"][0], "story_id": "s99"}]
    stories[1]["outcomes"] = []
    error = rejected(candidate([M1], {**blueprint, "story_sequence": stories}), [M1])
    assert error.code == "VALIDATION_FAILED"
    assert error.message == "Provider output failed planner semantic validation."
    assert [e["code"] for e in error.detail] == ["DUPLICATE_MATERIAL_STORY"]
    assert set(error.detail[0]) == {"code", "message", "path"}


def test_parser_rejects_out_of_order_required_knowledge() -> None:
    blueprint = plan([M1, M2]).blueprint
    blueprint["story_sequence"][0]["required_knowledge"] = ["c2"]
    error = rejected(candidate([M1, M2], blueprint), [M1, M2])
    assert "REQUIRED_KNOWLEDGE_ORDER" in [e["code"] for e in error.detail]


def test_provider_failures_pass_through_unchanged() -> None:
    failure_in = AiError("PROVIDER_UNAVAILABLE", "down", [{"model": "m"}])
    assert parse_campaign_provider_result(failure_in, [M1]) is failure_in
    assert isinstance(parse_campaign_provider_result(candidate([M1]), [M1]), ParsedCampaign)


# --- creative step: schema, merge, prompt -----------------------------------------------------


def test_creative_accepts_partial_output_and_trims() -> None:
    creative = Creative.model_validate({"title": "  The Lanterns  ", "extra": 1})
    assert creative.title == "The Lanterns"
    assert creative.premise is None


@pytest.mark.parametrize(
    "bad",
    [
        {"title": ""},
        {"title": "   "},
        {"title": "x" * 601},
        {"tone": "x" * 61},
        {"world_rules": ["r"] * 7},
        {"characters": [{"name": "A", "role": "B"}]},
        {"title": None},
        {"title": 5},
        {"stories": [{"title": "no id"}]},
    ],
)
def test_creative_rejects_what_the_typescript_schema_rejects(bad: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        Creative.model_validate(bad)


def test_creative_length_limits_count_utf16_code_units() -> None:
    Creative.model_validate({"tone": "x" * 60})
    with pytest.raises(ValidationError):
        Creative.model_validate({"tone": "\U0001f600" * 31})  # 62 UTF-16 units


def test_merge_overlays_creative_text_and_leaves_structure_alone() -> None:
    skeleton = plan([M1, M2]).blueprint
    creative = Creative.model_validate(
        {
            "title": "The Glass Lanterns",
            "tone": "hushed",
            "world_rules": ["One", "Two"],
            "characters": [{"name": "Maren", "role": "Lamplighter", "description": "Keeps it."}],
            "stories": [
                {"story_id": "story_01", "title": "First Light"},
                {"story_id": "story_77", "title": "Unknown story is ignored"},
            ],
        }
    )
    merged = merge_creative_fields(skeleton, creative)
    assert merged["title"] == "The Glass Lanterns"
    assert merged["tone"] == "hushed"
    assert merged["setting"] == skeleton["setting"]
    assert merged["world_rules"] == ["One", "Two"]
    first, second = merged["characters"]
    assert (first["character_id"], first["name"], first["role"]) == (
        "char_01",
        "Maren",
        "Lamplighter",
    )
    assert first["expressions"] == skeleton["characters"][0]["expressions"]
    assert second == skeleton["characters"][1]  # no creative text for it
    story = merged["story_sequence"][0]
    assert story["title"] == "First Light"
    assert story["purpose"] == skeleton["story_sequence"][0]["purpose"]
    assert story["required_knowledge"] == skeleton["story_sequence"][0]["required_knowledge"]
    assert merged["story_sequence"][1] == skeleton["story_sequence"][1]
    CampaignBlueprint.model_validate(merged)


def test_merge_keeps_template_rules_when_creative_rules_are_empty_and_does_not_mutate() -> None:
    skeleton = plan([M1]).blueprint
    snapshot = repr(skeleton)
    merged = merge_creative_fields(skeleton, Creative.model_validate({"world_rules": []}))
    assert merged["world_rules"] == skeleton["world_rules"]
    assert repr(skeleton) == snapshot


def test_system_prompt() -> None:
    assert SYSTEM_PROMPT == (
        "You are a narrative designer for educational games. Respond with JSON only."
    )


def test_prompt_matches_the_typescript_text_exactly() -> None:
    request = PlanCampaignRequest.model_validate(valid_request(materials=[M1.dump()]))
    skeleton = plan([M1]).blueprint
    assert build_campaign_prompt(skeleton, request) == "\n".join(
        [
            "Design the world for an interactive learning story. "
            "Genre: fantasy (ancient realms, fading magic).",
            "Write every field in English.",
            "Stories (one per learning material, in this order):",
            "[",
            "  {",
            '    "story_id": "story_01",',
            '    "material_title": "Title of m1",',
            '    "learning_objectives": [',
            '      "Objective of m1"',
            "    ],",
            '    "concepts": [',
            '      "Name of c1"',
            "    ]",
            "  }",
            "]",
            "Characters: exactly 2. Character 1 is a Guide who frames challenges; "
            "character 2 is a Companion who learns alongside the player.",
            "Return JSON with this shape:",
            '{"title": string, "premise": string (2-3 sentences), "setting": string '
            '(one phrase), "tone": string (one or two words),',
            ' "main_conflict": string (one sentence), "world_rules": string[] (2-4 rules; '
            "the world's logic must match the material),",
            ' "characters": [{"name": string, "role": string, "description": string}],',
            ' "stories": [{"story_id": string (copy from above), "title": string, '
            '"purpose": string (one sentence), "main_conflict": string (one sentence, '
            "where the concepts are needed to solve it)}]}",
            "Rules: the learning content must stay academically correct; the world only "
            "frames it. Keep names original (no existing franchises).",
        ]
    )


def test_prompt_uses_language_and_custom_instructions() -> None:
    request = PlanCampaignRequest.model_validate(
        valid_request(
            materials=[M1.dump()],
            options={"genre": "modern", "language": "id", "customInstructions": "more puzzles"},
        )
    )
    prompt = build_campaign_prompt(plan([M1], genre="modern").blueprint, request)
    assert "Genre: non-fiction / modern day (the real world, today)." in prompt
    assert "Write every field in Indonesian." in prompt
    assert "Player's wishes (follow them unless unsafe): more puzzles" in prompt


def test_prompt_skips_empty_custom_instructions_and_treats_other_languages_as_english() -> None:
    request = PlanCampaignRequest.model_validate(
        valid_request(options={"genre": "fantasy", "language": "fr", "customInstructions": ""})
    )
    prompt = build_campaign_prompt(plan([M1]).blueprint, request)
    assert "Player's wishes" not in prompt
    assert "Write every field in English." in prompt
