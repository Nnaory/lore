/**
 * Tests — Knowledge-based story unlocking (campaign-manager integration)
 *
 * Verifies that `isStoryUnlocked` correctly enforces both sequence
 * prerequisites AND knowledge prerequisites.
 */

import { describe, it, expect } from "vitest";
import {
  isStoryUnlocked,
  createInitialCampaignState,
  completeStory,
} from "@/lib/game/campaign-manager";
import { dummyCampaign, dummyStory } from "@/data/dummy-campaign";
import type { CampaignState, PlayerKnowledge } from "@/lib/types/game";
import type { CampaignBlueprint } from "@/lib/types/campaign";

// Build a campaign variant where story_02 has a required_knowledge entry.
// The base dummyCampaign already has required_knowledge: ["concept_linear_combination"]
// on story_02 — this is what we test.

function freshState(): CampaignState {
  return createInitialCampaignState(dummyCampaign);
}

// ── Sequence-only unlocking (story_01, no prerequisites) ─────────────────────

describe("isStoryUnlocked — first story", () => {
  it("story_01 is always unlocked (no prerequisites)", () => {
    expect(isStoryUnlocked("story_01", dummyCampaign, freshState())).toBe(true);
  });
});

// ── story_02: requires story_01 complete + concept demonstrated ───────────────

describe("isStoryUnlocked — story_02 with required_knowledge", () => {
  it("is locked when story_01 is not complete", () => {
    expect(isStoryUnlocked("story_02", dummyCampaign, freshState())).toBe(false);
  });

  it("is locked when story_01 is complete but concept is not demonstrated", () => {
    const afterS1 = completeStory(freshState(), dummyCampaign, dummyStory);
    // No knowledge yet — player_knowledge is empty
    expect(isStoryUnlocked("story_02", dummyCampaign, afterS1)).toBe(false);
  });

  it("is locked when story_01 is complete and concept is only introduced", () => {
    const afterS1 = completeStory(freshState(), dummyCampaign, dummyStory);
    const state: CampaignState = {
      ...afterS1,
      player_knowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "introduced",
          evidence: [],
        },
      },
    };
    expect(isStoryUnlocked("story_02", dummyCampaign, state)).toBe(false);
  });

  it("is locked when story_01 is complete and concept is developing", () => {
    const afterS1 = completeStory(freshState(), dummyCampaign, dummyStory);
    const state: CampaignState = {
      ...afterS1,
      player_knowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "developing",
          evidence: [],
        },
      },
    };
    expect(isStoryUnlocked("story_02", dummyCampaign, state)).toBe(false);
  });

  it("is unlocked when story_01 is complete AND concept is demonstrated", () => {
    const afterS1 = completeStory(freshState(), dummyCampaign, dummyStory);
    const state: CampaignState = {
      ...afterS1,
      player_knowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "demonstrated",
          evidence: [],
        },
      },
    };
    expect(isStoryUnlocked("story_02", dummyCampaign, state)).toBe(true);
  });

  it("is locked when concept is demonstrated but story_01 is NOT complete", () => {
    // Knowledge without sequence completion — still locked
    const state: CampaignState = {
      ...freshState(),
      player_knowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "demonstrated",
          evidence: [],
        },
      },
    };
    expect(isStoryUnlocked("story_02", dummyCampaign, state)).toBe(false);
  });
});

// ── A campaign with no required_knowledge on story_02 ────────────────────────

describe("isStoryUnlocked — story with empty required_knowledge", () => {
  const campaignNoRequirements: CampaignBlueprint = {
    ...dummyCampaign,
    story_sequence: dummyCampaign.story_sequence.map((s) =>
      s.story_id === "story_02" ? { ...s, required_knowledge: [] } : s
    ),
  };

  it("unlocks story_02 when story_01 is complete and no knowledge required", () => {
    const afterS1 = completeStory(
      createInitialCampaignState(campaignNoRequirements),
      campaignNoRequirements,
      dummyStory
    );
    expect(isStoryUnlocked("story_02", campaignNoRequirements, afterS1)).toBe(true);
  });
});

// ── Previously completed stories remain completed ────────────────────────────

describe("knowledge unlocking does not affect completed stories", () => {
  it("story_01 remains completed after knowledge is added", () => {
    const afterS1 = completeStory(freshState(), dummyCampaign, dummyStory);
    const withKnowledge: CampaignState = {
      ...afterS1,
      player_knowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "demonstrated",
          evidence: [],
        },
      },
    };
    expect(withKnowledge.completed_stories).toContain("story_01");
  });
});
