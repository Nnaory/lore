/**
 * Tests — Game State Schemas (StoryState & CampaignState)
 *
 * Verifies that:
 *   - Valid dummy states pass validation
 *   - HP out of range (< 0, > 5) is rejected
 *   - Invalid StoryStatus values are rejected
 *   - Invalid KnowledgeStatus values are rejected
 */

import { describe, it, expect } from "vitest";
import { StoryStateSchema, CampaignStateSchema } from "@/lib/ai/schemas/game.schema";
import { dummyStoryState, dummyCampaignState } from "@/data/dummy-campaign";

describe("StoryStateSchema", () => {
  it("should accept the valid dummy story state", () => {
    const result = StoryStateSchema.safeParse(dummyStoryState);
    expect(result.success).toBe(true);
  });

  it("should reject HP less than 0", () => {
    const bad = { ...dummyStoryState, hp: -1 };
    const result = StoryStateSchema.safeParse(bad);
    expect(result.success).toBe(false);

    if (!result.success) {
      const msgs = result.error.errors.map((e) => e.message);
      expect(msgs.some((m) => m.includes("HP"))).toBe(true);
    }
  });

  it("should reject HP greater than 5", () => {
    const bad = { ...dummyStoryState, hp: 6 };
    const result = StoryStateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should accept all valid HP values (0–5)", () => {
    for (let hp = 0; hp <= 5; hp++) {
      const result = StoryStateSchema.safeParse({ ...dummyStoryState, hp });
      expect(result.success, `HP ${hp} should be valid`).toBe(true);
    }
  });

  it("should reject an invalid story status", () => {
    const bad = { ...dummyStoryState, status: "paused" };
    const result = StoryStateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should accept all valid story status values", () => {
    const statuses = ["not_started", "in_progress", "story_failed", "completed"] as const;
    for (const status of statuses) {
      const result = StoryStateSchema.safeParse({ ...dummyStoryState, status });
      expect(result.success, `status "${status}" should be valid`).toBe(true);
    }
  });
});

describe("CampaignStateSchema", () => {
  it("should accept the valid dummy campaign state", () => {
    const result = CampaignStateSchema.safeParse(dummyCampaignState);
    expect(result.success).toBe(true);
  });

  it("should reject an invalid knowledge status", () => {
    const bad = {
      ...dummyCampaignState,
      player_knowledge: {
        concept_linear_combination: {
          concept_id: "concept_linear_combination",
          status: "mastered", // invalid — not in the enum
          evidence: [],
        },
      },
    };
    const result = CampaignStateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should accept all valid knowledge status values", () => {
    const statuses = [
      "not_introduced",
      "introduced",
      "developing",
      "demonstrated",
    ] as const;
    for (const status of statuses) {
      const state = {
        ...dummyCampaignState,
        player_knowledge: {
          concept_linear_combination: {
            concept_id: "concept_linear_combination",
            status,
            evidence: [],
          },
        },
      };
      const result = CampaignStateSchema.safeParse(state);
      expect(result.success, `knowledge status "${status}" should be valid`).toBe(
        true
      );
    }
  });

  it("should reject a campaign state with an empty campaign_id", () => {
    const bad = { ...dummyCampaignState, campaign_id: "" };
    const result = CampaignStateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
