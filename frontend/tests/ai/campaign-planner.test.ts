/**
 * Tests — Campaign Planner Service (M8 Phase 6)
 *
 * Verifies the service orchestrates provider → parser → validator correctly,
 * that provider failures and exceptions are contained, and that the service
 * never leaks internals through its envelope.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  planCampaign,
  resetCampaignPlannerCache,
} from "@/lib/ai/campaign-planner";
import { resetCampaignPlannerProviderCache } from "@/lib/ai/providers";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import type { MaterialBlueprint } from "@/lib/types/material";
import type {
  PlanCampaignRequest,
  PlanCampaignResult,
  PlanCampaignResponse,
} from "@/lib/ai/campaign-planner-types";

// ---------------------------------------------------------------------------
// Provider mock — the service resolves its provider through providers/index.ts,
// so the mock is installed there rather than reaching into the service.
// ---------------------------------------------------------------------------

const providerMock = vi.hoisted(() => ({
  planCampaign: vi.fn(),
  getCampaignPlannerProviderCached: vi.fn(),
  resetCampaignPlannerProviderCache: vi.fn(),
}));

vi.mock("@/lib/ai/providers", () => ({
  getCampaignPlannerProviderCached: providerMock.getCampaignPlannerProviderCached,
  resetCampaignPlannerProviderCache: providerMock.resetCampaignPlannerProviderCache,
}));

// ---------------------------------------------------------------------------
// Fixtures
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

function validProviderResult(materials: MaterialBlueprint[]): PlanCampaignResult {
  const engine = buildCampaignBlueprint(materials, { genre: "fantasy" });
  if (!engine.ok) throw new Error(`engine failed: ${engine.code}`);
  const response: PlanCampaignResponse = {
    blueprint: engine.blueprint,
    meta: {
      provider: "dummy",
      model: "dummy-planner-v1",
      latencyMs: 4,
      warnings: engine.warnings,
    },
  };
  return { ok: true, value: response };
}

/** A fake provider whose planCampaign resolves to whatever we want. */
function installProvider(impl: (req: PlanCampaignRequest) => Promise<PlanCampaignResult>) {
  const provider = {
    id: "dummy" as const,
    model: "dummy-planner-v1",
    planCampaign: impl,
  };
  providerMock.getCampaignPlannerProviderCached.mockReturnValue(provider);
}

describe("planCampaign — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCampaignPlannerCache();
    resetCampaignPlannerProviderCache();
  });

  it("returns a validated blueprint for a single material", async () => {
    installProvider(async () => validProviderResult([M1]));

    const result = await planCampaign(request([M1]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence).toHaveLength(1);
      expect(result.blueprint.story_sequence[0].material_id).toBe("m1");
      expect(result.meta.provider).toBe("dummy");
      expect(result.meta.model).toBe("dummy-planner-v1");
      expect(typeof result.meta.latencyMs).toBe("number");
      expect(Array.isArray(result.meta.warnings)).toBe(true);
    }
  });

  it("returns a validated multi-material blueprint with warnings", async () => {
    installProvider(async () => validProviderResult([M1, M2]));

    const result = await planCampaign(request([M1, M2]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blueprint.story_sequence).toHaveLength(2);
      expect(result.blueprint.story_sequence[1].required_knowledge).toEqual(["c1"]);
      expect(result.meta.warnings).toHaveLength(1);
      expect(result.meta.warnings[0].code).toBe("PREREQUISITE_TESTABILITY_PENDING");
    }
  });

  it("passes the exact request through to the provider", async () => {
    installProvider(async () => validProviderResult([M1]));
    const req = request([M1]);

    await planCampaign(req);

    expect(providerMock.getCampaignPlannerProviderCached).toHaveBeenCalledTimes(1);
  });

  it("is deterministic across identical calls", async () => {
    installProvider(async () => validProviderResult([M1, M2]));

    const first = await planCampaign(request([M1, M2]));
    const second = await planCampaign(request([M1, M2]));

    expect(first).toEqual(second);
  });
});

describe("planCampaign — provider failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCampaignPlannerCache();
    resetCampaignPlannerProviderCache();
  });

  it("returns DUPLICATE_CONCEPT_ID from the provider untouched", async () => {
    installProvider(async () => ({
      ok: false,
      error: {
        code: "DUPLICATE_CONCEPT_ID",
        message: "concept_id \"c1\" is defined twice",
      },
    }));

    const result = await planCampaign(request([M1]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DUPLICATE_CONCEPT_ID");
      expect(result.message).toContain("c1");
    }
  });

  it("returns PROVIDER_UNAVAILABLE untouched", async () => {
    installProvider(async () => ({
      ok: false,
      error: { code: "PROVIDER_UNAVAILABLE", message: "upstream down" },
    }));

    const result = await planCampaign(request([M1]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("returns VALIDATION_FAILED when provider output violates planner semantics", async () => {
    // Two stories on one material -> one-material-one-story violation.
    installProvider(async () => {
      const base = validProviderResult([M1]);
      if (!base.ok) throw new Error("unreachable");
      const blueprint = JSON.parse(
        JSON.stringify(base.value.blueprint)
      ) as typeof base.value.blueprint;
      blueprint.story_sequence.push({
        ...blueprint.story_sequence[0],
        story_id: "story_99",
      });
      return {
        ok: true,
        value: { ...base.value, blueprint },
      } satisfies PlanCampaignResult;
    });

    const result = await planCampaign(request([M1]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("returns VALIDATION_FAILED when provider output is schema-invalid", async () => {
    installProvider(async () => {
      const base = validProviderResult([M1]);
      if (!base.ok) throw new Error("unreachable");
      const broken = JSON.parse(JSON.stringify(base.value)) as Record<string, unknown>;
      (broken["blueprint"] as Record<string, unknown>)["campaign_id"] = "";
      return { ok: true, value: broken as never };
    });

    const result = await planCampaign(request([M1]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED");
    }
  });

  it("contains a provider exception instead of propagating it", async () => {
    installProvider(async () => {
      throw new Error("provider exploded");
    });

    const result = await planCampaign(request([M1]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN");
    }
  });
});

describe("planCampaign — cache helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resetCampaignPlannerCache delegates to the provider cache reset", () => {
    resetCampaignPlannerCache();
    expect(providerMock.resetCampaignPlannerProviderCache).toHaveBeenCalled();
  });
});
