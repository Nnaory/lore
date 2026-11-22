"""Semantic validator for Campaign Planner output.

Why: port of `frontend/src/lib/validation/planner-validator.ts`. Rules the legacy campaign
validator does not enforce: unique story, character and outcome IDs; every character_id is a
Kit cast id; exactly one story per input material (and no story for an unknown material);
`required_knowledge` may only name concepts of materials whose story comes EARLIER, never the
same story's material and never a later one.
Error order and messages match the TypeScript version, because they travel to the client as the
`detail` of a `VALIDATION_FAILED` answer.
"""

from __future__ import annotations

from app.ai.campaign_templates import CAST_IDS
from app.ai.contracts.campaign import CampaignBlueprint
from app.ai.contracts.material import MaterialBlueprint
from app.ai.validation import validation_error


def validate_planned_campaign(
    campaign: CampaignBlueprint, materials: list[MaterialBlueprint]
) -> list[dict[str, str]]:
    """Return the problems found in `campaign` against `materials`; empty means valid."""
    errors: list[dict[str, str]] = []
    cid = campaign.campaign_id
    material_by_id = {m.material_id: m for m in materials}

    # 1. story_id uniqueness
    seen_story_ids: set[str] = set()
    for entry in campaign.story_sequence:
        if entry.story_id in seen_story_ids:
            errors.append(
                validation_error(
                    "DUPLICATE_STORY_ID",
                    f'Duplicate story_id "{entry.story_id}" in campaign "{cid}" story_sequence.',
                    f"story_sequence[{entry.story_id}]",
                )
            )
        seen_story_ids.add(entry.story_id)

    # 2. character_id uniqueness
    seen_character_ids: set[str] = set()
    for character in campaign.characters:
        if character.character_id in seen_character_ids:
            errors.append(
                validation_error(
                    "DUPLICATE_CHARACTER_ID",
                    f'Duplicate character_id "{character.character_id}" in campaign "{cid}".',
                    f"characters[{character.character_id}]",
                )
            )
        seen_character_ids.add(character.character_id)
        if character.character_id not in CAST_IDS:
            errors.append(
                validation_error(
                    "INVALID_CAST_CHARACTER",
                    f'character_id "{character.character_id}" in campaign "{cid}" is not one of '
                    f"the Kit cast ({', '.join(CAST_IDS)}).",
                    f"characters[{character.character_id}]",
                )
            )

    # 3. outcome_id uniqueness (campaign-wide)
    seen_outcome_ids: set[str] = set()
    for entry in campaign.story_sequence:
        for outcome in entry.outcomes:
            if outcome.outcome_id in seen_outcome_ids:
                errors.append(
                    validation_error(
                        "DUPLICATE_OUTCOME_ID",
                        f'Duplicate outcome_id "{outcome.outcome_id}" in campaign "{cid}".',
                        f"story_sequence[{entry.story_id}].outcomes",
                    )
                )
            seen_outcome_ids.add(outcome.outcome_id)

    # 4. one material, one story. A dict keeps first-seen order like the JS Map.
    story_count_by_material: dict[str, int] = {}
    for entry in campaign.story_sequence:
        story_count_by_material[entry.material_id] = (
            story_count_by_material.get(entry.material_id, 0) + 1
        )
        if entry.material_id not in material_by_id:
            errors.append(
                validation_error(
                    "INVALID_MATERIAL_REF",
                    f'Story "{entry.story_id}" references material_id "{entry.material_id}" '
                    "which was not provided to the planner.",
                    f"story_sequence[{entry.story_id}].material_id",
                )
            )
    for material_id, count in story_count_by_material.items():
        if count > 1:
            errors.append(
                validation_error(
                    "DUPLICATE_MATERIAL_STORY",
                    f'Material "{material_id}" is referenced by {count} stories; the Campaign '
                    "Planner requires exactly one story per material.",
                    f"story_sequence[material_id={material_id}]",
                )
            )
    for material in materials:
        if material.material_id not in story_count_by_material:
            errors.append(
                validation_error(
                    "UNPLANNED_MATERIAL",
                    f'Material "{material.material_id}" was provided to the planner but has '
                    "no story in the campaign.",
                    f"story_sequence[material_id={material.material_id}]",
                )
            )

    # 5. required_knowledge ordering, based purely on story_sequence order
    available: set[str] = set()
    for entry in campaign.story_sequence:
        current = material_by_id.get(entry.material_id)
        current_concepts = {c.concept_id for c in current.concepts} if current else set()
        path = f"story_sequence[{entry.story_id}].required_knowledge"
        for concept_id in entry.required_knowledge:
            if concept_id in current_concepts:
                errors.append(
                    validation_error(
                        "REQUIRED_KNOWLEDGE_ORDER",
                        f'Story "{entry.story_id}" requires concept "{concept_id}", which is '
                        "introduced by the SAME material/story. A story may only require "
                        "concepts from earlier stories.",
                        path,
                    )
                )
            elif concept_id not in available:
                errors.append(
                    validation_error(
                        "REQUIRED_KNOWLEDGE_ORDER",
                        f'Story "{entry.story_id}" requires concept "{concept_id}", which is '
                        "not introduced by any earlier story. This prerequisite can never be "
                        "demonstrated.",
                        path,
                    )
                )
        available |= current_concepts

    return errors
