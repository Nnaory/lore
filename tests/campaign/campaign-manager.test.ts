/**
 * Tests — Campaign Manager (pure logic)
 *
 * No React, no DOM.
 * Tests all campaign-level state transitions.
 */

import { describe, it, expect } from "vitest";
import {
  createInitialCampaignState,
  completeStory,
  isStoryUnlocked,
  getNextStoryEntry,
  isCampaignComplete,
} from "@/lib/game/campaign-manager";
import { dummyCampaign, dummyStory, dummyStory2 } from "@/data/dummy-campaign";
import type { CampaignState } from "@/lib/types/game";

// ── Helpers ──────────────────────────────────────────────────────────────────

function freshState(): CampaignState {
  return createInitialCampaignState(dummyCampaign);
}

// ── createInitialCampaignState ───────────────────────────────────────────────

describe("createInitialCampaignState", () => {
  it("should set current_story_id to the first story in the sequence", () => {
    const state = freshState();
    expect(state.current_story_id).toBe("story_01");
  });

  it("should have no completed stories initially", () => {
    const state = freshState();
    expect(state.completed_stories).toHaveLength(0);
  });

  it("should have no previous_story_summaries initially", () => {
    const state = freshState();
    expect(state.previous_story_summaries).toHaveLength(0);
  });

  it("should set the correct campaign_id", () => {
    const state = freshState();
    expect(state.campaign_id).toBe(dummyCampaign.campaign_id);
  });

  it("should throw if campaign has no stories", () => {
    const emptyCampaign = { ...dummyCampaign, story_sequence: [] };
    expect(() => createInitialCampaignState(emptyCampaign)).toThrow();
  });
});

// ── isStoryUnlocked ───────────────────────────────────────────────────────────

describe("isStoryUnlocked", () => {
  it("first story is always unlocked", () => {
    const state = freshState();
    expect(isStoryUnlocked("story_01", dummyCampaign, state)).toBe(true);
  });

  it("second story is locked before first is completed", () => {
    const state = freshState();
    expect(isStoryUnlocked("story_02", dummyCampaign, state)).toBe(false);
  });

  it("second story is unlocked after first is completed AND concept is demonstrated", () => {
    const afterS1 = completeStory(freshState(), dummyCampaign, dummyStory);
    // story_02 requires concept_linear_combination to be demonstrated
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

  it("returns false for a story_id not in the campaign", () => {
    const state = freshState();
    expect(isStoryUnlocked("story_GHOST", dummyCampaign, state)).toBe(false);
  });
});

// ── completeStory ─────────────────────────────────────────────────────────────

describe("completeStory", () => {
  it("should add the story_id to completed_stories", () => {
    const state = completeStory(freshState(), dummyCampaign, dummyStory);
    expect(state.completed_stories).toContain("story_01");
  });

  it("should advance current_story_id to the next story", () => {
    const state = completeStory(freshState(), dummyCampaign, dummyStory);
    expect(state.current_story_id).toBe("story_02");
  });

  it("should record a previous_story_summary", () => {
    const state = completeStory(freshState(), dummyCampaign, dummyStory);
    expect(state.previous_story_summaries).toHaveLength(1);
    expect(state.previous_story_summaries[0].story_id).toBe("story_01");
    expect(state.previous_story_summaries[0].title).toBe(dummyStory.title);
  });

  it("should apply world_state_changes", () => {
    const state = completeStory(freshState(), dummyCampaign, dummyStory, {
      worldStateChanges: { stability: 20, beacon_power: 50 },
    });
    expect(state.world_state.stability).toBe(20);
    expect(state.world_state.beacon_power).toBe(50);
  });

  it("should apply relationship_changes", () => {
    const state = completeStory(freshState(), dummyCampaign, dummyStory, {
      relationshipChanges: { eldric: 15, lyra: 10 },
    });
    expect(state.relationships.eldric).toBe(15);
    expect(state.relationships.lyra).toBe(10);
  });

  it("should accumulate world_state with existing values", () => {
    const baseState: CampaignState = {
      ...freshState(),
      world_state: { stability: 50, beacon_power: 30 },
    };
    const state = completeStory(baseState, dummyCampaign, dummyStory, {
      worldStateChanges: { stability: 20, beacon_power: 50 },
    });
    expect(state.world_state.stability).toBe(70);
    expect(state.world_state.beacon_power).toBe(80);
  });

  it("should NOT create duplicate completed_stories entries", () => {
    const once = completeStory(freshState(), dummyCampaign, dummyStory);
    const twice = completeStory(once, dummyCampaign, dummyStory);
    const count = twice.completed_stories.filter((id) => id === "story_01").length;
    expect(count).toBe(1);
  });

  it("should not mutate the input state", () => {
    const before = freshState();
    const snapshot = JSON.stringify(before);
    completeStory(before, dummyCampaign, dummyStory);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("completing the last story keeps current_story_id on last story", () => {
    const afterFirst = completeStory(freshState(), dummyCampaign, dummyStory);
    const afterSecond = completeStory(afterFirst, dummyCampaign, dummyStory2);
    // No more stories; current_story_id stays on story_02
    expect(afterSecond.current_story_id).toBe("story_02");
  });
});

// ── getNextStoryEntry ─────────────────────────────────────────────────────────

describe("getNextStoryEntry", () => {
  it("returns first story when nothing is completed", () => {
    const entry = getNextStoryEntry(dummyCampaign, freshState());
    expect(entry?.story_id).toBe("story_01");
  });

  it("returns second story after first is completed", () => {
    const state = completeStory(freshState(), dummyCampaign, dummyStory);
    const entry = getNextStoryEntry(dummyCampaign, state);
    expect(entry?.story_id).toBe("story_02");
  });

  it("returns null when all stories are completed", () => {
    const s1 = completeStory(freshState(), dummyCampaign, dummyStory);
    const s2 = completeStory(s1, dummyCampaign, dummyStory2);
    expect(getNextStoryEntry(dummyCampaign, s2)).toBeNull();
  });
});

// ── isCampaignComplete ────────────────────────────────────────────────────────

describe("isCampaignComplete", () => {
  it("returns false when no stories are completed", () => {
    expect(isCampaignComplete(dummyCampaign, freshState())).toBe(false);
  });

  it("returns false when only the first story is completed", () => {
    const state = completeStory(freshState(), dummyCampaign, dummyStory);
    expect(isCampaignComplete(dummyCampaign, state)).toBe(false);
  });

  it("returns true when all stories are completed", () => {
    const s1 = completeStory(freshState(), dummyCampaign, dummyStory);
    const s2 = completeStory(s1, dummyCampaign, dummyStory2);
    expect(isCampaignComplete(dummyCampaign, s2)).toBe(true);
  });
});

// ── Retry preservation ────────────────────────────────────────────────────────

describe("campaign state — retry preservation", () => {
  it("completed stories are preserved when a story is retried (CampaignState not changed)", () => {
    // Simulate completing story_01, then retrying story_02
    const afterS1 = completeStory(freshState(), dummyCampaign, dummyStory);
    // Retry does not call completeStory — it only resets StoryState (in the hook).
    // Verify that afterS1 still has story_01 completed.
    expect(afterS1.completed_stories).toContain("story_01");
    expect(afterS1.completed_stories).not.toContain("story_02");
  });
});
