/**
 * Tests — Campaign Output Parser (M8 Phase 5)
 *
 * Verifies schema validation, planner semantic validation, error passthrough,
 * warning preservation, and immutability.
 */

import { describe, it, expect } from "vitest";
import {
  parseAndValidateCampaignOutput,
  parseCampaignProviderResult,
  type CampaignParseOutcome,
} from "@/lib/ai/campaign-output-parser";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import type { MaterialBlueprint } from "@/lib/types/material";
import type {
  PlanCampaignResult,
  PlanCampaignResponse,
} from "@/lib/ai/campaign-planner-types";
import type { CampaignBlueprint } from "@/lib/types/campaign";

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

const M1 = makeMaterial("m1", [{ id: "c1" }]);
const M2 = makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]);

function buildValidResponse(materials: MaterialBlueprint[]): PlanCampaignResponse {
  const engine = buildCampaignBlueprint(materials, { genre: "fantasy" });
  if (!engine.ok) throw new Error(`engine failed: ${engine.code}`);
  return {
    blueprint: engine.blueprint,
    meta: {
      provider: "dummy",
      model: "dummy-planner-v1",
      latencyMs: 3,
      warnings: engine.warnings,
    },
  };
}

function cloneBlueprint(bp: CampaignBlueprint): CampaignBlueprint {
  return JSON.parse(JSON.stringify(bp)) as CampaignBlueprint;
}

describe("parseAndValidateCampaignOutput — valid input", () => {
  it("accepts a valid single-material blueprint", () => {
    const result = parseAndValidateCampaignOutput(buildValidResponse([M1]), [M1]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blueprint.story_sequence).toHaveLength(1);
      expect(result.value.meta.provider).toBe("dummy");
    }
  });

  it("accepts a valid multi-material blueprint", () => {
    const result = parseAndValidateCampaignOutput(
      buildValidResponse([M1, M2]),
      [M1, M2]
    );
    expect(result.ok).toBe(true);
  });

  it("preserves provider warnings", () => {
    const response = buildValidResponse([M1, M2]);
    expect(response.meta.warnings.length).toBe(1);
    const result = parseAndValidateCampaignOutput(response, [M1, M2]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.warnings.length).toBe(1);
      expect(result.value.meta.warnings[0].code).toBe(
        "PREREQUISITE_TESTABILITY_PENDING"
      );
    }
  });

  it("does not mutate the provider response", () => {
    const response = buildValidResponse([M1, M2]);
    const snapshot = JSON.parse(JSON.stringify(response));
    parseAndValidateCampaignOutput(response, [M1, M2]);
    expect(response).toEqual(snapshot);
  });
});

describe("parseAndValidateCampaignOutput — schema failures", () => {
  it("rejects a structurally invalid blueprint", () => {
    const response = buildValidResponse([M1]);
    const bad = cloneBlueprint(response.blueprint) as unknown as Record<string, unknown>;
    bad["campaign_id"] = "";
    const result = parseAndValidateCampaignOutput(
      { ...response, blueprint: bad as never },
      [M1]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects an empty story_sequence", () => {
    const response = buildValidResponse([M1]);
    const bad = cloneBlueprint(response.blueprint);
    bad.story_sequence = [];
    const result = parseAndValidateCampaignOutput({ ...response, blueprint: bad }, [M1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects an unknown genre", () => {
    const response = buildValidResponse([M1]);
    const bad = cloneBlueprint(response.blueprint);
    (bad as unknown as Record<string, unknown>)["genre"] = "romance";
    const result = parseAndValidateCampaignOutput({ ...response, blueprint: bad }, [M1]);
    expect(result.ok).toBe(false);
  });
});

describe("parseAndValidateCampaignOutput — planner semantic failures", () => {
  it("rejects output violating one-material-one-story", () => {
    const response = buildValidResponse([M1]);
    const bad = cloneBlueprint(response.blueprint);
    bad.story_sequence.push({ ...bad.story_sequence[0], story_id: "story_99" });
    const result = parseAndValidateCampaignOutput({ ...response, blueprint: bad }, [M1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(result.detail)).toContain("DUPLICATE_MATERIAL_STORY");
    }
  });

  it("rejects output with an out-of-order required_knowledge", () => {
    const response = buildValidResponse([M1, M2]);
    const bad = cloneBlueprint(response.blueprint);
    // story_01 requires c2, which belongs to story_02's material only.
    bad.story_sequence[0].required_knowledge = ["c2"];
    const result = parseAndValidateCampaignOutput({ ...response, blueprint: bad }, [M1, M2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.detail)).toContain("REQUIRED_KNOWLEDGE_ORDER");
    }
  });
});

describe("parseCampaignProviderResult — provider error passthrough", () => {
  it("passes through a provider error unchanged", () => {
    const providerResult: PlanCampaignResult = {
      ok: false,
      error: { code: "PROVIDER_UNAVAILABLE", message: "down" },
    };
    const result = parseCampaignProviderResult(providerResult, [M1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_UNAVAILABLE");
      expect(result.message).toBe("down");
    }
  });

  it("parses a successful provider result", () => {
    const response = buildValidResponse([M1]);
    const providerResult: PlanCampaignResult = { ok: true, value: response };
    const result: CampaignParseOutcome = parseCampaignProviderResult(providerResult, [M1]);
    expect(result.ok).toBe(true);
  });
});
