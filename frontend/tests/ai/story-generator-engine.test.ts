/**
 * Tests — Story Generator Engine (M9 Phase 2)
 *
 * Verifies determinism, purity, structural shape, concept coverage,
 * puzzle correctness invariants, and error handling.
 */

import { describe, it, expect } from "vitest";
import { buildStoryBlueprint } from "@/lib/ai/story-generator-engine";
import { StoryBlueprintSchema } from "@/lib/ai/schemas/story.schema";
import { validateStory } from "@/lib/validation/story-validator";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import type { GenerateStoryRequest } from "@/lib/ai/story-generator-types";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Scene } from "@/lib/types/scene";
import type { MaterialBlueprint } from "@/lib/types/material";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const planned = buildCampaignBlueprint(
  [dummyMaterial, dummyMaterial2, dummyMaterial3],
  dummyPlannerOptions
);
if (!planned.ok) throw new Error("fixture planning failed");
const campaign = planned.blueprint;

const materials = new Map<string, MaterialBlueprint>([
  [dummyMaterial.material_id, dummyMaterial],
  [dummyMaterial2.material_id, dummyMaterial2],
  [dummyMaterial3.material_id, dummyMaterial3],
]);

function requestFor(index: number): GenerateStoryRequest {
  const entry = campaign.story_sequence[index];
  return {
    campaign,
    story: entry,
    material: materials.get(entry.material_id)!,
  };
}

function build(index: number): StoryBlueprint {
  const result = buildStoryBlueprint(requestFor(index));
  if (!result.ok) throw new Error(`build failed: ${result.code} ${result.message}`);
  return result.blueprint;
}

function allScenes(story: StoryBlueprint): Scene[] {
  return story.chapters.flatMap((c) => c.scenes);
}

// ---------------------------------------------------------------------------
// Structural validity
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — structural validity", () => {
  it("produces a schema-valid StoryBlueprint for every campaign story", () => {
    for (let i = 0; i < campaign.story_sequence.length; i++) {
      const story = build(i);
      const parsed = StoryBlueprintSchema.safeParse(story);
      expect(parsed.success).toBe(true);
    }
  });

  it("passes the existing validateStory with its material", () => {
    for (let i = 0; i < campaign.story_sequence.length; i++) {
      const story = build(i);
      const result = validateStory(story, materials.get(story.material_id)!);
      expect(result.valid).toBe(true);
    }
  });

  it("binds story_id and material_id to the campaign entry", () => {
    for (let i = 0; i < campaign.story_sequence.length; i++) {
      const entry = campaign.story_sequence[i];
      const story = build(i);
      expect(story.story_id).toBe(entry.story_id);
      expect(story.material_id).toBe(entry.material_id);
    }
  });

  it("emits exactly one ending and one ending scene", () => {
    const story = build(0);
    expect(story.endings).toHaveLength(1);
    expect(allScenes(story).filter((s) => s.type === "ending")).toHaveLength(1);
  });

  it("has at least one chapter, each with at least one scene", () => {
    const story = build(0);
    expect(story.chapters.length).toBeGreaterThan(0);
    for (const chapter of story.chapters) {
      expect(chapter.scenes.length).toBeGreaterThan(0);
    }
  });

  it("uses only characters declared by the campaign", () => {
    const story = build(0);
    const campaignIds = new Set(campaign.characters.map((c) => c.character_id));
    for (const id of story.character_ids) expect(campaignIds.has(id)).toBe(true);
  });

  it("uses expression keys the character actually defines", () => {
    const story = build(0);
    const byId = new Map(campaign.characters.map((c) => [c.character_id, c]));
    for (const scene of allScenes(story)) {
      if (!("content" in scene)) continue;
      for (const block of scene.content) {
        if (block.type !== "dialogue") continue;
        const char = byId.get(block.character_id);
        expect(char).toBeDefined();
        expect(Object.keys(char!.expressions)).toContain(block.expression);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scene chain
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — linear scene chain", () => {
  it("starts at the intro scene of the first chapter", () => {
    const story = build(0);
    expect(story.chapters[0].scenes[0].scene_id).toContain("intro");
  });

  it("every non-ending scene has a next_scene_id", () => {
    const story = build(0);
    for (const scene of allScenes(story)) {
      if (scene.type === "ending") continue;
      expect(scene.next_scene_id).not.toBeNull();
    }
  });

  it("walks from the entry scene to the ending without dead ends", () => {
    const story = build(0);
    const index = new Map(allScenes(story).map((s) => [s.scene_id, s]));
    let current = story.chapters[0].scenes[0];
    const visited = new Set<string>();
    let steps = 0;

    while (current.type !== "ending") {
      expect(visited.has(current.scene_id)).toBe(false);
      visited.add(current.scene_id);
      expect(current.next_scene_id).not.toBeNull();
      const next = index.get(current.next_scene_id!);
      expect(next).toBeDefined();
      current = next!;
      expect(++steps).toBeLessThan(200);
    }

    expect(visited.size).toBe(allScenes(story).length - 1);
  });

  it("orders learning → puzzle → result for each concept", () => {
    const story = build(0);
    const scenes = allScenes(story);
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (scene.type !== "learning") continue;
      expect(scenes[i + 1].type).toBe("puzzle");
      expect(scenes[i + 2].type).toBe("consequence");
    }
  });
});

// ---------------------------------------------------------------------------
// Concept coverage
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — concept coverage", () => {
  it("teaches and tests every concept in the material", () => {
    for (let i = 0; i < campaign.story_sequence.length; i++) {
      const story = build(i);
      const material = materials.get(story.material_id)!;
      const mapped = new Set(story.knowledge_mapping.map((m) => m.concept_id));
      for (const concept of material.concepts) {
        expect(mapped.has(concept.concept_id)).toBe(true);
      }
      expect(story.knowledge_mapping).toHaveLength(material.concepts.length);
    }
  });

  it("gives every mapping a learning scene and a puzzle", () => {
    const story = build(0);
    const sceneIds = new Set(allScenes(story).map((s) => s.scene_id));
    const puzzleIds = new Set(story.puzzles.map((p) => p.puzzle_id));
    for (const m of story.knowledge_mapping) {
      expect(sceneIds.has(m.introduced_in_scene_id)).toBe(true);
      expect(puzzleIds.has(m.tested_in_puzzle_id)).toBe(true);
    }
  });

  it("each puzzle tests exactly its mapped concept", () => {
    const story = build(0);
    for (const m of story.knowledge_mapping) {
      const puzzle = story.puzzles.find((p) => p.puzzle_id === m.tested_in_puzzle_id)!;
      expect(puzzle.concept_ids).toEqual([m.concept_id]);
    }
  });

  it("every learning_info block references exactly its concept", () => {
    const story = build(0);
    for (const scene of allScenes(story)) {
      if (!("content" in scene)) continue;
      for (const block of scene.content) {
        if (block.type === "learning_info") {
          expect(block.concept_ids).toHaveLength(1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Puzzle invariants
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — puzzle invariants", () => {
  it("has at least two choices per puzzle", () => {
    const story = build(0);
    for (const puzzle of story.puzzles) {
      expect(puzzle.choices.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("correct_choice_id always resolves", () => {
    const story = build(0);
    for (const puzzle of story.puzzles) {
      expect(puzzle.choices.some((c) => c.choice_id === puzzle.correct_choice_id)).toBe(true);
    }
  });

  it("choice ids are unique within a puzzle", () => {
    const story = build(0);
    for (const puzzle of story.puzzles) {
      const ids = puzzle.choices.map((c) => c.choice_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("the correct choice states the concept definition", () => {
    const story = build(0);
    const material = materials.get(story.material_id)!;
    for (const puzzle of story.puzzles) {
      const correct = puzzle.choices.find((c) => c.choice_id === puzzle.correct_choice_id)!;
      const concept = material.concepts.find((c) => c.concept_id === puzzle.concept_ids[0])!;
      expect(correct.text).toBe(concept.definition);
    }
  });

  it("distractors come from the material's misconceptions when present", () => {
    const story = build(0);
    const material = materials.get(story.material_id)!;
    for (const puzzle of story.puzzles) {
      const concept = material.concepts.find((c) => c.concept_id === puzzle.concept_ids[0])!;
      if (concept.misconceptions.length === 0) continue;
      const wrong = puzzle.choices.filter((c) => c.choice_id !== puzzle.correct_choice_id);
      expect(wrong.length).toBeGreaterThan(0);
      expect(concept.misconceptions).toContain(wrong[0].text);
    }
  });

  it("never emits a puzzle with a missing explanation or feedback", () => {
    const story = build(0);
    for (const puzzle of story.puzzles) {
      expect(puzzle.explanation.length).toBeGreaterThan(0);
      expect(puzzle.correct_feedback.length).toBeGreaterThan(0);
      expect(puzzle.incorrect_feedback.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and purity
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — determinism and purity", () => {
  it("returns deep-equal output for identical requests", () => {
    const a = buildStoryBlueprint(requestFor(0));
    const b = buildStoryBlueprint(requestFor(0));
    expect(a).toEqual(b);
  });

  it("does not mutate the request", () => {
    const req = requestFor(0);
    const before = JSON.stringify(req);
    buildStoryBlueprint(req);
    expect(JSON.stringify(req)).toBe(before);
  });

  it("works with a deeply frozen request", () => {
    const req = requestFor(0);
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === "object") {
        Object.freeze(o);
        for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
      }
    };
    deepFreeze(req);
    const result = buildStoryBlueprint(req);
    expect(result.ok).toBe(true);
  });

  it("does not depend on wall-clock or randomness", () => {
    const a = buildStoryBlueprint(requestFor(1));
    const b = buildStoryBlueprint(requestFor(1));
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — error handling", () => {
  it("rejects a story entry not present in the campaign", () => {
    const req = requestFor(0);
    const result = buildStoryBlueprint({
      ...req,
      story: { ...req.story, story_id: "story_missing" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("STORY_NOT_IN_CAMPAIGN");
  });

  it("rejects a material that does not match the entry", () => {
    const req = requestFor(0);
    const other = [...materials.values()].find((m) => m.material_id !== req.story.material_id)!;
    const result = buildStoryBlueprint({ ...req, material: other });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MATERIAL_MISMATCH");
  });

  it("rejects a material with no concepts", () => {
    const req = requestFor(0);
    const result = buildStoryBlueprint({
      ...req,
      material: { ...req.material, concepts: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONCEPT_COVERAGE");
  });
});

// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — continuity", () => {
  it("fills continuity_summary deterministically", () => {
    const story = build(0);
    expect(story.continuity_summary).not.toBeNull();
    expect(story.continuity_summary!.story_id).toBe(story.story_id);
    expect(story.continuity_summary!.key_decisions).toEqual([]);
  });

  it("mirrors the campaign entry outcome into the ending world state", () => {
    const entry = campaign.story_sequence[0];
    const story = build(0);
    expect(story.endings[0].world_state_changes).toEqual(
      entry.outcomes[0].world_state_changes
    );
  });

  it("emits a continuity warning when required_knowledge has no prior context", () => {
    const req = requestFor(1);
    expect(req.story.required_knowledge.length).toBeGreaterThan(0);
    const result = buildStoryBlueprint(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.code === "CONTINUITY_CONTEXT_MISSING")).toBe(true);
    }
  });

  it("suppresses the warning once previous summaries are supplied", () => {
    const req = requestFor(1);
    const result = buildStoryBlueprint({
      ...req,
      previousSummaries: [
        {
          story_id: campaign.story_sequence[0].story_id,
          title: campaign.story_sequence[0].title,
          outcome_description: "Resolved",
          world_state_snapshot: { stability: 10 },
          relationship_snapshot: {},
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((w) => w.code === "CONTINUITY_CONTEXT_MISSING")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Chaptering
// ---------------------------------------------------------------------------

describe("buildStoryBlueprint — chaptering", () => {
  it("keeps a single chapter by default", () => {
    const story = build(0);
    expect(story.chapters).toHaveLength(1);
  });

  it("splits chapters when conceptsPerChapter is small", () => {
    const req = requestFor(0);
    const result = buildStoryBlueprint({
      ...req,
      options: { conceptsPerChapter: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.chapters.length).toBeGreaterThan(1);
      // Scene order must remain globally linear across chapters.
      const flat = result.blueprint.chapters.flatMap((c) => c.scenes);
      for (let i = 0; i < flat.length - 1; i++) {
        const scene = flat[i];
        if (scene.type === "ending") continue;
        expect(scene.next_scene_id).toBe(flat[i + 1].scene_id);
      }
    }
  });
});
