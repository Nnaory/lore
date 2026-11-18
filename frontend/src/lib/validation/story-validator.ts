/**
 * Semantic Validator — Story Blueprint
 *
 * Performs cross-reference checks that cannot be expressed in a flat Zod schema.
 * These checks verify the internal consistency of a StoryBlueprint:
 *   - Scene IDs are unique
 *   - next_scene_id references exist
 *   - character_id references exist
 *   - puzzle_id references exist
 *   - on_incorrect_scene_id (bad branch) keys are wrong choices and values exist
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

  // ─── 5b. on_incorrect_scene_id (bad branches) must be well-formed ───────
  // Each key must be a WRONG choice of the scene's puzzle (a correct answer
  // never branches), and each value must be an existing scene.
  for (const scene of allScenes) {
    if (scene.type !== "puzzle" || !scene.on_incorrect_scene_id) continue;
    const puzzle = story.puzzles.find((p) => p.puzzle_id === scene.puzzle_id);
    for (const [choiceId, branchSceneId] of Object.entries(scene.on_incorrect_scene_id)) {
      if (puzzle) {
        const choiceExists = puzzle.choices.some((c) => c.choice_id === choiceId);
        if (!choiceExists) {
          errors.push({
            code: "INVALID_BAD_BRANCH_CHOICE_REF",
            message: `Puzzle scene "${scene.scene_id}" maps choice "${choiceId}" to a bad branch, but puzzle "${puzzle.puzzle_id}" has no such choice.`,
            path: `scenes[${scene.scene_id}].on_incorrect_scene_id[${choiceId}]`,
          });
        } else if (choiceId === puzzle.correct_choice_id) {
          errors.push({
            code: "INVALID_BAD_BRANCH_CHOICE_REF",
            message: `Puzzle scene "${scene.scene_id}" maps the correct choice "${choiceId}" to a bad branch; only wrong choices can branch.`,
            path: `scenes[${scene.scene_id}].on_incorrect_scene_id[${choiceId}]`,
          });
        }
      }
      if (!seenSceneIds.has(branchSceneId)) {
        errors.push({
          code: "INVALID_BAD_BRANCH_SCENE_REF",
          message: `Puzzle scene "${scene.scene_id}" sends choice "${choiceId}" to scene "${branchSceneId}", which does not exist in story "${story.story_id}".`,
          path: `scenes[${scene.scene_id}].on_incorrect_scene_id[${choiceId}]`,
        });
      }
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

  // ─── 9. knowledge_mapping concept_ids must match scene learning_info ────
  // The concept_id in knowledge_mapping must actually appear in the
  // learning_info blocks of the referenced scene. If it doesn't, the mapping
  // claims a concept is introduced in a scene that doesn't teach it.
  for (const entry of story.knowledge_mapping) {
    if (!seenSceneIds.has(entry.introduced_in_scene_id)) continue; // already reported
    // Collect concept_ids from learning_info blocks in the referenced scene
    const sceneConceptIds = new Set<string>();
    for (const chapter of story.chapters) {
      const scene = chapter.scenes.find(
        (s) => s.scene_id === entry.introduced_in_scene_id
      );
      if (!scene) continue;
      if ("content" in scene) {
        for (const block of scene.content) {
          if (block.type === "learning_info") {
            block.concept_ids.forEach((id) => sceneConceptIds.add(id));
          }
        }
      }
    }
    if (sceneConceptIds.size > 0 && !sceneConceptIds.has(entry.concept_id)) {
      errors.push({
        code: "KNOWLEDGE_MAPPING_CONCEPT_NOT_IN_SCENE",
        message: `knowledge_mapping entry for concept "${entry.concept_id}" lists scene "${entry.introduced_in_scene_id}" as its introduction scene, but that scene's learning_info blocks do not reference concept "${entry.concept_id}".`,
        path: `knowledge_mapping[${entry.concept_id}].introduced_in_scene_id`,
      });
    }
  }

  // ─── 10. knowledge_mapping concept_ids must match puzzle.concept_ids ────
  // The concept_id in knowledge_mapping must appear in the puzzle's concept_ids.
  // If it doesn't, the mapping claims a concept is tested by a puzzle that
  // doesn't reference it.
  for (const entry of story.knowledge_mapping) {
    if (!knownPuzzleIds.has(entry.tested_in_puzzle_id)) continue; // already reported
    const puzzle = story.puzzles.find(
      (p) => p.puzzle_id === entry.tested_in_puzzle_id
    );
    if (!puzzle) continue;
    if (!puzzle.concept_ids.includes(entry.concept_id)) {
      errors.push({
        code: "KNOWLEDGE_MAPPING_CONCEPT_NOT_IN_PUZZLE",
        message: `knowledge_mapping entry for concept "${entry.concept_id}" lists puzzle "${entry.tested_in_puzzle_id}" as its test puzzle, but that puzzle's concept_ids do not include "${entry.concept_id}".`,
        path: `knowledge_mapping[${entry.concept_id}].tested_in_puzzle_id`,
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}
