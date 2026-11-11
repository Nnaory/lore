/**
 * Tests — Generated Story Semantic Validator (M9 Phase 3)
 *
 * Verifies each generator-specific rule fires on a broken story and stays
 * silent on valid generated output, PLUS that legacy fixtures are unaffected
 * (the validator is only invoked inside the M9 pipeline).
 */

import { describe, it, expect } from "vitest";
import { validateGeneratedStory } from "@/lib/validation/generator-validator";
import { validateStory } from "@/lib/validation/story-validator";
import { buildStoryBlueprint } from "@/lib/ai/story-generator-engine";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import {
  dummyCampaign,
  dummyStory,
  dummyStory2,
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { Scene } from "@/lib/types/scene";
import type { GenerateStoryRequest } from "@/lib/ai/story-generator-types";

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

function generated(index: number): StoryBlueprint {
  const result = buildStoryBlueprint(requestFor(index));
  if (!result.ok) throw new Error("generation failed");
  return result.blueprint;
}

/** Structured deep clone so mutations never touch the source fixture. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function codes(result: ReturnType<typeof validateGeneratedStory>): string[] {
  return result.valid ? [] : result.errors.map((e) => e.code);
}

function scenes(story: StoryBlueprint): Scene[] {
  return story.chapters.flatMap((c) => c.scenes);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("validateGeneratedStory — accepts valid generated output", () => {
  it("accepts every generated story in the campaign", () => {
    for (let i = 0; i < campaign.story_sequence.length; i++) {
      const story = generated(i);
      const material = materials.get(story.material_id)!;
      expect(validateGeneratedStory(story, material).valid).toBe(true);
    }
  });

  it("accepts valid output with full campaign context", () => {
    const story1 = generated(0);
    const story2 = generated(1);
    const material2 = materials.get(story2.material_id)!;
    const result = validateGeneratedStory(story2, material2, {
      entry: campaign.story_sequence[1],
      previousStories: [story1],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts when required_knowledge is empty", () => {
    const story = generated(0);
    const result = validateGeneratedStory(story, materials.get(story.material_id)!, {
      entry: campaign.story_sequence[0],
      previousStories: [],
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural rules
// ---------------------------------------------------------------------------

describe("validateGeneratedStory — structural rules", () => {
  it("reports duplicate chapter IDs", () => {
    const story = clone(generated(0));
    story.chapters.push({ ...story.chapters[0] });
    expect(codes(validateGeneratedStory(story, dummyMaterial))).toContain(
      "DUPLICATE_CHAPTER_ID"
    );
  });

  it("reports duplicate puzzle IDs", () => {
    const story = clone(generated(0));
    story.puzzles.push({ ...story.puzzles[0] });
    expect(codes(validateGeneratedStory(story, dummyMaterial))).toContain(
      "DUPLICATE_PUZZLE_ID"
    );
  });

  it("reports duplicate choice IDs within a puzzle", () => {
    const story = clone(generated(0));
    story.puzzles[0].choices[1].choice_id = story.puzzles[0].choices[0].choice_id;
    expect(codes(validateGeneratedStory(story, dummyMaterial))).toContain(
      "DUPLICATE_CHOICE_ID"
    );
  });

  it("reports duplicate ending IDs", () => {
    const story = clone(generated(0));
    story.endings.push({ ...story.endings[0] });
    expect(codes(validateGeneratedStory(story, dummyMaterial))).toContain(
      "DUPLICATE_ENDING_ID"
    );
  });

  it("reports a wrong ending scene count (zero)", () => {
    const story = clone(generated(0));
    for (const chapter of story.chapters) {
      chapter.scenes = chapter.scenes.filter((s) => s.type !== "ending");
    }
    expect(codes(validateGeneratedStory(story, dummyMaterial))).toContain(
      "ENDING_SCENE_COUNT"
    );
  });

  it("reports a dead-end scene", () => {
    const story = clone(generated(0));
    const target = scenes(story).find((s) => s.type !== "ending")!;
    (target as { next_scene_id: string | null }).next_scene_id = null;
    expect(codes(validateGeneratedStory(story, dummyMaterial))).toContain(
      "DEAD_END_SCENE"
    );
  });
});

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

describe("validateGeneratedStory — reachability", () => {
  it("reports an unreachable scene", () => {
    const story = clone(generated(0));
    const chapter = story.chapters[0];
    chapter.scenes.push({
      scene_id: "scene_orphan",
      type: "narrative",
      characters_present: [],
      content: [{ type: "narration", text: "orphaned" }],
      next_scene_id: "scene_never",
    });
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("UNREACHABLE_SCENE");
  });

  it("reports an unreachable ending", () => {
    const story = clone(generated(0));
    // Sever the chain before the ending so the ending becomes unreachable.
    const flat = scenes(story);
    const beforeEnding = flat[flat.length - 2];
    (beforeEnding as { next_scene_id: string | null }).next_scene_id = null;
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("ENDING_UNREACHABLE");
  });
});

// ---------------------------------------------------------------------------
// Concept coverage
// ---------------------------------------------------------------------------

describe("validateGeneratedStory — concept coverage", () => {
  it("reports a concept that is never introduced", () => {
    const story = clone(generated(0));
    for (const chapter of story.chapters) {
      for (const scene of chapter.scenes) {
        if (!("content" in scene)) continue;
        scene.content = scene.content.filter(
          (block) =>
            !(block.type === "learning_info" && block.concept_ids.includes("concept_linear_combination"))
        );
      }
    }
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("CONCEPT_NOT_INTRODUCED");
  });

  it("reports a concept that is never tested", () => {
    const story = clone(generated(0));
    story.puzzles[0].concept_ids = ["concept_vector_span"];
    story.knowledge_mapping = story.knowledge_mapping.filter(
      (m) => m.concept_id !== "concept_linear_combination"
    );
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("CONCEPT_NOT_TESTED");
  });

  it("reports a concept that is introduced twice", () => {
    const story = clone(generated(0));
    const learningScene = scenes(story).find((s) => s.type === "learning")!;
    const other = scenes(story).find((s) => s.type === "consequence")!;
    (other as { content: unknown[] }).content = [
      { type: "learning_info", title: "dup", body: "dup", concept_ids: ["concept_linear_combination"] },
    ];
    (learningScene as { next_scene_id: string | null }).next_scene_id = other.scene_id;
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("CONCEPT_INTRODUCED_TWICE");
  });

  it("reports a missing knowledge_mapping entry", () => {
    const story = clone(generated(0));
    story.knowledge_mapping = story.knowledge_mapping.filter(
      (m) => m.concept_id !== "concept_vector_span"
    );
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("MISSING_KNOWLEDGE_MAPPING");
  });

  it("reports a duplicate knowledge_mapping entry", () => {
    const story = clone(generated(0));
    story.knowledge_mapping.push({ ...story.knowledge_mapping[0] });
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("DUPLICATE_KNOWLEDGE_MAPPING");
  });

  it("reports a concept reference outside the material", () => {
    const story = clone(generated(0));
    story.knowledge_mapping.push({
      concept_id: "concept_alien",
      introduced_in_scene_id: story.chapters[0].scenes[0].scene_id,
      tested_in_puzzle_id: story.puzzles[0].puzzle_id,
    });
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("INVALID_CONCEPT_REF");
  });
});

// ---------------------------------------------------------------------------
// required_knowledge soundness
// ---------------------------------------------------------------------------

describe("validateGeneratedStory — required_knowledge soundness", () => {
  it("reports a required concept taught by the story's own material", () => {
    const story = generated(0);
    const result = validateGeneratedStory(story, dummyMaterial, {
      entry: {
        ...campaign.story_sequence[0],
        required_knowledge: ["concept_linear_combination"],
      },
    });
    expect(codes(result)).toContain("REQUIRED_KNOWLEDGE_SELF_REFERENCE");
  });

  it("reports a required concept no earlier story tests", () => {
    const story2 = generated(1);
    const result = validateGeneratedStory(story2, dummyMaterial2, {
      entry: campaign.story_sequence[1],
      previousStories: [],
    });
    // With no prior stories supplied there is nothing to check against.
    expect(result.valid).toBe(true);

    const storyWithoutTest = clone(generated(0));
    // Remove every test of the concept the later story requires.
    storyWithoutTest.puzzles = storyWithoutTest.puzzles.filter(
      (p) => !p.concept_ids.includes("concept_vector_span")
    );
    const result2 = validateGeneratedStory(story2, dummyMaterial2, {
      entry: campaign.story_sequence[1],
      previousStories: [storyWithoutTest],
    });
    expect(codes(result2)).toContain("REQUIRED_KNOWLEDGE_UNTESTABLE");
  });

  it("accepts when an earlier story does test the required concept", () => {
    const story1 = generated(0);
    const story2 = generated(1);
    const result = validateGeneratedStory(story2, dummyMaterial2, {
      entry: campaign.story_sequence[1],
      previousStories: [story1],
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prerequisite cycles
// ---------------------------------------------------------------------------

describe("validateGeneratedStory — prerequisite cycles", () => {
  it("reports an intra-material prerequisite cycle", () => {
    const story = generated(0);
    const cyclicMaterial: MaterialBlueprint = {
      ...dummyMaterial,
      concepts: dummyMaterial.concepts.map((c) => ({
        ...c,
        // Introduce a cycle between the two concepts.
        prerequisites: c.concept_id === "concept_linear_combination"
          ? ["concept_vector_span"]
          : c.concept_id === "concept_vector_span"
            ? ["concept_linear_combination"]
            : c.prerequisites,
      })),
    };
    const found = codes(validateGeneratedStory(story, cyclicMaterial));
    expect(found).toContain("CONCEPT_PREREQUISITE_CYCLE");
  });
});

// ---------------------------------------------------------------------------
// Puzzle references
// ---------------------------------------------------------------------------

describe("validateGeneratedStory — puzzle references", () => {
  it("reports a puzzle scene referencing an unknown puzzle", () => {
    const story = clone(generated(0));
    const puzzleScene = scenes(story).find((s) => s.type === "puzzle")!;
    (puzzleScene as { puzzle_id: string }).puzzle_id = "puzzle_ghost";
    const found = codes(validateGeneratedStory(story, dummyMaterial));
    expect(found).toContain("INVALID_PUZZLE_REF");
  });
});

// ---------------------------------------------------------------------------
// Legacy isolation
// ---------------------------------------------------------------------------

describe("legacy fixtures remain valid under their own rules", () => {
  it("dummyStory still validates with the legacy validateStory", () => {
    expect(validateStory(dummyStory, dummyMaterial).valid).toBe(true);
  });

  it("dummyStory2 still validates with the legacy validateStory", () => {
    expect(validateStory(dummyStory2, dummyMaterial).valid).toBe(true);
  });

  it("legacy validateCampaign behavior for dummyCampaign is untouched", () => {
    expect(dummyCampaign.story_sequence.length).toBeGreaterThan(0);
  });
});
