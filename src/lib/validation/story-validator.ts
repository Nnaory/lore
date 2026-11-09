/**
 * Semantic Validator — Story Blueprint
 *
 * Performs cross-reference checks that cannot be expressed in a flat Zod schema.
 * These checks verify the internal consistency of a StoryBlueprint:
 *   - Scene IDs are unique
 *   - next_scene_id references exist
 *   - character_id references exist
 *   - puzzle_id references exist
 *   - ending_id references exist
 *   - concept_id references exist in the MaterialBlueprint
 */

import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";
import type { MaterialBlueprint } from "@/lib/types/material";

export type ValidationError = {
  code: string;
  message: string;
  /** The path to the offending value, e.g. "chapters[0].scenes[2].next_scene_id". */
  path: string;
};

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

/** Collect all scenes from all chapters in document order. */
function collectScenes(story: StoryBlueprint): Scene[] {
  return story.chapters.flatMap((ch) => ch.scenes);
}

/**
 * Validates internal consistency of a StoryBlueprint.
 *
 * Pass a MaterialBlueprint when you want concept_id references to be checked.
 * Omit it to skip concept validation (e.g. when the material is not yet available).
 */
export function validateStory(
  story: StoryBlueprint,
  material?: MaterialBlueprint
): ValidationResult {
  const errors: ValidationError[] = [];

  const allScenes = collectScenes(story);

  // ─── 1. Scene IDs must be unique within the story ───────────────────────
  const seenSceneIds = new Set<string>();
  for (const scene of allScenes) {
    if (seenSceneIds.has(scene.scene_id)) {
      errors.push({
        code: "DUPLICATE_SCENE_ID",
        message: `Duplicate scene_id "${scene.scene_id}" found in story "${story.story_id}".`,
        path: `scenes[${scene.scene_id}]`,
      });
    }
    seenSceneIds.add(scene.scene_id);
  }

  // ─── 2. next_scene_id references must exist ─────────────────────────────
  for (const scene of allScenes) {
    if (
      scene.type !== "ending" &&
      scene.next_scene_id !== null &&
      !seenSceneIds.has(scene.next_scene_id)
    ) {
      errors.push({
        code: "INVALID_NEXT_SCENE_REF",
        message: `Scene "${scene.scene_id}" references next_scene_id "${scene.next_scene_id}" which does not exist in story "${story.story_id}".`,
        path: `scenes[${scene.scene_id}].next_scene_id`,
      });
    }
  }

  // ─── 3. characters_present must reference known characters ──────────────
  const knownCharacterIds = new Set(story.character_ids);
  for (const scene of allScenes) {
    for (const charId of scene.characters_present) {
      if (!knownCharacterIds.has(charId)) {
        errors.push({
          code: "INVALID_CHARACTER_REF",
          message: `Scene "${scene.scene_id}" references character_id "${charId}" which is not listed in story.character_ids.`,
          path: `scenes[${scene.scene_id}].characters_present`,
        });
      }
    }
  }

  // ─── 4. dialogue character_id must reference known characters ───────────
  for (const scene of allScenes) {
    if ("content" in scene) {
      for (const block of scene.content) {
        if (block.type === "dialogue" && !knownCharacterIds.has(block.character_id)) {
          errors.push({
            code: "INVALID_DIALOGUE_CHARACTER_REF",
            message: `A dialogue block in scene "${scene.scene_id}" references character_id "${block.character_id}" which is not in story.character_ids.`,
            path: `scenes[${scene.scene_id}].content[dialogue]`,
          });
        }
      }
    }
  }

  // ─── 5. puzzle_id in puzzle scenes must exist in story.puzzles ──────────
  const knownPuzzleIds = new Set(story.puzzles.map((p) => p.puzzle_id));
  for (const scene of allScenes) {
    if (scene.type === "puzzle" && !knownPuzzleIds.has(scene.puzzle_id)) {
      errors.push({
        code: "INVALID_PUZZLE_REF",
        message: `Puzzle scene "${scene.scene_id}" references puzzle_id "${scene.puzzle_id}" which does not exist in story.puzzles.`,
        path: `scenes[${scene.scene_id}].puzzle_id`,
      });
    }
  }

  // ─── 6. ending_id in ending scenes must exist in story.endings ──────────
  const knownEndingIds = new Set(story.endings.map((e) => e.ending_id));
  for (const scene of allScenes) {
    if (scene.type === "ending" && !knownEndingIds.has(scene.ending_id)) {
      errors.push({
        code: "INVALID_ENDING_REF",
        message: `Ending scene "${scene.scene_id}" references ending_id "${scene.ending_id}" which does not exist in story.endings.`,
        path: `scenes[${scene.scene_id}].ending_id`,
      });
    }
  }

  // ─── 7. concept_ids in puzzles must exist in the material blueprint ──────
  if (material) {
    const knownConceptIds = new Set(material.concepts.map((c) => c.concept_id));
    for (const puzzle of story.puzzles) {
      for (const conceptId of puzzle.concept_ids) {
        if (!knownConceptIds.has(conceptId)) {
          errors.push({
            code: "INVALID_CONCEPT_REF",
            message: `Puzzle "${puzzle.puzzle_id}" references concept_id "${conceptId}" which does not exist in material "${material.material_id}".`,
            path: `puzzles[${puzzle.puzzle_id}].concept_ids`,
          });
        }
      }
    }
  }

  // ─── 8. knowledge_mapping references must exist ─────────────────────────
  for (const entry of story.knowledge_mapping) {
    if (!seenSceneIds.has(entry.introduced_in_scene_id)) {
      errors.push({
        code: "INVALID_KNOWLEDGE_MAPPING_SCENE_REF",
        message: `knowledge_mapping for concept "${entry.concept_id}" references introduced_in_scene_id "${entry.introduced_in_scene_id}" which does not exist.`,
        path: `knowledge_mapping[${entry.concept_id}].introduced_in_scene_id`,
      });
    }
    if (!knownPuzzleIds.has(entry.tested_in_puzzle_id)) {
      errors.push({
        code: "INVALID_KNOWLEDGE_MAPPING_PUZZLE_REF",
        message: `knowledge_mapping for concept "${entry.concept_id}" references tested_in_puzzle_id "${entry.tested_in_puzzle_id}" which does not exist.`,
        path: `knowledge_mapping[${entry.concept_id}].tested_in_puzzle_id`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}
