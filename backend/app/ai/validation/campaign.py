"""Semantic validator for a CampaignBlueprint (legacy rules).

Why: port of `frontend/src/lib/validation/campaign-validator.ts`. The Campaign Planner does not
call it (it uses `validate_planned_campaign`, which is stricter), but the Story Generator and
saved projects still rely on these rules, and the planner rules are defined as "these plus
one-material-one-story". Checks: unique story_ids, known material_ids, `required_knowledge`
concepts that exist in some provided material, unique character_ids.
"""

from __future__ import annotations

from app.ai.contracts.campaign import CampaignBlueprint
from app.ai.contracts.material import MaterialBlueprint
from app.ai.validation import validation_error


def validate_campaign(
    campaign: CampaignBlueprint, materials: list[MaterialBlueprint]
) -> list[dict[str, str]]:
    """Return the problems found in `campaign`; an empty list means valid."""
    errors: list[dict[str, str]] = []

    seen_story_ids: set[str] = set()
    for entry in campaign.story_sequence:
        if entry.story_id in seen_story_ids:
            errors.append(
                validation_error(
                    "DUPLICATE_STORY_ID",
                    f'Duplicate story_id "{entry.story_id}" in campaign '
                    f'"{campaign.campaign_id}" story_sequence.',
                    f"story_sequence[{entry.story_id}]",
                )
            )
        seen_story_ids.add(entry.story_id)

    known_material_ids = {m.material_id for m in materials}
    for entry in campaign.story_sequence:
        if entry.material_id not in known_material_ids:
            errors.append(
                validation_error(
                    "INVALID_MATERIAL_REF",
                    f'Story "{entry.story_id}" references material_id "{entry.material_id}" '
                    "which was not provided.",
                    f"story_sequence[{entry.story_id}].material_id",
                )
            )

    all_concept_ids = {c.concept_id for m in materials for c in m.concepts}
    for entry in campaign.story_sequence:
        for concept_id in entry.required_knowledge:
            if concept_id not in all_concept_ids:
                errors.append(
                    validation_error(
                        "INVALID_REQUIRED_KNOWLEDGE_REF",
                        f'Story "{entry.story_id}" requires concept_id "{concept_id}" '
                        "which does not exist in any provided material.",
                        f"story_sequence[{entry.story_id}].required_knowledge",
                    )
                )

    seen_character_ids: set[str] = set()
    for character in campaign.characters:
        if character.character_id in seen_character_ids:
            errors.append(
                validation_error(
                    "DUPLICATE_CHARACTER_ID",
                    f'Duplicate character_id "{character.character_id}" in campaign '
                    f'"{campaign.campaign_id}".',
                    f"characters[{character.character_id}]",
                )
            )
        seen_character_ids.add(character.character_id)

    return errors
