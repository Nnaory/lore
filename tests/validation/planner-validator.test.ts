/**
 * Tests — Campaign Planner Validator (M8 Phase 3)
 *
 * Verifies planner-specific semantic rules while proving the legacy
 * `validateCampaign` behavior is untouched.
 */

import { describe, it, expect } from "vitest";
import { validatePlannedCampaign } from "@/lib/validation/planner-validator";
import { validateCampaign } from "@/lib/validation/campaign-validator";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import { dummyCampaign, dummyMaterial } from "@/data/dummy-campaign";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";

function makeMaterial(
  id: string,
  concepts: Array<{ id: string; prerequisites?: string[] }>
): MaterialBlueprint {
  return {
    material_id: id,
    title: `Title of ${id}`,
    summary: `Summary of ${id}`,
    learning_objectives: [`Objective of ${id}`],
    concepts: concepts.map((c) => ({
      concept_id: c.id,
      name: `Name of ${c.id}`,
      definition: `Definition of ${c.id}`,
      principles: [],
      methods: [],
      prerequisites: c.prerequisites ?? [],
      misconceptions: [],
      source_evidence: [],
    })),
    scope_limitations: [],
  };
}

function cloneCampaign(): CampaignBlueprint {
  return JSON.parse(JSON.stringify(dummyCampaign)) as CampaignBlueprint;
}

const MAT_M1 = makeMaterial("m1", [{ id: "c1" }]);
const MAT_M2 = makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]);
const MAT_M3 = makeMaterial("m3", [{ id: "c3" }]);

/** Plan and unwrap a blueprint, throwing if planning fails. */
function plan(materials: MaterialBlueprint[]): CampaignBlueprint {
  const result = buildCampaignBlueprint(materials, { genre: "fantasy" });
  if (!result.ok) throw new Error(`planning failed: ${result.code} ${result.message}`);
  return result.blueprint;
}

// ---------------------------------------------------------------------------
// Valid cases
// ---------------------------------------------------------------------------

describe("validatePlannedCampaign — valid planner output", () => {
  it("accepts a single-material blueprint", () => {
    const blueprint = plan([MAT_M1]);
    const result = validatePlannedCampaign(blueprint, [MAT_M1]);
    expect(result.valid).toBe(true);
  });

  it("accepts a multi-material blueprint with derived prerequisites", () => {
    const blueprint = plan([MAT_M1, MAT_M2]);
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M2]);
    expect(result.valid).toBe(true);
  });

  it("accepts an independent multi-material blueprint", () => {
    const blueprint = plan([MAT_M1, MAT_M3]);
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M3]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One-material-one-story
// ---------------------------------------------------------------------------

describe("validatePlannedCampaign — one-material-one-story", () => {
  it("rejects a campaign where a material has two stories", () => {
    const blueprint = plan([MAT_M1, MAT_M3]);
    blueprint.story_sequence.push({
      ...blueprint.story_sequence[0],
      story_id: "story_99",
      outcomes: [],
    });
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain(
        "DUPLICATE_MATERIAL_STORY"
      );
    }
  });

  it("rejects a campaign that omits an input material", () => {
    const blueprint = plan([MAT_M1]);
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain("UNPLANNED_MATERIAL");
    }
  });

  it("rejects a story referencing an unknown material", () => {
    const blueprint = plan([MAT_M1]);
    blueprint.story_sequence[0].material_id = "m_ghost";
    const result = validatePlannedCampaign(blueprint, [MAT_M1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("INVALID_MATERIAL_REF");
      expect(codes).toContain("UNPLANNED_MATERIAL");
    }
  });
});

// ---------------------------------------------------------------------------
// required_knowledge ordering
// ---------------------------------------------------------------------------

describe("validatePlannedCampaign — required_knowledge ordering", () => {
  it("rejects a story requiring a concept from its OWN material", () => {
    const blueprint = plan([MAT_M1]);
    blueprint.story_sequence[0].required_knowledge = ["c1"];
    const result = validatePlannedCampaign(blueprint, [MAT_M1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain(
        "REQUIRED_KNOWLEDGE_ORDER"
      );
    }
  });

  it("rejects a story requiring a concept from a FUTURE story", () => {
    const blueprint = plan([MAT_M1, MAT_M3]);
    // story_01 requires c3, which only appears in story_02.
    blueprint.story_sequence[0].required_knowledge = ["c3"];
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain(
        "REQUIRED_KNOWLEDGE_ORDER"
      );
    }
  });

  it("rejects a story requiring a concept that no story introduces", () => {
    const blueprint = plan([MAT_M1]);
    blueprint.story_sequence[0].required_knowledge = ["c_ghost"];
    const result = validatePlannedCampaign(blueprint, [MAT_M1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain(
        "REQUIRED_KNOWLEDGE_ORDER"
      );
    }
  });

  it("accepts a story requiring a concept from an earlier story", () => {
    const blueprint = plan([MAT_M1, MAT_M2]);
    expect(blueprint.story_sequence[1].required_knowledge).toEqual(["c1"]);
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M2]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate identifiers
// ---------------------------------------------------------------------------

describe("validatePlannedCampaign — duplicate identifiers", () => {
  it("rejects duplicate story IDs", () => {
    const blueprint = plan([MAT_M1, MAT_M3]);
    blueprint.story_sequence[1].story_id = blueprint.story_sequence[0].story_id;
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain("DUPLICATE_STORY_ID");
    }
  });

  it("rejects duplicate character IDs", () => {
    const blueprint = plan([MAT_M1]);
    blueprint.characters.push({ ...blueprint.characters[0] });
    const result = validatePlannedCampaign(blueprint, [MAT_M1]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain(
        "DUPLICATE_CHARACTER_ID"
      );
    }
  });

  it("rejects duplicate outcome IDs across stories", () => {
    const blueprint = plan([MAT_M1, MAT_M3]);
    blueprint.story_sequence[1].outcomes = [
      { ...blueprint.story_sequence[0].outcomes[0] },
    ];
    const result = validatePlannedCampaign(blueprint, [MAT_M1, MAT_M3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain("DUPLICATE_OUTCOME_ID");
    }
  });
});

// ---------------------------------------------------------------------------
// Regression — legacy validator untouched
// ---------------------------------------------------------------------------

describe("regression — legacy validateCampaign behavior", () => {
  it("dummyCampaign still passes legacy validation", () => {
    const result = validateCampaign(dummyCampaign, [dummyMaterial]);
    expect(result.valid).toBe(true);
  });

  it("legacy validator still catches duplicate story IDs", () => {
    const campaign = cloneCampaign();
    campaign.story_sequence.push({ ...campaign.story_sequence[0] });
    const result = validateCampaign(campaign, [dummyMaterial]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((e) => e.code)).toContain("DUPLICATE_STORY_ID");
    }
  });

  it("legacy validator does not enforce one-material-one-story (fixture has 2 stories on one material)", () => {
    const materialIds = dummyCampaign.story_sequence.map((s) => s.material_id);
    expect(new Set(materialIds).size).toBeLessThan(materialIds.length);
    const result = validateCampaign(dummyCampaign, [dummyMaterial]);
    expect(result.valid).toBe(true);
  });
});
