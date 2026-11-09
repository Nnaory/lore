/**
 * Tests — Campaign Semantic Validator
 *
 * Verifies that:
 *   - Valid dummy campaign passes semantic validation
 *   - Duplicate story_ids are caught
 *   - Invalid material_id references are caught
 *   - Invalid required_knowledge concept references are caught
 *   - Duplicate character_ids are caught
 */

import { describe, it, expect } from "vitest";
import { validateCampaign } from "@/lib/validation/campaign-validator";
import { dummyCampaign, dummyMaterial } from "@/data/dummy-campaign";
import type { CampaignBlueprint } from "@/lib/types/campaign";

function cloneCampaign(): CampaignBlueprint {
  return JSON.parse(JSON.stringify(dummyCampaign)) as CampaignBlueprint;
}

describe("validateCampaign — valid data", () => {
  it("should pass for the valid dummy campaign", () => {
    const result = validateCampaign(dummyCampaign, [dummyMaterial]);
    expect(result.valid).toBe(true);
  });
});

describe("validateCampaign — duplicate story IDs", () => {
  it("should detect duplicate story_ids in story_sequence", () => {
    const campaign = cloneCampaign();
    // Add a duplicate of the existing story entry
    campaign.story_sequence.push({ ...campaign.story_sequence[0] });

    const result = validateCampaign(campaign, [dummyMaterial]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_STORY_ID");
    }
  });
});

describe("validateCampaign — invalid material references", () => {
  it("should detect a story referencing a material_id not in the provided materials", () => {
    const campaign = cloneCampaign();
    campaign.story_sequence[0].material_id = "material_NONEXISTENT";

    const result = validateCampaign(campaign, [dummyMaterial]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_MATERIAL_REF");
    }
  });
});

describe("validateCampaign — invalid required_knowledge references", () => {
  it("should detect a concept_id in required_knowledge that does not exist", () => {
    const campaign = cloneCampaign();
    campaign.story_sequence[0].required_knowledge = ["concept_NONEXISTENT"];

    const result = validateCampaign(campaign, [dummyMaterial]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_REQUIRED_KNOWLEDGE_REF");
    }
  });
});

describe("validateCampaign — duplicate character IDs", () => {
  it("should detect duplicate character_ids in the characters array", () => {
    const campaign = cloneCampaign();
    campaign.characters.push({ ...campaign.characters[0] }); // duplicate eldric

    const result = validateCampaign(campaign, [dummyMaterial]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_CHARACTER_ID");
    }
  });
});
