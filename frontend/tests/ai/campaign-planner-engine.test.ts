/**
 * Tests — Campaign Planner Engine (M8 Phase 2)
 *
 * Pure deterministic algorithm: materials + options → CampaignBlueprint.
 * No network, no React, no wall-clock.
 */

import { describe, it, expect } from "vitest";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { CampaignPlannerOptions } from "@/lib/ai/campaign-planner-types";

// ---------------------------------------------------------------------------
// Fixtures (local, deterministic)
// ---------------------------------------------------------------------------

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
      principles: [`Principle of ${c.id}`],
      methods: [`Method of ${c.id}`],
      prerequisites: c.prerequisites ?? [],
      misconceptions: [],
      source_evidence: [`Evidence of ${c.id}`],
    })),
    scope_limitations: [],
  };
}

const OPTIONS: CampaignPlannerOptions = { genre: "fantasy" };

// ---------------------------------------------------------------------------
// Single material
// ---------------------------------------------------------------------------

describe("buildCampaignBlueprint — single material", () => {
  const material = makeMaterial("m1", [{ id: "c1" }]);

  it("produces exactly one story", () => {
    const result = buildCampaignBlueprint([material], OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence).toHaveLength(1);
    }
  });

  it("produces no cross-material required knowledge", () => {
    const result = buildCampaignBlueprint([material], OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence[0].required_knowledge).toEqual([]);
    }
  });

  it("emits no warnings for a trivial material", () => {
    const result = buildCampaignBlueprint([material], OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
    }
  });

  it("maps material fields into story fields", () => {
    const result = buildCampaignBlueprint([material], OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const story = result.blueprint.story_sequence[0];
      expect(story.story_id).toBe("story_01");
      expect(story.material_id).toBe("m1");
      expect(story.title).toBe("Title of m1");
      expect(story.purpose).toContain("Objective of m1");
      expect(story.outcomes).toHaveLength(1);
      expect(story.outcomes[0].world_state_changes.stability).toBeGreaterThan(0);
    }
  });

  it("generates stable character IDs", () => {
    const result = buildCampaignBlueprint([material], OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.blueprint.characters.map((c) => c.character_id);
      expect(ids).toEqual(["char_01", "char_02"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-material ordering
// ---------------------------------------------------------------------------

describe("buildCampaignBlueprint — multi-material ordering", () => {
  it("preserves input order when no cross-material prerequisites exist", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m2", [{ id: "c2" }]),
      makeMaterial("m3", [{ id: "c3" }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence.map((s) => s.material_id)).toEqual([
        "m1",
        "m2",
        "m3",
      ]);
    }
  });

  it("topologically sorts when prereqs imply an order", () => {
    // Input order deliberately reversed: m2 depends on m1's concept.
    const materials = [
      makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
      makeMaterial("m1", [{ id: "c1" }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence.map((s) => s.material_id)).toEqual([
        "m1",
        "m2",
      ]);
    }
  });

  it("derives required_knowledge only from earlier materials", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence[0].required_knowledge).toEqual([]);
      expect(result.blueprint.story_sequence[1].required_knowledge).toEqual([
        "c1",
      ]);
    }
  });

  it("never puts current-material or future-material concepts in required_knowledge", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }, { id: "c2", prerequisites: ["c1"] }]),
      makeMaterial("m2", [{ id: "c3", prerequisites: ["c2"] }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence[0].required_knowledge).toEqual([]);
      expect(result.blueprint.story_sequence[1].required_knowledge).toEqual([
        "c2",
      ]);
    }
  });

  it("handles a three-material chain", () => {
    const materials = [
      makeMaterial("m3", [{ id: "c3", prerequisites: ["c2"] }]),
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence.map((s) => s.material_id)).toEqual([
        "m1",
        "m2",
        "m3",
      ]);
      expect(result.blueprint.story_sequence[2].required_knowledge).toEqual([
        "c2",
      ]);
    }
  });

  it("deduplicates required_knowledge entries", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m2", [
        { id: "c2", prerequisites: ["c1"] },
        { id: "c3", prerequisites: ["c1"] },
      ]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence[1].required_knowledge).toEqual([
        "c1",
      ]);
    }
  });

  it("every material appears exactly once", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
      makeMaterial("m3", [{ id: "c3" }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const materialIds = result.blueprint.story_sequence.map((s) => s.material_id);
      expect(new Set(materialIds).size).toBe(materialIds.length);
      expect(materialIds.sort()).toEqual(["m1", "m2", "m3"]);
    }
  });

  it("emits PREREQUISITE_TESTABILITY_PENDING warnings for derived prerequisites", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0].code).toBe("PREREQUISITE_TESTABILITY_PENDING");
      expect(result.warnings[0].message).toContain("c1");
    }
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("buildCampaignBlueprint — error cases", () => {
  it("rejects duplicate material IDs", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m1", [{ id: "c2" }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DUPLICATE_MATERIAL_ID");
    }
  });

  it("rejects globally duplicated concept IDs", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1" }]),
      makeMaterial("m2", [{ id: "c1" }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DUPLICATE_CONCEPT_ID");
      expect(result.message).toContain("c1");
    }
  });

  it("rejects unresolved prerequisite references", () => {
    const materials = [makeMaterial("m1", [{ id: "c1", prerequisites: ["ghost"] }])];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PREREQUISITE_REF");
      expect(result.message).toContain("ghost");
    }
  });

  it("detects a cross-material prerequisite cycle", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1", prerequisites: ["c2"] }]),
      makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PREREQUISITE_CYCLE");
    }
  });

  it("detects a three-material cycle", () => {
    const materials = [
      makeMaterial("m1", [{ id: "c1", prerequisites: ["c3"] }]),
      makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
      makeMaterial("m3", [{ id: "c3", prerequisites: ["c2"] }]),
    ];
    const result = buildCampaignBlueprint(materials, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PREREQUISITE_CYCLE");
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and purity
// ---------------------------------------------------------------------------

describe("buildCampaignBlueprint — determinism and purity", () => {
  const materials = [
    makeMaterial("m1", [{ id: "c1" }]),
    makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
  ];

  it("produces deep-equal output for identical input", () => {
    const a = buildCampaignBlueprint(materials, OPTIONS);
    const b = buildCampaignBlueprint(materials, OPTIONS);
    expect(a).toEqual(b);
  });

  it("does not mutate input materials", () => {
    const snapshot = JSON.parse(JSON.stringify(materials));
    buildCampaignBlueprint(materials, OPTIONS);
    expect(materials).toEqual(snapshot);
  });

  it("does not mutate input options", () => {
    const options = { genre: "fantasy" as const, tone: "mysterious" };
    const snapshot = JSON.parse(JSON.stringify(options));
    buildCampaignBlueprint(materials, options);
    expect(options).toEqual(snapshot);
  });

  it("respects campaignId override", () => {
    const result = buildCampaignBlueprint(materials, {
      genre: "fantasy",
      campaignId: "campaign_custom",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.campaign_id).toBe("campaign_custom");
    }
  });

  it("respects tone and setting overrides", () => {
    const result = buildCampaignBlueprint(materials, {
      genre: "fantasy",
      tone: "grim",
      setting: "a frozen keep",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.tone).toBe("grim");
      expect(result.blueprint.setting).toBe("a frozen keep");
    }
  });

  it("works for every supported genre", () => {
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
      const result = buildCampaignBlueprint(materials, { genre });
      expect(result.ok, `genre ${genre} should succeed`).toBe(true);
      if (result.ok) {
        expect(result.blueprint.genre).toBe(genre);
        expect(result.blueprint.characters.length).toBeGreaterThan(0);
      }
    }
  });
});
