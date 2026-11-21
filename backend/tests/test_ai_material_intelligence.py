"""Tests for the Material Intelligence pipeline pieces: normalisation, prompt, output parser.

Why: parity with the TypeScript tests (`material-intelligence.test.ts`, `output-parser.test.ts`)
and with the behaviour of `gemini-material-provider.ts` that has no direct TS test.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.ai.contracts.material import MaterialBlueprint
from app.ai.envelope import AiError
from app.ai.hash import stable_hash
from app.ai.material_intelligence import concept_limit_for, normalize_material_blueprint
from app.ai.output_parser import ParsedMaterial, parse_and_validate_material_output
from app.ai.prompts.material_analysis import (
    MATERIAL_ANALYSIS_SYSTEM_PROMPT,
    build_material_analysis_prompt,
)
from tests.test_ai_contracts import blueprint, concept

# --- concept limit ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("context", "expected"),
    [
        ({"story_length": "short"}, 3),
        ({"story_length": "medium"}, 5),
        ({"story_length": "long"}, 4),
        ({"story_length": 3}, 4),
        ({}, 4),
        (None, 4),
    ],
)
def test_concept_limit_follows_story_length(context: dict[str, Any] | None, expected: int) -> None:
    assert concept_limit_for(context) == expected


# --- normalisation ----------------------------------------------------------------------------


def normalize(concepts: list[dict[str, Any]], text: str = "some material", limit: int = 4) -> Any:
    parsed = MaterialBlueprint.model_validate(blueprint(concepts=concepts))
    return normalize_material_blueprint(parsed, text, limit)


def test_ids_are_replaced_with_stable_hash_based_ids() -> None:
    digest = stable_hash("some material")
    result = normalize([concept(concept_id="a"), concept(concept_id="b")])
    assert result.material_id == f"material_{digest}"
    assert [c.concept_id for c in result.concepts] == [
        f"concept_{digest}_01",
        f"concept_{digest}_02",
    ]
    assert normalize([concept()], "other").material_id != result.material_id


def test_prerequisites_keep_only_earlier_concepts_without_duplicates_or_self_references() -> None:
    digest = stable_hash("some material")
    result = normalize(
        [
            concept(concept_id="a", prerequisites=["b", "a", "ghost"]),
            concept(concept_id="b", prerequisites=["a", "a", "b", "ghost"]),
            concept(concept_id="c", prerequisites=["b", "a", "c"]),
        ]
    )
    assert [c.prerequisites for c in result.concepts] == [
        [],
        [f"concept_{digest}_01"],
        [f"concept_{digest}_02", f"concept_{digest}_01"],
    ]


def test_concepts_are_capped_and_prerequisites_to_dropped_concepts_vanish() -> None:
    result = normalize(
        [
            concept(concept_id="a"),
            concept(concept_id="b", prerequisites=["a"]),
            concept(concept_id="c", prerequisites=["b"]),
        ],
        limit=2,
    )
    assert len(result.concepts) == 2
    assert result.concepts[1].prerequisites == [result.concepts[0].concept_id]


def test_duplicate_model_ids_map_to_the_first_occurrence() -> None:
    digest = stable_hash("some material")
    result = normalize(
        [
            concept(concept_id="dup"),
            concept(concept_id="dup", prerequisites=["dup"]),
            concept(concept_id="x", prerequisites=["dup"]),
        ]
    )
    assert result.concepts[1].prerequisites == [f"concept_{digest}_01"]
    assert result.concepts[2].prerequisites == [f"concept_{digest}_01"]


def test_other_concept_fields_survive_normalisation() -> None:
    result = normalize([concept(notation=["n"], examples=["e"], name="Keep")])
    kept = result.concepts[0].dump()
    assert (kept["name"], kept["notation"], kept["examples"]) == ("Keep", ["n"], ["e"])


# --- prompt -----------------------------------------------------------------------------------


def test_system_prompt_is_the_typescript_text() -> None:
    assert MATERIAL_ANALYSIS_SYSTEM_PROMPT.startswith("You are an expert learning engineer.")
    assert '"notation": ["string", ...] (symbols, formulas and key terms exactly as' in (
        MATERIAL_ANALYSIS_SYSTEM_PROMPT
    )
    assert "‖v‖ = panjang vektor v" in MATERIAL_ANALYSIS_SYSTEM_PROMPT
    assert MATERIAL_ANALYSIS_SYSTEM_PROMPT.endswith(
        "- scope_limitations must be honest about what the material does NOT cover."
    )


def test_user_prompt_minimal() -> None:
    assert build_material_analysis_prompt("  text  ", None, None) == (
        "Analyze the following learning material and produce a MaterialBlueprint.\n\n"
        "--- MATERIAL START ---\ntext\n--- MATERIAL END ---\n"
        "\nReturn ONLY the JSON MaterialBlueprint."
    )


def test_user_prompt_with_context_and_genre() -> None:
    prompt = build_material_analysis_prompt("text", {"language": "id", "n": 1.5}, "fantasy")
    assert '\nContext: {\n  "language": "id",\n  "n": 1.5\n}\n' in prompt
    assert "\nGenre hint: fantasy (use only for framing examples, not academic content)\n" in prompt
    assert prompt.endswith("\nReturn ONLY the JSON MaterialBlueprint.")


def test_user_prompt_skips_empty_context_and_genre() -> None:
    prompt = build_material_analysis_prompt("text", {}, "")
    assert "Context:" not in prompt
    assert "Genre hint" not in prompt


# --- output parser ----------------------------------------------------------------------------


def parsed_ok(raw: Any) -> ParsedMaterial:
    result = parse_and_validate_material_output(raw)
    assert isinstance(result, ParsedMaterial)
    return result


def failed(raw: Any) -> AiError:
    result = parse_and_validate_material_output(raw)
    assert isinstance(result, AiError)
    return result


def test_parser_accepts_valid_blueprint() -> None:
    result = parsed_ok(blueprint())
    assert result.blueprint.material_id == "m1"
    assert result.warnings == []


def test_parser_rejects_missing_required_fields() -> None:
    error = failed(blueprint(material_id=""))
    assert error.code == "VALIDATION_FAILED"
    assert error.message == "Output does not match MaterialBlueprint schema"
    assert error.detail["fieldErrors"]["material_id"] == ["material_id must not be empty"]


def test_parser_rejects_empty_concepts_array_as_validation_failed() -> None:
    assert failed(blueprint(concepts=[])).code == "VALIDATION_FAILED"


@pytest.mark.parametrize("evidence", [[], ["", "   "]])
def test_parser_rejects_blueprint_where_no_concept_is_grounded(evidence: list[str]) -> None:
    error = failed(blueprint(concepts=[concept(source_evidence=evidence)]))
    assert error.code == "MATERIAL_ANALYSIS_FAILED"
    assert error.message == "No concept could be tied to the material (no source evidence)."


def test_parser_warns_about_ungrounded_concept_when_others_are_grounded() -> None:
    result = parsed_ok(
        blueprint(
            concepts=[
                concept(concept_id="a", source_evidence=["quoted from the material"]),
                concept(concept_id="b", source_evidence=[]),
            ]
        )
    )
    assert result.warnings == [
        {
            "code": "MISSING_SOURCE_EVIDENCE",
            "message": 'Concept "b" has no source_evidence',
            "path": "concepts[b].source_evidence",
        }
    ]


def test_parser_warns_about_unknown_prerequisite_references() -> None:
    result = parsed_ok(blueprint(concepts=[concept(prerequisites=["nonexistent_concept"])]))
    assert result.warnings == [
        {
            "code": "INVALID_PREREQUISITE_REF",
            "message": 'Concept "c1" references unknown prerequisite "nonexistent_concept"',
            "path": "concepts[c1].prerequisites",
        }
    ]
