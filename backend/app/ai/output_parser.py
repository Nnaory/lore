"""Output parser and validator for Material Intelligence (Layer 1).

Why: port of `frontend/src/lib/ai/output-parser.ts`. Provider output is untrusted, so it is
validated against the MaterialBlueprint model, then checked semantically. Never raises: failures
come back as `AiError`, non-blocking issues as warnings in `meta.warnings`.
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import ValidationError

from app.ai.contracts.material import MaterialBlueprint
from app.ai.envelope import AiError, warning
from app.ai.zod_compat import zod_flatten


@dataclass(frozen=True)
class ParsedMaterial:
    """A validated blueprint and its warnings."""

    blueprint: MaterialBlueprint
    warnings: list[dict[str, str]]


def parse_and_validate_material_output(raw_blueprint: object) -> ParsedMaterial | AiError:
    """Validate a raw blueprint and run the semantic checks."""
    try:
        blueprint = MaterialBlueprint.model_validate(raw_blueprint)
    except ValidationError as exc:
        return AiError(
            "VALIDATION_FAILED",
            "Output does not match MaterialBlueprint schema",
            zod_flatten(exc),
        )

    # A concept with no evidence in the material is a guess. When none of them is grounded in
    # the source, the material gave the model nothing to teach.
    if not any(e.strip() for c in blueprint.concepts for e in c.source_evidence):
        return AiError(
            "MATERIAL_ANALYSIS_FAILED",
            "No concept could be tied to the material (no source evidence).",
        )

    warnings: list[dict[str, str]] = []
    if not blueprint.learning_objectives:
        warnings.append(
            warning(
                "EMPTY_LEARNING_OBJECTIVES",
                "No learning objectives extracted",
                "learning_objectives",
            )
        )
    if not blueprint.concepts:
        warnings.append(warning("EMPTY_CONCEPTS", "No concepts extracted", "concepts"))
    known = {c.concept_id for c in blueprint.concepts}
    for concept in blueprint.concepts:
        if not concept.source_evidence:
            warnings.append(
                warning(
                    "MISSING_SOURCE_EVIDENCE",
                    f'Concept "{concept.concept_id}" has no source_evidence',
                    f"concepts[{concept.concept_id}].source_evidence",
                )
            )
        for prerequisite in concept.prerequisites:
            if prerequisite not in known:
                warnings.append(
                    warning(
                        "INVALID_PREREQUISITE_REF",
                        f'Concept "{concept.concept_id}" references unknown '
                        f'prerequisite "{prerequisite}"',
                        f"concepts[{concept.concept_id}].prerequisites",
                    )
                )
    return ParsedMaterial(blueprint, warnings)
