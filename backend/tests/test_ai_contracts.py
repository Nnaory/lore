"""Tests for the Zod-compatible contract models (material, document, visual, request).

Why: the frontend parses these payloads with Zod, so the Pydantic models must accept and reject
the same inputs and serialize without nulls for optional fields.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.ai.contracts.document import ExtractedDocument
from app.ai.contracts.material import MaterialBlueprint
from app.ai.contracts.requests import AnalyzeMaterialRequest, utf16_length
from app.ai.contracts.visual import VisualInvalid, VisualOk, parse_lesson_visual
from app.ai.zod_compat import zod_flatten


def concept(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "concept_id": "c1",
        "name": "Name",
        "definition": "Def",
        "principles": [],
        "methods": [],
        "prerequisites": [],
        "misconceptions": [],
        "source_evidence": ["E"],
    }
    return {**base, **overrides}


def blueprint(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "material_id": "m1",
        "title": "T",
        "summary": "S",
        "learning_objectives": ["O"],
        "concepts": [concept()],
        "scope_limitations": [],
    }
    return {**base, **overrides}


def flatten_of(model: Any, payload: Any) -> dict[str, Any]:
    with pytest.raises(ValidationError) as info:
        model.model_validate(payload)
    return zod_flatten(info.value)


# --- material ---------------------------------------------------------------------------------


def test_blueprint_accepts_minimal_and_omits_unset_optionals() -> None:
    dumped = MaterialBlueprint.model_validate(blueprint()).dump()
    assert "notation" not in dumped["concepts"][0]
    assert "examples" not in dumped["concepts"][0]
    assert dumped == blueprint()


def test_blueprint_keeps_optional_fields_when_given() -> None:
    raw = blueprint(concepts=[concept(notation=["‖v‖"], examples=[])])
    dumped = MaterialBlueprint.model_validate(raw).dump()
    assert dumped["concepts"][0]["notation"] == ["‖v‖"]
    assert dumped["concepts"][0]["examples"] == []


def test_blueprint_strips_unknown_keys_like_zod() -> None:
    raw = blueprint(extra="x", concepts=[concept(unexpected=1)])
    dumped = MaterialBlueprint.model_validate(raw).dump()
    assert "extra" not in dumped
    assert "unexpected" not in dumped["concepts"][0]


@pytest.mark.parametrize("field", ["notation", "examples"])
def test_blueprint_rejects_null_optional_field(field: str) -> None:
    with pytest.raises(ValidationError):
        MaterialBlueprint.model_validate(blueprint(concepts=[concept(**{field: None})]))


@pytest.mark.parametrize(
    ("overrides", "key", "message"),
    [
        ({"material_id": ""}, "material_id", "material_id must not be empty"),
        ({"title": ""}, "title", "material title must not be empty"),
        ({"summary": ""}, "summary", "material summary must not be empty"),
        (
            {"learning_objectives": []},
            "learning_objectives",
            "at least one learning objective is required",
        ),
        ({"concepts": []}, "concepts", "at least one concept is required"),
        ({"scope_limitations": "x"}, "scope_limitations", "Expected array, received string"),
        ({"title": 5}, "title", "Expected string, received number"),
    ],
)
def test_blueprint_rejections_and_flatten_messages(
    overrides: dict[str, Any], key: str, message: str
) -> None:
    flat = flatten_of(MaterialBlueprint, blueprint(**overrides))
    assert flat["formErrors"] == []
    assert flat["fieldErrors"][key] == [message]


def test_blueprint_flatten_reports_missing_and_nested_under_top_level_key() -> None:
    raw = blueprint(concepts=[concept(definition="")])
    del raw["title"]
    flat = flatten_of(MaterialBlueprint, raw)
    assert flat["fieldErrors"] == {
        "title": ["Required"],
        "concepts": ["definition must not be empty"],
    }


def test_blueprint_rejects_non_object_as_form_error() -> None:
    assert flatten_of(MaterialBlueprint, []) == {
        "formErrors": ["Expected object, received array"],
        "fieldErrors": {},
    }


def test_blueprint_does_not_coerce_types() -> None:
    with pytest.raises(ValidationError):
        MaterialBlueprint.model_validate(blueprint(title=123))
    with pytest.raises(ValidationError):
        MaterialBlueprint.model_validate(blueprint(concepts=[concept(principles=[1])]))


# --- request ----------------------------------------------------------------------------------


def test_request_accepts_optional_fields_absent_or_present() -> None:
    assert AnalyzeMaterialRequest.model_validate({"material": "x" * 10}).dump() == {
        "material": "x" * 10
    }
    full = {"material": "x" * 10, "context": {"a": None, "b": [1]}, "genre": "fantasy"}
    assert AnalyzeMaterialRequest.model_validate(full).dump() == full


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"material": "short"}, "material must be at least 10 characters"),
        ({"material": "x" * 80_001}, "material must be at most 80000 characters"),
        ({"material": 12}, "Expected string, received number"),
        ({}, "Required"),
    ],
)
def test_request_material_errors(payload: dict[str, Any], message: str) -> None:
    assert flatten_of(AnalyzeMaterialRequest, payload)["fieldErrors"]["material"] == [message]


def test_request_boundaries_are_inclusive() -> None:
    AnalyzeMaterialRequest.model_validate({"material": "x" * 10})
    AnalyzeMaterialRequest.model_validate({"material": "x" * 80_000})


def test_request_counts_utf16_units_like_javascript() -> None:
    assert utf16_length("😀") == 2
    # 5 emoji are 10 UTF-16 units (valid in JS), but only 5 code points.
    AnalyzeMaterialRequest.model_validate({"material": "😀" * 5})
    with pytest.raises(ValidationError):
        AnalyzeMaterialRequest.model_validate({"material": "😀" * 40_001})


@pytest.mark.parametrize("payload", [{"genre": None}, {"context": None}, {"context": []}])
def test_request_rejects_null_and_wrong_optional_types(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        AnalyzeMaterialRequest.model_validate({"material": "x" * 10, **payload})


# --- document ---------------------------------------------------------------------------------


def document(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "file_name": "a.pdf",
        "file_type": "pdf",
        "sections": [{"section_id": "s1", "title": "T", "text": "x", "source_ref": "p1"}],
        "stats": {"units": 1, "words": 1, "chars": 1},
        "warnings": [],
    }
    return {**base, **overrides}


def test_document_accepts_valid_and_whole_float_counts() -> None:
    ExtractedDocument.model_validate(document())
    ExtractedDocument.model_validate(document(stats={"units": 1.0, "words": 2, "chars": 3}))


@pytest.mark.parametrize(
    "overrides",
    [
        {"file_type": "doc"},
        {"sections": []},
        {"stats": {"units": -1, "words": 0, "chars": 0}},
        {"stats": {"units": 1.5, "words": 0, "chars": 0}},
        {"warnings": [{"code": "OTHER", "message": "m"}]},
        {
            "sections": [
                {"section_id": "s", "title": "T", "text": "x", "source_ref": "p"},
                {"section_id": "s", "title": "T", "text": "y", "source_ref": "p"},
            ]
        },
    ],
)
def test_document_rejects(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ExtractedDocument.model_validate(document(**overrides))


# --- visual -----------------------------------------------------------------------------------

VECTORS = {
    "kind": "vectors",
    "vectors": [{"from": [0, 0], "to": [3, 4], "label": "v", "tone": "primary"}],
    "x_range": [-1, 5],
    "caption": "A vector",
}
PLOT = {"kind": "plot", "series": [{"points": [[0, 0], [1, 1]]}]}
DIAGRAM = {
    "kind": "diagram",
    "layout": "flow",
    "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
    "edges": [{"from": "a", "to": "b"}],
}
TABLE = {"kind": "table", "headers": ["x", "y"], "rows": [["1", "2"], ["", "4"]]}
FORMULA = {
    "kind": "formula",
    "expression": "a^2 + b^2 = c^2",
    "terms": [{"symbol": "c", "meaning": "hypotenuse"}],
}


@pytest.mark.parametrize("raw", [VECTORS, PLOT, DIAGRAM, TABLE, FORMULA])
def test_each_visual_kind_is_accepted_and_dumps_without_nulls(raw: dict[str, Any]) -> None:
    result = parse_lesson_visual(raw)
    assert isinstance(result, VisualOk)
    dumped = result.visual.dump()
    assert dumped["kind"] == raw["kind"]
    assert None not in dumped.values()


def test_vector_dump_uses_wire_name_from() -> None:
    result = parse_lesson_visual(VECTORS)
    assert isinstance(result, VisualOk)
    assert result.visual.dump()["vectors"][0] == {
        "from": [0, 0],
        "to": [3, 4],
        "label": "v",
        "tone": "primary",
    }


def test_diagram_edges_default_to_empty_list() -> None:
    result = parse_lesson_visual({k: v for k, v in DIAGRAM.items() if k != "edges"})
    assert isinstance(result, VisualOk)
    assert result.visual.dump()["edges"] == []


def test_visual_trims_labels() -> None:
    result = parse_lesson_visual({**FORMULA, "expression": "  a + b  "})
    assert isinstance(result, VisualOk)
    assert result.visual.dump()["expression"] == "a + b"


@pytest.mark.parametrize(
    "raw",
    [
        {"kind": "unknown"},
        {"kind": "vectors", "vectors": []},
        {"kind": "vectors", "vectors": [{"from": [1, 1], "to": [1, 1]}]},
        {"kind": "vectors", "vectors": [{"from": [0, 0], "to": [2000, 0]}]},
        {"kind": "vectors", "vectors": [{"from": [0, 0], "to": [1, 1]}] * 7},
        {**VECTORS, "x_range": [5, 1]},
        {"kind": "plot", "series": [{"points": [[0, 0]]}]},
        {**DIAGRAM, "edges": [{"from": "a", "to": "zzz"}]},
        {**DIAGRAM, "edges": [{"from": "a", "to": "a"}]},
        {**DIAGRAM, "nodes": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]},
        {**TABLE, "rows": [["1"]]},
        {**TABLE, "highlight_rows": [5]},
        {**TABLE, "rows": [["x" * 41, "y"]]},
        {**FORMULA, "terms": []},
        {**FORMULA, "expression": "x" * 81},
        {**FORMULA, "caption": None},
        "not an object",
    ],
)
def test_invalid_visuals_come_back_as_union_not_exception(raw: Any) -> None:
    result = parse_lesson_visual(raw)
    assert isinstance(result, VisualInvalid)
    assert result.ok is False
    assert set(result.detail) == {"formErrors", "fieldErrors"}
