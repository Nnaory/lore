/**
 * Tests — Campaign Planner ↔ Game Engine Integration (M8 Phase 8)
 *
 * Proves that a planner-produced CampaignBlueprint is directly consumable by
 * the existing, unmodified game engine:
 *   createInitialCampaignState → isStoryUnlocked → completeStory →
 *   isCampaignComplete → getNextStoryEntry
 *
 * Plus the knowledge-unlock path through knowledge-manager.
 *
 * No engine logic is modified to satisfy these tests.
 */

import { describe, it, expect } from "vitest";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import { planCampaign, resetCampaignPlannerCache } from "@/lib/ai/campaign-planner";
import { resetProviderCache } from "@/lib/ai/providers";
import { validateCampaign } from "@/lib/validation/campaign-validator";
import { validatePlannedCampaign } from "@/lib/validation/planner-validator";
import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";
import {
  createInitialCampaignState,
  isStoryUnlocked,
  completeStory,
  isCampaignComplete,
  getNextStoryEntry,
} from "@/lib/game/campaign-manager";
import {
  createInitialKnowledge,
  recordLearningExposure,
  recordPuzzleSubmission,
  mergeKnowledgeUpdates,
} from "@/lib/game/knowledge-manager";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { CampaignState } from "@/lib/types/game";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plan(materials: MaterialBlueprint[]): CampaignBlueprint {
  const result = buildCampaignBlueprint(materials, dummyPlannerOptions);
  if (!result.ok) {
    throw new Error(`planning failed: ${result.code} — ${result.message}`);
  }
  return result.blueprint;
}

/**
 * Minimal StoryBlueprint satisfying completeStory's requirements. The engine
 * only reads story_id and title from this object.
 */
function stubStory(storyId: string, title: string): StoryBlueprint {
  return {
    story_id: storyId,
    material_id: "unused",
    title,
    summary: "",
    character_ids: [],
    chapters: [],
    puzzles: [],
    endings: [],
    continuity_summary: null,
    knowledge_mapping: [],
  };
}

/** Complete every story in the campaign, in order. */
function completeAll(
  campaign: CampaignBlueprint,
  state: CampaignState
): CampaignState {
  let current = state;
  for (const entry of campaign.story_sequence) {
    current = completeStory(
      current,
      campaign,
      stubStory(entry.story_id, entry.title),
      { outcomeDescription: `Completed ${entry.story_id}` }
    );
  }
  return current;
}

// ---------------------------------------------------------------------------
// Structural consumption
// ---------------------------------------------------------------------------

describe("Campaign Planner → engine: structural consumption", () => {
  it("single-material blueprint is schema-valid", () => {
    const blueprint = plan([dummyMaterial]);
    expect(CampaignBlueprintSchema.safeParse(blueprint).success).toBe(true);
  });

  it("single-material blueprint passes existing validateCampaign", () => {
    const blueprint = plan([dummyMaterial]);
    const result = validateCampaign(blueprint, [dummyMaterial]);
    expect(result.valid).toBe(true);
  });

  it("multi-material blueprint passes existing validateCampaign", () => {
    const materials = [dummyMaterial, dummyMaterial2, dummyMaterial3];
    const blueprint = plan(materials);
    const result = validateCampaign(blueprint, materials);
    expect(result.valid).toBe(true);
  });

  it("multi-material blueprint passes planner semantic validation", () => {
    const materials = [dummyMaterial, dummyMaterial2, dummyMaterial3];
    const blueprint = plan(materials);
    const result = validatePlannedCampaign(blueprint, materials);
    expect(result.valid).toBe(true);
  });

  it("createInitialCampaignState accepts the generated campaign", () => {
    const blueprint = plan([dummyMaterial, dummyMaterial2]);
    const state = createInitialCampaignState(blueprint);
    expect(state.campaign_id).toBe(blueprint.campaign_id);
    expect(state.current_story_id).toBe(blueprint.story_sequence[0].story_id);
    expect(state.completed_stories).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One material → one story
// ---------------------------------------------------------------------------

describe("Campaign Planner → engine: one material one story", () => {
  it("every input material appears exactly once (single)", () => {
    const blueprint = plan([dummyMaterial]);
    const ids = blueprint.story_sequence.map((s) => s.material_id);
    expect(ids).toEqual(["material_01"]);
  });

  it("every input material appears exactly once (multi)", () => {
    const materials = [dummyMaterial, dummyMaterial2, dummyMaterial3];
    const blueprint = plan(materials);
    const ids = blueprint.story_sequence.map((s) => s.material_id);
    expect(ids).toHaveLength(materials.length);
    expect(new Set(ids).size).toBe(materials.length);
    expect(ids.sort()).toEqual(
      materials.map((m) => m.material_id).sort()
    );
  });

  it("orders stories by cross-material prerequisite", () => {
    // material_02 depends on concept_vector_span from material_01.
    const blueprint = plan([dummyMaterial2, dummyMaterial]);
    const ids = blueprint.story_sequence.map((s) => s.material_id);
    expect(ids).toEqual(["material_01", "material_02"]);
    expect(blueprint.story_sequence[1].required_knowledge).toEqual([
      "concept_vector_span",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

describe("Campaign Planner → engine: progression", () => {
  const materials = [dummyMaterial, dummyMaterial3];
  const blueprint = plan(materials);

  it("first story is unlocked at campaign start", () => {
    const state = createInitialCampaignState(blueprint);
    expect(isStoryUnlocked(blueprint.story_sequence[0].story_id, blueprint, state)).toBe(true);
  });

  it("subsequent story is locked until the preceding story completes", () => {
    const state = createInitialCampaignState(blueprint);
    const second = blueprint.story_sequence[1];
    expect(isStoryUnlocked(second.story_id, blueprint, state)).toBe(false);
  });

  it("independent second story unlocks after the first completes", () => {
    const state = createInitialCampaignState(blueprint);
    const first = blueprint.story_sequence[0];
    const afterFirst = completeStory(
      state,
      blueprint,
      stubStory(first.story_id, first.title)
    );
    expect(
      isStoryUnlocked(blueprint.story_sequence[1].story_id, blueprint, afterFirst)
    ).toBe(true);
  });

  it("completeStory advances current_story_id", () => {
    const state = createInitialCampaignState(blueprint);
    const first = blueprint.story_sequence[0];
    const afterFirst = completeStory(state, blueprint, stubStory(first.story_id, first.title));
    expect(afterFirst.completed_stories).toEqual([first.story_id]);
    expect(afterFirst.current_story_id).toBe(blueprint.story_sequence[1].story_id);
  });

  it("getNextStoryEntry returns the first incomplete story", () => {
    const state = createInitialCampaignState(blueprint);
    const next = getNextStoryEntry(blueprint, state);
    expect(next?.story_id).toBe(blueprint.story_sequence[0].story_id);
  });

  it("isCampaignComplete is false until all stories finish", () => {
    const initial = createInitialCampaignState(blueprint);
    expect(isCampaignComplete(blueprint, initial)).toBe(false);

    const finished = completeAll(blueprint, initial);
    expect(isCampaignComplete(blueprint, finished)).toBe(true);
    expect(getNextStoryEntry(blueprint, finished)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Knowledge gating
// ---------------------------------------------------------------------------

describe("Campaign Planner → engine: knowledge gating", () => {
  it("a story with cross-material required_knowledge stays locked until demonstrated", () => {
    const materials = [dummyMaterial, dummyMaterial2];
    const blueprint = plan(materials);

    const second = blueprint.story_sequence[1];
    expect(second.material_id).toBe("material_02");
    expect(second.required_knowledge).toEqual(["concept_vector_span"]);

    // Complete the first story's sequence requirement.
    let state = createInitialCampaignState(blueprint);
    const first = blueprint.story_sequence[0];
    state = completeStory(state, blueprint, stubStory(first.story_id, first.title));

    // Sequence satisfied, but knowledge not yet demonstrated → still locked.
    expect(isStoryUnlocked(second.story_id, blueprint, state)).toBe(false);

    // Demonstrate concept_vector_span via a first-try correct puzzle.
    let knowledge = mergeKnowledgeUpdates(state.player_knowledge, {
      concept_vector_span: recordLearningExposure(
        createInitialKnowledge("concept_vector_span"),
        "scene_learning_span",
        1
      ),
    });
    knowledge = mergeKnowledgeUpdates(knowledge, {
      concept_vector_span: recordPuzzleSubmission(
        knowledge["concept_vector_span"],
        "puzzle_span_01",
        true,
        2
      ),
    });
    expect(knowledge["concept_vector_span"].status).toBe("demonstrated");

    const unlockedState: CampaignState = { ...state, player_knowledge: knowledge };
    expect(isStoryUnlocked(second.story_id, blueprint, unlockedState)).toBe(true);
  });

  it("an incorrect first attempt does not demonstrate the concept", () => {
    let knowledge = createInitialKnowledge("concept_vector_span");
    knowledge = recordPuzzleSubmission(knowledge, "puzzle_span_01", false, 1);
    knowledge = recordPuzzleSubmission(knowledge, "puzzle_span_01", true, 2);
    expect(knowledge.status).toBe("developing");

    const materials = [dummyMaterial, dummyMaterial2];
    const blueprint = plan(materials);
    let state = createInitialCampaignState(blueprint);
    const first = blueprint.story_sequence[0];
    state = completeStory(state, blueprint, stubStory(first.story_id, first.title));
    state = { ...state, player_knowledge: { concept_vector_span: knowledge } };

    expect(
      isStoryUnlocked(blueprint.story_sequence[1].story_id, blueprint, state)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service-level integration (through the real dummy provider)
// ---------------------------------------------------------------------------

describe("Campaign Planner service → engine integration", () => {
  it("planCampaign output is engine-consumable end to end", async () => {
    resetCampaignPlannerCache();
    resetProviderCache();

    const result = await planCampaign({
      materials: [dummyMaterial, dummyMaterial2, dummyMaterial3],
      options: dummyPlannerOptions,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.meta.provider).toBe("dummy");
    expect(result.blueprint.story_sequence).toHaveLength(3);

    // Structural + semantic validity.
    expect(CampaignBlueprintSchema.safeParse(result.blueprint).success).toBe(true);
    expect(
      validateCampaign(result.blueprint, [
        dummyMaterial,
        dummyMaterial2,
        dummyMaterial3,
      ]).valid
    ).toBe(true);

    // Engine acceptance and full progression.
    let state = createInitialCampaignState(result.blueprint);
    const first = result.blueprint.story_sequence[0];
    expect(isStoryUnlocked(first.story_id, result.blueprint, state)).toBe(true);

    state = completeAll(result.blueprint, state);
    expect(isCampaignComplete(result.blueprint, state)).toBe(true);
  });

  it("is deterministic at the service level", async () => {
    resetCampaignPlannerCache();
    resetProviderCache();

    const request = {
      materials: [dummyMaterial, dummyMaterial2],
      options: dummyPlannerOptions,
    };

    const a = await planCampaign(request);
    const b = await planCampaign(request);

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.blueprint).toEqual(b.blueprint);
    }
  });
});
