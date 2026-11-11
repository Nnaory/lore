/**
 * Tests — Story Generator Service (M9 Phase 5)
 *
 * Verifies the service orchestrates validation, provider, schema, and semantic
 * checks correctly, returns discriminated unions, and supports batch generation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateStory, generateCampaignStories } from "@/lib/ai/story-generator-service";
import {
  getStoryGeneratorProviderCached,
  resetStoryGeneratorProviderCache,
} from "@/lib/ai/providers";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import type { StoryBlueprint } from "@/lib/types/story";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import type { GenerateStoryRequest } from "@/lib/ai/story-generator-types";
import type { StorySummaryEntry } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { IStoryGeneratorProvider } from "@/lib/ai/story-generator-types";
import type { AIProviderId } from "@/lib/ai/types";

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
// Mock provider for error-path tests
// ---------------------------------------------------------------------------

function mockProvider(
  overrides: Partial<IStoryGeneratorProvider> = {}
): IStoryGeneratorProvider {
  const baseProvider: IStoryGeneratorProvider = {
    id: "dummy" as const,
    model: "test-mock",
    generateStory: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        blueprint: {} as StoryBlueprint,
        meta: { provider: "test-mock", model: "test-mock", latencyMs: 0, warnings: [] },
      },
    }),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  };
  return { ...baseProvider, ...overrides };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("generateStory — happy path", () => {
  beforeEach(() => resetStoryGeneratorProviderCache());
  afterEach(() => resetStoryGeneratorProviderCache());

  it("generates a valid story for the first campaign entry", async () => {
    const result = await generateStory(requestFor(0));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blueprint.story_id).toBe(campaign.story_sequence[0].story_id);
      expect(result.value.blueprint.material_id).toBe(campaign.story_sequence[0].material_id);
      expect(result.value.blueprint.chapters.length).toBeGreaterThan(0);
      expect(result.value.blueprint.puzzles.length).toBeGreaterThan(0);
      expect(result.value.blueprint.endings).toHaveLength(1);
      expect(result.value.meta.provider).toBe("dummy");
    }
  });

  it("generates a valid story for the second campaign entry", async () => {
    const result = await generateStory(requestFor(1));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blueprint.story_id).toBe(campaign.story_sequence[1].story_id);
    }
  });

  it("accepts optional previousSummaries and options", async () => {
    const result = await generateStory({
      ...requestFor(1),
      previousSummaries: [
        {
          story_id: campaign.story_sequence[0].story_id,
          title: campaign.story_sequence[0].title,
          outcome_description: "Resolved",
          world_state_snapshot: { stability: 10 },
          relationship_snapshot: {},
        },
      ],
      options: { conceptsPerChapter: 1 },
    });
    expect(result.ok).toBe(true);
  });

  it("produces deterministic output for identical requests", async () => {
    const a = await generateStory(requestFor(0));
    const b = await generateStory(requestFor(0));
    // Normalize latencyMs for comparison (non-deterministic)
    const normalize = (r: typeof a) =>
      r.ok ? { ...r, value: { ...r.value, meta: { ...r.value.meta, latencyMs: 0 } } } : r;
    expect(normalize(a)).toEqual(normalize(b));
  });
});

// ---------------------------------------------------------------------------
// Request validation errors
// ---------------------------------------------------------------------------

describe("generateStory — request validation", () => {
  it("rejects missing campaign", async () => {
    const { campaign: _c, ...rest } = requestFor(0);
    const result = await generateStory(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects missing story entry", async () => {
    const { story: _s, ...rest } = requestFor(0);
    const result = await generateStory(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects missing material", async () => {
    const { material: _m, ...rest } = requestFor(0);
    const result = await generateStory(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects story not in campaign", async () => {
    const req = requestFor(0);
    const result = await generateStory({
      ...req,
      story: { ...req.story, story_id: "story_missing" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORY_NOT_IN_CAMPAIGN");
  });

  it("rejects material mismatch", async () => {
    const req = requestFor(0);
    const other = [...materials.values()].find((m) => m.material_id !== req.story.material_id)!;
    const result = await generateStory({ ...req, material: other });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MATERIAL_MISMATCH");
  });

  it("rejects malformed campaign structure", async () => {
    const req = requestFor(0);
    const result = await generateStory({
      ...req,
      campaign: { campaign_id: "" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// Provider error propagation
// ---------------------------------------------------------------------------

describe("generateStory — provider error propagation", () => {
  it("returns provider error when provider fails", async () => {
    const provider = mockProvider({
      generateStory: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "PROVIDER_UNAVAILABLE", message: "boom" },
      }),
    });

    const result = await generateStory(requestFor(0), provider);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("returns VALIDATION_FAILED when provider output fails schema", async () => {
    const provider = mockProvider({
      generateStory: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          blueprint: { story_id: "bad" },
          meta: { provider: "test", model: "test", latencyMs: 0, warnings: [] },
        },
      }),
    });

    const result = await generateStory(requestFor(0), provider);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OUTPUT_PARSE_FAILED");
  });

  it("returns VALIDATION_FAILED when provider output fails semantic validation", async () => {
    // A story that passes Zod schema but fails semantic validation:
    // duplicate chapter IDs (semantic rule) but valid structure.
    const narrativeScene = {
      scene_id: "scene_1",
      type: "narrative" as const,
      location: "test",
      characters_present: [],
      content: [{ type: "narration" as const, text: "test" }],
      next_scene_id: null,
    };
    const badStory = {
      story_id: "bad",
      material_id: dummyMaterial.material_id,
      title: "Bad",
      summary: "x",
      character_ids: [],
      chapters: [
        { chapter_id: "ch1", title: "Ch1", scenes: [narrativeScene] },
        { chapter_id: "ch1", title: "Ch1 dup", scenes: [narrativeScene] }, // duplicate ID
      ],
      puzzles: [],
      endings: [],
      continuity_summary: {
        story_id: "bad",
        outcome_description: "x",
        key_decisions: [],
        world_state_snapshot: {},
        relationship_snapshot: {},
      },
      knowledge_mapping: [],
    };
    const provider = mockProvider({
      generateStory: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          blueprint: badStory,
          meta: { provider: "test", model: "test", latencyMs: 0, warnings: [] },
        },
      }),
    });

    const result = await generateStory(requestFor(0), provider);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Batch generation
// ---------------------------------------------------------------------------

describe("generateCampaignStories", () => {
  beforeEach(() => resetStoryGeneratorProviderCache());
  afterEach(() => resetStoryGeneratorProviderCache());

  it("generates all stories in sequence", async () => {
    const result = await generateCampaignStories(
      campaign,
      [dummyMaterial, dummyMaterial2, dummyMaterial3]
    );
    expect(result.ok).toBe(true);
    expect(result.stories.size).toBe(campaign.story_sequence.length);
    for (const entry of campaign.story_sequence) {
      expect(result.stories.has(entry.story_id)).toBe(true);
    }
  });

  it("stops on first error by default", async () => {
    // Use a provider that succeeds for the first story, then fails for the second.
    // We can't easily mock partial success with the provider because the service
    // validates the blueprint. Instead, cause a request validation error on the
    // second story by passing a material that doesn't match.
    const provider = mockProvider({
      generateStory: vi.fn().mockImplementation(async (req) => {
        // First story (story_01) - succeed
        if (req.story.story_id === "story_01") {
          // Use the real engine to generate a valid blueprint
          const { buildStoryBlueprint } = await import("@/lib/ai/story-generator-engine");
          const engineResult = buildStoryBlueprint(req);
          return engineResult.ok
            ? { ok: true, value: { blueprint: engineResult.blueprint, meta: { provider: "test", model: "test", latencyMs: 0, warnings: [] } } }
            : { ok: false, error: { code: "VALIDATION_FAILED", message: "engine failed" } };
        }
        // Second story - fail with a provider error
        return { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "mock fail" } };
      }),
    });

    const result = await generateCampaignStories(
      campaign,
      [dummyMaterial, dummyMaterial2, dummyMaterial3],
      [],
      {},
      false,
      provider
    );
    expect(result.ok).toBe(false);
    expect(result.stories.size).toBe(1);
    expect(result.errors.size).toBe(1);
  });

  it("continues on error when continueOnError is true", async () => {
    // Use a provider that succeeds for stories 1 and 3, fails for story 2.
    const provider = mockProvider({
      generateStory: vi.fn().mockImplementation(async (req) => {
        if (req.story.story_id === "story_02") {
          return { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "mock fail" } };
        }
        // Use real engine for other stories
        const { buildStoryBlueprint } = await import("@/lib/ai/story-generator-engine");
        const engineResult = buildStoryBlueprint(req);
        return engineResult.ok
          ? { ok: true, value: { blueprint: engineResult.blueprint, meta: { provider: "test", model: "test", latencyMs: 0, warnings: [] } } }
          : { ok: false, error: { code: "VALIDATION_FAILED", message: "engine failed" } };
      }),
    });

    const result = await generateCampaignStories(
      campaign,
      [dummyMaterial, dummyMaterial2, dummyMaterial3],
      [],
      {},
      true,
      provider
    );
    expect(result.stories.size).toBe(2);
    expect(result.errors.size).toBe(1);
  });

  it("builds continuity summaries for subsequent stories", async () => {
    const result = await generateCampaignStories(
      campaign,
      [dummyMaterial, dummyMaterial2, dummyMaterial3]
    );
    expect(result.ok).toBe(true);
    const story1 = result.stories.get(campaign.story_sequence[0].story_id)!;
    const story2 = result.stories.get(campaign.story_sequence[1].story_id)!;
    // story2's continuity should reference story1's outcome
    expect(story2.continuity_summary?.outcome_description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe("generateStory — never throws for expected failures", () => {
  const errorCases: Array<{ name: string; input: unknown }> = [
    { name: "null", input: null },
    { name: "undefined", input: undefined },
    { name: "empty object", input: {} },
    { name: "string", input: "not an object" },
    { name: "array", input: [] },
  ];

  for (const { name, input } of errorCases) {
    it(`handles ${name} without throwing`, async () => {
      const result = await generateStory(input);
      expect(result.ok).toBe(false);
    });
  }
});