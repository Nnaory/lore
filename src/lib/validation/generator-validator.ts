/**
 * Semantic Validator — Generated Story (Layer 3, M9)
 *
 * Generator-specific rules that `validateStory` (legacy, unchanged) does not
 * enforce. Kept in its own module so legacy fixtures (`dummyStory`,
 * `dummyStory2`) are never subjected to stricter rules than they were written
 * for — exactly the isolation pattern used by `planner-validator.ts` in M8.
 *
 * Rules enforced here:
 *   1. Chapter IDs are unique.
 *   2. Puzzle IDs are unique; choice IDs are unique within a puzzle.
 *   3. Ending IDs are unique; exactly one ending scene exists.
 *   4. Every non-ending scene has a non-null `next_scene_id` (no silent dead
 *      ends — the engine treats a null next scene as story completion).
 *   5. All scenes are reachable from the entry scene (no orphans).
 *   6. An ending is reachable from the entry scene.
 *   7. Concept coverage: every material concept has exactly one learning
 *      scene and one puzzle, and exactly one knowledge_mapping entry.
 *   8. Knowledge mapping is complete and bijective with material concepts.
 *   9. `required_knowledge` soundness: a required concept must NOT be defined
 *      by this story's own material (it must be learnable earlier), and — when
 *      prior stories are supplied — must be tested by one of them.
 *  10. Intra-material prerequisite cycles are reported.
 *  11. Puzzle scenes reference a puzzle that exists; puzzle concept_ids
 *      resolve to this material.
 *
 * The result shape matches `ValidationResult` from story-validator.ts.
 */

import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StorySummaryEntry } from "@/lib/types/campaign";
import type { ValidationError, ValidationResult } from "@/lib/validation/story-validator";

/** Optional campaign context for cross-story progression checks. */
export interface GeneratedStoryContext {
  /** The campaign entry this story was generated for. */
  entry?: StorySummaryEntry;
  /** Already-generated earlier stories in the same campaign, in order. */
  previousStories?: StoryBlueprint[];
}

function collectScenes(story: StoryBlueprint): Scene[] {
  return story.chapters.flatMap((ch) => ch.scenes);
}

/** Breadth-first reachable set from the story's entry scene. */
function reachableSceneIds(story: StoryBlueprint, scenes: Scene[]): Set<string> {
  const index = new Map(scenes.map((s) => [s.scene_id, s]));
  const entry = story.chapters[0]?.scenes[0];
  const reachable = new Set<string>();
  if (!entry) return reachable;

  const queue: string[] = [entry.scene_id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const scene = index.get(id);
    if (!scene) continue;
    if (scene.type === "ending") continue;
    if (scene.next_scene_id) queue.push(scene.next_scene_id);
  }
  return reachable;
}

/** Detect intra-material prerequisite cycles; returns involved concept IDs. */
function intraMaterialCycleConcepts(material: MaterialBlueprint): string[] {
  const byId = new Map(material.concepts.map((c) => [c.concept_id, c]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const inCycle = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    const mark = state.get(id) ?? 0;
    if (mark === 2) return;
    if (mark === 1) {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start === -1 ? 0 : start)) {
        inCycle.add(member);
      }
      return;
    }
    state.set(id, 1);
    stack.push(id);
    const concept = byId.get(id);
    for (const prereq of concept?.prerequisites ?? []) {
      if (byId.has(prereq)) visit(prereq, stack);
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const concept of material.concepts) visit(concept.concept_id, []);
  return [...inCycle].sort();
}

/**
 * Validate a generated StoryBlueprint against its material and campaign
 * context.
 *
 * This does NOT replace `validateStory`; callers that want the legacy
 * structural checks should call both. `validateStory` covers dangling
 * references; this function covers generation-specific soundness.
 */
export function validateGeneratedStory(
  story: StoryBlueprint,
  material: MaterialBlueprint,
  context: GeneratedStoryContext = {}
): ValidationResult {
  const errors: ValidationError[] = [];
  const scenes = collectScenes(story);

  // ─── 1. Chapter IDs must be unique ──────────────────────────────────────
  const seenChapterIds = new Set<string>();
  for (const chapter of story.chapters) {
    if (seenChapterIds.has(chapter.chapter_id)) {
      errors.push({
        code: "DUPLICATE_CHAPTER_ID",
        message: `Duplicate chapter_id "${chapter.chapter_id}" in story "${story.story_id}".`,
        path: `chapters[${chapter.chapter_id}]`,
      });
    }
    seenChapterIds.add(chapter.chapter_id);
  }

  // ─── 2. Puzzle IDs and choice IDs must be unique ────────────────────────
  const seenPuzzleIds = new Set<string>();
  for (const puzzle of story.puzzles) {
    if (seenPuzzleIds.has(puzzle.puzzle_id)) {
      errors.push({
        code: "DUPLICATE_PUZZLE_ID",
        message: `Duplicate puzzle_id "${puzzle.puzzle_id}" in story "${story.story_id}".`,
        path: `puzzles[${puzzle.puzzle_id}]`,
      });
    }
    seenPuzzleIds.add(puzzle.puzzle_id);

    const seenChoiceIds = new Set<string>();
    for (const choice of puzzle.choices) {
      if (seenChoiceIds.has(choice.choice_id)) {
        errors.push({
          code: "DUPLICATE_CHOICE_ID",
          message: `Duplicate choice_id "${choice.choice_id}" in puzzle "${puzzle.puzzle_id}".`,
          path: `puzzles[${puzzle.puzzle_id}].choices[${choice.choice_id}]`,
        });
      }
      seenChoiceIds.add(choice.choice_id);
    }
  }

  // ─── 3. Ending IDs unique; exactly one ending scene ─────────────────────
  const seenEndingIds = new Set<string>();
  for (const ending of story.endings) {
    if (seenEndingIds.has(ending.ending_id)) {
      errors.push({
        code: "DUPLICATE_ENDING_ID",
        message: `Duplicate ending_id "${ending.ending_id}" in story "${story.story_id}".`,
        path: `endings[${ending.ending_id}]`,
      });
    }
    seenEndingIds.add(ending.ending_id);
  }

  const endingScenes = scenes.filter((s) => s.type === "ending");
  if (endingScenes.length !== 1) {
    errors.push({
      code: "ENDING_SCENE_COUNT",
      message: `Story "${story.story_id}" must contain exactly one ending scene, found ${endingScenes.length}.`,
      path: "chapters[*].scenes",
    });
  }

  // ─── 4. No silent dead ends ─────────────────────────────────────────────
  for (const scene of scenes) {
    if (scene.type === "ending") continue;
    if (scene.next_scene_id === null) {
      errors.push({
        code: "DEAD_END_SCENE",
        message: `Scene "${scene.scene_id}" (${scene.type}) has no next_scene_id. The engine would treat this as story completion.`,
        path: `scenes[${scene.scene_id}].next_scene_id`,
      });
    }
  }

  // ─── 5/6. Reachability ──────────────────────────────────────────────────
  const reachable = reachableSceneIds(story, scenes);
  for (const scene of scenes) {
    if (!reachable.has(scene.scene_id)) {
      errors.push({
        code: "UNREACHABLE_SCENE",
        message: `Scene "${scene.scene_id}" is not reachable from the entry scene.`,
        path: `scenes[${scene.scene_id}]`,
      });
    }
  }
  if (endingScenes.length > 0 && !reachable.has(endingScenes[0].scene_id)) {
    errors.push({
      code: "ENDING_UNREACHABLE",
      message: `The ending scene "${endingScenes[0].scene_id}" is not reachable from the entry scene.`,
      path: `scenes[${endingScenes[0].scene_id}]`,
    });
  }

  // ─── 7. Concept coverage ────────────────────────────────────────────────
  const materialConceptIds = new Set(material.concepts.map((c) => c.concept_id));

  const introduced = new Map<string, string[]>(); // concept_id → scene ids
  for (const scene of scenes) {
    if (!("content" in scene)) continue;
    for (const block of scene.content) {
      if (block.type !== "learning_info") continue;
      for (const conceptId of block.concept_ids) {
        const list = introduced.get(conceptId) ?? [];
        list.push(scene.scene_id);
        introduced.set(conceptId, list);
      }
    }
  }

  const tested = new Map<string, string[]>(); // concept_id → puzzle ids
  for (const puzzle of story.puzzles) {
    for (const conceptId of puzzle.concept_ids) {
      const list = tested.get(conceptId) ?? [];
      list.push(puzzle.puzzle_id);
      tested.set(conceptId, list);
    }
  }

  for (const conceptId of materialConceptIds) {
    const introScenes = introduced.get(conceptId) ?? [];
    const testPuzzles = tested.get(conceptId) ?? [];

    if (introScenes.length === 0) {
      errors.push({
        code: "CONCEPT_NOT_INTRODUCED",
        message: `Concept "${conceptId}" is never introduced by a learning_info block.`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    } else if (introScenes.length > 1) {
      errors.push({
        code: "CONCEPT_INTRODUCED_TWICE",
        message: `Concept "${conceptId}" is introduced in multiple scenes: ${introScenes.join(", ")}.`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    }

    if (testPuzzles.length === 0) {
      errors.push({
        code: "CONCEPT_NOT_TESTED",
        message: `Concept "${conceptId}" is never tested by a puzzle, so it can never be demonstrated.`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    } else if (testPuzzles.length > 1) {
      errors.push({
        code: "CONCEPT_TESTED_TWICE",
        message: `Concept "${conceptId}" is tested by multiple puzzles: ${testPuzzles.join(", ")}.`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    }
  }

  // Concept IDs referenced by the story must belong to this material.
  for (const conceptId of introduced.keys()) {
    if (!materialConceptIds.has(conceptId)) {
      errors.push({
        code: "INVALID_CONCEPT_REF",
        message: `learning_info introduces concept "${conceptId}" which is not defined by material "${material.material_id}".`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    }
  }
  for (const conceptId of tested.keys()) {
    if (!materialConceptIds.has(conceptId)) {
      errors.push({
        code: "INVALID_CONCEPT_REF",
        message: `A puzzle tests concept "${conceptId}" which is not defined by material "${material.material_id}".`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    }
  }

  // ─── 8. knowledge_mapping completeness and bijectivity ──────────────────
  const mappedConcepts = new Set<string>();
  for (const entry of story.knowledge_mapping) {
    if (mappedConcepts.has(entry.concept_id)) {
      errors.push({
        code: "DUPLICATE_KNOWLEDGE_MAPPING",
        message: `knowledge_mapping contains multiple entries for concept "${entry.concept_id}".`,
        path: `knowledge_mapping[${entry.concept_id}]`,
      });
    }
    mappedConcepts.add(entry.concept_id);
  }

  for (const conceptId of materialConceptIds) {
    if (!mappedConcepts.has(conceptId)) {
      errors.push({
        code: "MISSING_KNOWLEDGE_MAPPING",
        message: `Concept "${conceptId}" has no knowledge_mapping entry.`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    }
  }

  for (const conceptId of mappedConcepts) {
    if (!materialConceptIds.has(conceptId)) {
      errors.push({
        code: "INVALID_CONCEPT_REF",
        message: `knowledge_mapping references concept "${conceptId}" which is not defined by material "${material.material_id}".`,
        path: `knowledge_mapping[${conceptId}]`,
      });
    }
  }

  // ─── 9. required_knowledge soundness ────────────────────────────────────
  if (context.entry) {
    const priorTested = new Set<string>();
    for (const prior of context.previousStories ?? []) {
      for (const puzzle of prior.puzzles) {
        for (const conceptId of puzzle.concept_ids) priorTested.add(conceptId);
      }
    }
    const hasPriorContext = (context.previousStories ?? []).length > 0;

    for (const conceptId of context.entry.required_knowledge) {
      if (materialConceptIds.has(conceptId)) {
        errors.push({
          code: "REQUIRED_KNOWLEDGE_SELF_REFERENCE",
          message: `Story "${story.story_id}" requires concept "${conceptId}" but that concept is taught by this story's own material "${material.material_id}".`,
          path: `story.required_knowledge[${conceptId}]`,
        });
      }
      if (hasPriorContext && !priorTested.has(conceptId)) {
        errors.push({
          code: "REQUIRED_KNOWLEDGE_UNTESTABLE",
          message: `Story "${story.story_id}" requires concept "${conceptId}" but no earlier supplied story tests it, so it can never be demonstrated.`,
          path: `story.required_knowledge[${conceptId}]`,
        });
      }
    }
  }

  // ─── 10. Intra-material prerequisite cycles ─────────────────────────────
  const cyclic = intraMaterialCycleConcepts(material);
  if (cyclic.length > 0) {
    errors.push({
      code: "CONCEPT_PREREQUISITE_CYCLE",
      message: `Material "${material.material_id}" has an intra-material prerequisite cycle involving: ${cyclic.join(", ")}.`,
      path: `material[${material.material_id}].concepts`,
    });
  }

  // ─── 11. Puzzle scene references ────────────────────────────────────────
  const puzzleIds = new Set(story.puzzles.map((p) => p.puzzle_id));
  for (const scene of scenes) {
    if (scene.type === "puzzle" && !puzzleIds.has(scene.puzzle_id)) {
      errors.push({
        code: "INVALID_PUZZLE_REF",
        message: `Puzzle scene "${scene.scene_id}" references unknown puzzle "${scene.puzzle_id}".`,
        path: `scenes[${scene.scene_id}].puzzle_id`,
      });
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}
