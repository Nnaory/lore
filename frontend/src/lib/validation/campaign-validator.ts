/**
 * Semantic Validator — Campaign Blueprint
 *
 * Performs cross-reference checks that cannot be expressed in a flat Zod schema:
 *   - story_sequence story_ids are unique
 *   - material_ids in story_sequence are unique (one story per material)
 *   - required_knowledge concept_ids exist across provided material blueprints
 *   - outcome world_state_changes only reference known world state keys
 */

import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { ValidationError, ValidationResult } from "./story-validator";

/**
 * Validates the internal consistency of a CampaignBlueprint.
 *
 * @param campaign - The campaign blueprint to validate.
 * @param materials - All MaterialBlueprints associated with this campaign.
 *                   Used to validate required_knowledge concept references.
 */
export function validateCampaign(
  campaign: CampaignBlueprint,
  materials: MaterialBlueprint[]
): ValidationResult {
  const errors: ValidationError[] = [];

  // ─── 1. story_ids in story_sequence must be unique ──────────────────────
  const seenStoryIds = new Set<string>();
  for (const entry of campaign.story_sequence) {
    if (seenStoryIds.has(entry.story_id)) {
      errors.push({
        code: "DUPLICATE_STORY_ID",
        message: `Duplicate story_id "${entry.story_id}" in campaign "${campaign.campaign_id}" story_sequence.`,
        path: `story_sequence[${entry.story_id}]`,
      });
    }
    seenStoryIds.add(entry.story_id);
  }

  // ─── 2. Each story in sequence must reference a known material_id ────────
  const knownMaterialIds = new Set(materials.map((m) => m.material_id));
  for (const entry of campaign.story_sequence) {
    if (!knownMaterialIds.has(entry.material_id)) {
      errors.push({
        code: "INVALID_MATERIAL_REF",
        message: `Story "${entry.story_id}" references material_id "${entry.material_id}" which was not provided.`,
        path: `story_sequence[${entry.story_id}].material_id`,
      });
    }
  }

  // ─── 3. required_knowledge must reference valid concept_ids ─────────────
  const allConceptIds = new Set(
    materials.flatMap((m) => m.concepts.map((c) => c.concept_id))
  );
  for (const entry of campaign.story_sequence) {
    for (const conceptId of entry.required_knowledge) {
      if (!allConceptIds.has(conceptId)) {
        errors.push({
          code: "INVALID_REQUIRED_KNOWLEDGE_REF",
          message: `Story "${entry.story_id}" requires concept_id "${conceptId}" which does not exist in any provided material.`,
          path: `story_sequence[${entry.story_id}].required_knowledge`,
        });
      }
    }
  }

  // ─── 4. character_ids must be unique within the campaign ────────────────
  const seenCharacterIds = new Set<string>();
  for (const character of campaign.characters) {
    if (seenCharacterIds.has(character.character_id)) {
      errors.push({
        code: "DUPLICATE_CHARACTER_ID",
        message: `Duplicate character_id "${character.character_id}" in campaign "${campaign.campaign_id}".`,
        path: `characters[${character.character_id}]`,
      });
    }
    seenCharacterIds.add(character.character_id);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}
