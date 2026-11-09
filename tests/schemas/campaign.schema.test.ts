/**
 * Tests — Campaign Blueprint Schema
 *
 * Verifies that:
 *   - Valid dummy campaign passes validation
 *   - Invalid genre is rejected
 *   - Missing required fields are caught
 *   - Empty story_sequence is rejected
 */

import { describe, it, expect } from "vitest";
import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";
import { dummyCampaign } from "@/data/dummy-campaign";

describe("CampaignBlueprintSchema", () => {
  it("should accept the valid dummy campaign", () => {
    const result = CampaignBlueprintSchema.safeParse(dummyCampaign);
    expect(result.success).toBe(true);
  });

  it("should reject an invalid genre value", () => {
    const bad = { ...dummyCampaign, genre: "romance" };
    const result = CampaignBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject an empty campaign_id", () => {
    const bad = { ...dummyCampaign, campaign_id: "" };
    const result = CampaignBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a campaign with no characters", () => {
    const bad = { ...dummyCampaign, characters: [] };
    const result = CampaignBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a campaign with an empty story_sequence", () => {
    const bad = { ...dummyCampaign, story_sequence: [] };
    const result = CampaignBlueprintSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should accept all valid genre values", () => {
    const genres = [
      "fantasy",
      "modern",
      "science_fiction",
      "mystery",
      "historical",
      "survival",
      "horror",
      "custom",
    ] as const;
    for (const genre of genres) {
      const result = CampaignBlueprintSchema.safeParse({ ...dummyCampaign, genre });
      expect(result.success, `genre "${genre}" should be accepted`).toBe(true);
    }
  });
});
