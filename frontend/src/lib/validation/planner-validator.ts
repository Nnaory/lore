/**
 * Semantic Validator — Campaign Planner Output
 *
 * Planner-specific rules that are NOT enforced by the legacy `validateCampaign`
 * (which is intentionally left unchanged to preserve existing behavior).
 *
 * Rules enforced here:
 *   1. One material → exactly one story (every input material appears once,
 *      and no story references a material absent from the input set).
 *   2. Material references must resolve to an input material.
 *   3. required_knowledge must reference concepts defined by an EARLIER story's
 *      material — never the current story's material, never a future one.
 *   4. story_id / character_id / outcome_id uniqueness.
 *   5. Every required_knowledge concept must exist in the union of earlier
 *      materials' concepts.
 *
 * The result shape matches `ValidationResult` from story-validator.ts so the
 * existing error conventions are reused.
 */

import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { ValidationError, ValidationResult } from "@/lib/validation/story-validator";

/** Collect every concept_id defined by a single material. */
function conceptIdsOf(material: MaterialBlueprint): Set<string> {
  return new Set(material.concepts.map((c) => c.concept_id));
}

/**
 * Validate a planner-produced CampaignBlueprint against the materials it was
 * built from.
 *
 * This function does NOT replace `validateCampaign`. Callers that want the
 * legacy rules should call both.
 */
export function validatePlannedCampaign(
  campaign: CampaignBlueprint,
  materials: MaterialBlueprint[]
): ValidationResult {
  const errors: ValidationError[] = [];

  const materialById = new Map<string, MaterialBlueprint>();
  for (const material of materials) {
    materialById.set(material.material_id, material);
  }

  // ─── 1. story_id uniqueness ─────────────────────────────────────────────
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

  // ─── 2. character_id uniqueness ─────────────────────────────────────────
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

  // ─── 3. outcome_id uniqueness (campaign-wide) ───────────────────────────
  const seenOutcomeIds = new Set<string>();
  for (const entry of campaign.story_sequence) {
    for (const outcome of entry.outcomes) {
      if (seenOutcomeIds.has(outcome.outcome_id)) {
        errors.push({
          code: "DUPLICATE_OUTCOME_ID",
          message: `Duplicate outcome_id "${outcome.outcome_id}" in campaign "${campaign.campaign_id}".`,
          path: `story_sequence[${entry.story_id}].outcomes`,
        });
      }
      seenOutcomeIds.add(outcome.outcome_id);
    }
  }

  // ─── 4. one-material-one-story ──────────────────────────────────────────
  // (a) every input material appears exactly once
  // (b) no story references an unknown material
  const storyCountByMaterial = new Map<string, number>();
  for (const entry of campaign.story_sequence) {
    const count = (storyCountByMaterial.get(entry.material_id) ?? 0) + 1;
    storyCountByMaterial.set(entry.material_id, count);

    if (!materialById.has(entry.material_id)) {
      errors.push({
        code: "INVALID_MATERIAL_REF",
        message: `Story "${entry.story_id}" references material_id "${entry.material_id}" which was not provided to the planner.`,
        path: `story_sequence[${entry.story_id}].material_id`,
      });
    }
  }
  for (const [materialId, count] of storyCountByMaterial) {
    if (count > 1) {
      errors.push({
        code: "DUPLICATE_MATERIAL_STORY",
        message: `Material "${materialId}" is referenced by ${count} stories; the Campaign Planner requires exactly one story per material.`,
        path: `story_sequence[material_id=${materialId}]`,
      });
    }
  }
  for (const material of materials) {
    if (!storyCountByMaterial.has(material.material_id)) {
      errors.push({
        code: "UNPLANNED_MATERIAL",
        message: `Material "${material.material_id}" was provided to the planner but has no story in the campaign.`,
        path: `story_sequence[material_id=${material.material_id}]`,
      });
    }
  }

  // ─── 5. required_knowledge ordering ─────────────────────────────────────
  // Build the set of concepts that are "available" before each story, based
  // purely on story_sequence order.
  const availableConcepts = new Set<string>();
  for (const entry of campaign.story_sequence) {
    const currentMaterial = materialById.get(entry.material_id);
    const currentConcepts = currentMaterial
      ? conceptIdsOf(currentMaterial)
      : new Set<string>();

    for (const conceptId of entry.required_knowledge) {
      if (currentConcepts.has(conceptId)) {
        errors.push({
          code: "REQUIRED_KNOWLEDGE_ORDER",
          message: `Story "${entry.story_id}" requires concept "${conceptId}", which is introduced by the SAME material/story. A story may only require concepts from earlier stories.`,
          path: `story_sequence[${entry.story_id}].required_knowledge`,
        });
      } else if (!availableConcepts.has(conceptId)) {
        errors.push({
          code: "REQUIRED_KNOWLEDGE_ORDER",
          message: `Story "${entry.story_id}" requires concept "${conceptId}", which is not introduced by any earlier story. This prerequisite can never be demonstrated.`,
          path: `story_sequence[${entry.story_id}].required_knowledge`,
        });
      }
    }

    // After validating this story, its material's concepts become available.
    for (const conceptId of currentConcepts) {
      availableConcepts.add(conceptId);
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}
