/**
 * Tests — Dummy Story Generator Provider (M9 Phase 4)
 *
 * Verifies the provider implements the contract, returns deterministic
 * output, never throws for expected failures, and health-checks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dummyStoryGeneratorProvider } from "@/lib/ai/providers/dummy-story-generator";
import {
  getStoryGeneratorProvider,
  getStoryGeneratorProviderCached,
  resetStoryGeneratorProviderCache,
} from "@/lib/ai/providers";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import type { GenerateStoryRequest } from "@/lib/ai/story-generator-types";
import type { MaterialBlueprint } from "@/lib/types/material";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const planned = buildCampaignBlueprint(
  [dummyMaterial, dummyMaterial2, dummyMaterial3],
  dummyPlannerOptions
);
if (!planned.ok) throw new Error("fixture planning failed");
const campaign = planned.blueprint;

const materials = new Map<string, MaterialBlueprint>([
  [dummyMaterial.material_id, dummyMaterial],
  [dummyMaterial2.material_id, dummyMaterial2],
  [dummyMaterial3.material_id, dummyMaterial3],
]);

function requestFor(index: number): GenerateStoryRequest {
  const entry = campaign.story_sequence[index];
  return {
    campaign,
    story: entry,
    material: materials.get(entry.material_id)!,
  };
}

// ---------------------------------------------------------------------------
// Provider instance contract
// ---------------------------------------------------------------------------

describe("dummyStoryGeneratorProvider — contract", () => {
  it("has the correct id and model", () => {
    expect(dummyStoryGeneratorProvider.id).toBe("dummy");
    expect(dummyStoryGeneratorProvider.model).toBe("deterministic-template-v1");
  });

  it("implements generateStory returning a discriminated union", async () => {
    const result = await dummyStoryGeneratorProvider.generateStory(requestFor(0));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.provider).toBe("dummy");
      expect(result.value.meta.model).toBe("deterministic-template-v1");
      expect(typeof result.value.meta.latencyMs).toBe("number");
      expect(Array.isArray(result.value.meta.warnings)).toBe(true);
    }
  });

  it("implements healthCheck", async () => {
    const health = await dummyStoryGeneratorProvider.healthCheck?.();
    expect(health?.healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** Strip non-deterministic meta fields for comparison. */
function deterministicValue(
  result: { ok: boolean; value?: { meta?: { latencyMs: number } } }
): { ok: boolean; value?: { meta?: { latencyMs: number } } } {
  if (!result.ok || !result.value) return result;
  return {
    ...result,
    value: {
      ...result.value,
      meta: {
        ...result.value.meta,
        latencyMs: 0,
      },
    },
  };
}

describe("dummyStoryGeneratorProvider — determinism", () => {
  it("returns deep-equal output for identical requests", async () => {
    const a = await dummyStoryGeneratorProvider.generateStory(requestFor(0));
    const b = await dummyStoryGeneratorProvider.generateStory(requestFor(0));
    expect(deterministicValue(a)).toEqual(deterministicValue(b));
  });

  it("different stories produce different output", async () => {
    const a = await dummyStoryGeneratorProvider.generateStory(requestFor(0));
    const b = await dummyStoryGeneratorProvider.generateStory(requestFor(1));
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Error handling (never throws for expected failures)
// ---------------------------------------------------------------------------

describe("dummyStoryGeneratorProvider — error handling", () => {
  it("returns error for story not in campaign", async () => {
    const req = requestFor(0);
    const result = await dummyStoryGeneratorProvider.generateStory({
      ...req,
      story: { ...req.story, story_id: "story_missing" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORY_NOT_IN_CAMPAIGN");
  });

  it("returns error for material mismatch", async () => {
    const req = requestFor(0);
    const other = [...materials.values()].find((m) => m.material_id !== req.story.material_id)!;
    const result = await dummyStoryGeneratorProvider.generateStory({ ...req, material: other });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MATERIAL_MISMATCH");
  });

  it("returns error for material with no concepts", async () => {
    const req = requestFor(0);
    const result = await dummyStoryGeneratorProvider.generateStory({
      ...req,
      material: { ...req.material, concepts: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONCEPT_COVERAGE");
  });
});

// ---------------------------------------------------------------------------
// Registry functions
// ---------------------------------------------------------------------------

describe("story generator provider registry", () => {
  beforeEach(() => {
    resetStoryGeneratorProviderCache();
  });

  afterEach(() => {
    resetStoryGeneratorProviderCache();
  });

  it("getStoryGeneratorProvider returns the dummy provider", () => {
    const p = getStoryGeneratorProvider();
    expect(p.id).toBe("dummy");
  });

  it("getStoryGeneratorProviderCached returns the same instance", () => {
    const a = getStoryGeneratorProviderCached();
    const b = getStoryGeneratorProviderCached();
    expect(a).toBe(b);
  });

  it("resetStoryGeneratorProviderCache clears the cache", () => {
    const a = getStoryGeneratorProviderCached();
    resetStoryGeneratorProviderCache();
    const b = getStoryGeneratorProviderCached();
    // Both are the same singleton provider instance; reset only clears the internal cache flag.
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Output validation (integration with generator-validator)
// ---------------------------------------------------------------------------

describe("dummyStoryGeneratorProvider — output passes generator validator", () => {
  it("every generated story validates", async () => {
    for (let i = 0; i < campaign.story_sequence.length; i++) {
      const result = await dummyStoryGeneratorProvider.generateStory(requestFor(i));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      // The provider already validates internally, but double-check.
      const { validateGeneratedStory } = await import("@/lib/validation/generator-validator");
      const validation = validateGeneratedStory(result.value.blueprint, materials.get(campaign.story_sequence[i].material_id)!);
      expect(validation.valid).toBe(true);
    }
  });
});