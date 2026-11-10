/**
 * Tests — Dummy Campaign Planner Provider (M8 Phase 4)
 *
 * Verifies provider contract compliance, determinism, error handling,
 * and registry selection. No network calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DummyCampaignPlannerProvider } from "@/lib/ai/providers/dummy-campaign-planner-provider";
import {
  getCampaignPlannerProvider,
  getCampaignPlannerProviderCached,
  resetCampaignPlannerProviderCache,
  getProvider,
  resetProviderCache,
} from "@/lib/ai/providers";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { PlanCampaignRequest } from "@/lib/ai/campaign-planner-types";

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

function request(materials: MaterialBlueprint[]): PlanCampaignRequest {
  return { materials, options: { genre: "fantasy" } };
}

describe("DummyCampaignPlannerProvider — contract", () => {
  it("has the expected id and model", () => {
    const provider = new DummyCampaignPlannerProvider();
    expect(provider.id).toBe("dummy");
    expect(provider.model).toBe("dummy-planner-v1");
  });

  it("healthCheck reports healthy", async () => {
    const provider = new DummyCampaignPlannerProvider();
    const health = await provider.healthCheck?.();
    expect(health?.healthy).toBe(true);
  });

  it("returns a schema-valid blueprint for a single material", async () => {
    const provider = new DummyCampaignPlannerProvider();
    const result = await provider.planCampaign(request([M1]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blueprint.story_sequence).toHaveLength(1);
      expect(result.value.meta.provider).toBe("dummy");
      expect(result.value.meta.model).toBe("dummy-planner-v1");
      expect(typeof result.value.meta.latencyMs).toBe("number");
      expect(Array.isArray(result.value.meta.warnings)).toBe(true);
    }
  });

  it("includes planning warnings for derived prerequisites", async () => {
    const provider = new DummyCampaignPlannerProvider();
    const result = await provider.planCampaign(request([M1, M2]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.warnings.length).toBe(1);
      expect(result.value.meta.warnings[0].code).toBe(
        "PREREQUISITE_TESTABILITY_PENDING"
      );
    }
  });

  it("is deterministic for identical requests", async () => {
    const provider = new DummyCampaignPlannerProvider();
    const a = await provider.planCampaign(request([M1, M2]));
    const b = await provider.planCampaign(request([M1, M2]));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.blueprint).toEqual(b.value.blueprint);
    }
  });

  it("returns INVALID_REQUEST for empty materials", async () => {
    const provider = new DummyCampaignPlannerProvider();
    const result = await provider.planCampaign(request([]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("returns DUPLICATE_CONCEPT_ID from the engine", async () => {
    const provider = new DummyCampaignPlannerProvider();
    const result = await provider.planCampaign(
      request([makeMaterial("m1", [{ id: "c1" }]), makeMaterial("m2", [{ id: "c1" }])])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DUPLICATE_CONCEPT_ID");
    }
  });

  it("returns PREREQUISITE_CYCLE from the engine", async () => {
    const provider = new DummyCampaignPlannerProvider();
    const result = await provider.planCampaign(
      request([
        makeMaterial("m1", [{ id: "c1", prerequisites: ["c2"] }]),
        makeMaterial("m2", [{ id: "c2", prerequisites: ["c1"] }]),
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PREREQUISITE_CYCLE");
    }
  });
});

describe("Campaign Planner provider registry", () => {
  const originalEnv = process.env.AI_PROVIDER;

  beforeEach(() => {
    resetCampaignPlannerProviderCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.AI_PROVIDER = originalEnv;
    resetCampaignPlannerProviderCache();
  });

  it("defaults to dummy when AI_PROVIDER is unset", () => {
    delete process.env.AI_PROVIDER;
    const provider = getCampaignPlannerProvider();
    expect(provider.id).toBe("dummy");
    expect(provider.model).toBe("dummy-planner-v1");
  });

  it("selects dummy when AI_PROVIDER=dummy", () => {
    process.env.AI_PROVIDER = "dummy";
    const provider = getCampaignPlannerProvider();
    expect(provider.id).toBe("dummy");
  });

  it("falls back to dummy for an unknown provider with a warning", () => {
    process.env.AI_PROVIDER = "not-a-provider";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = getCampaignPlannerProvider();
    expect(provider.id).toBe("dummy");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("caches the resolved provider", () => {
    delete process.env.AI_PROVIDER;
    const first = getCampaignPlannerProviderCached();
    const second = getCampaignPlannerProviderCached();
    expect(first).toBe(second);
  });

  it("resetCampaignPlannerProviderCache clears the cache", () => {
    const first = getCampaignPlannerProviderCached();
    resetCampaignPlannerProviderCache();
    const second = getCampaignPlannerProviderCached();
    expect(first).not.toBe(second);
  });

  it("does not disturb the Material Intelligence provider registry", () => {
    delete process.env.AI_PROVIDER;
    resetProviderCache();
    const materialProvider = getProvider();
    expect(materialProvider.id).toBe("dummy");
    expect(materialProvider.model).toBe("dummy-v1");
    resetProviderCache();
  });
});
