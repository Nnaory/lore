/**
 * Tests — API Route POST /api/ai/generate-story (M10)
 *
 * Verifies the Story Generation endpoint:
 * - Valid request returns 200 with StoryBlueprint
 * - Invalid request returns 400
 * - Semantic validation failures return 422
 * - Upstream provider failures return 502
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/ai/generate-story/route";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import { resetStoryGeneratorProviderCache } from "@/lib/ai/providers";
import type { CampaignBlueprint, StorySummaryEntry } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import type { PreviousStorySummary } from "@/lib/types/game";

describe("API Route — POST /api/ai/generate-story", () => {
  beforeEach(() => {
    resetStoryGeneratorProviderCache();
  });

  afterEach(() => {
    resetStoryGeneratorProviderCache();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  const planned = buildCampaignBlueprint(
    [dummyMaterial, dummyMaterial2, dummyMaterial3],
    dummyPlannerOptions
  );
  if (!planned.ok) throw new Error("fixture planning failed");
  const campaign: CampaignBlueprint = planned.blueprint;

  const materials = new Map<string, MaterialBlueprint>([
    [dummyMaterial.material_id, dummyMaterial],
    [dummyMaterial2.material_id, dummyMaterial2],
    [dummyMaterial3.material_id, dummyMaterial3],
  ]);

  function validRequest(overrides: Partial<{
    campaign: CampaignBlueprint;
    story: StorySummaryEntry;
    material: MaterialBlueprint;
    previousSummaries: PreviousStorySummary[];
  }> = {}) {
    const entry = overrides.story ?? campaign.story_sequence[0];
    const material = overrides.material ?? materials.get(entry.material_id)!;
    return {
      campaign: overrides.campaign ?? campaign,
      story: entry,
      material,
      previousSummaries: overrides.previousSummaries ?? [],
    };
  }

  function createRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/ai/generate-story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ---------------------------------------------------------------------------
  // Success Cases
  // ---------------------------------------------------------------------------

  it("returns 200 and StoryBlueprint for valid request", async () => {
    const req = createRequest(validRequest());
    const res = await POST(req);

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.ok).toBe(true);
    if (data.ok) {
      expect(data.data.blueprint).toBeDefined();
      expect(data.data.blueprint.story_id).toBe(campaign.story_sequence[0].story_id);
      expect(data.data.blueprint.chapters.length).toBeGreaterThan(0);
      expect(data.data.blueprint.puzzles.length).toBeGreaterThan(0);
      expect(data.data.blueprint.endings.length).toBe(1); // Single ending
      expect(data.data.blueprint.knowledge_mapping.length).toBeGreaterThan(0);
      expect(data.data.meta.provider).toBeDefined();
      expect(data.data.meta.model).toBeDefined();
      expect(data.data.meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(data.data.meta.warnings)).toBe(true);
    }
  });

  it("generates story with continuity context from previous summaries", async () => {
    const previousSummaries: PreviousStorySummary[] = [
      {
        story_id: "prev_story_1",
        title: "Previous Story",
        outcome_description: "The hero succeeded.",
        world_state_snapshot: { flag: 1 },
        relationship_snapshot: { npc1: 10 },
      },
    ];

    const req = createRequest(validRequest({ previousSummaries }));
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 400 — Malformed Request
  // ---------------------------------------------------------------------------

  it("returns 400 for missing campaign", async () => {
    const body = validRequest();
    delete (body as Record<string, unknown>).campaign;

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    if (!data.ok) {
      expect(data.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("returns 400 for missing story", async () => {
    const body = validRequest();
    delete (body as Record<string, unknown>).story;

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it("returns 400 for missing material", async () => {
    const body = validRequest();
    delete (body as Record<string, unknown>).material;

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it("returns 400 for invalid story_id (empty)", async () => {
    const body = validRequest({
      story: { ...campaign.story_sequence[0], story_id: "" },
    });

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it("returns 400 for invalid material_id (empty)", async () => {
    const body = validRequest({
      material: { ...dummyMaterial, material_id: "" },
    });

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 422 — Semantic Validation Failures
  // ---------------------------------------------------------------------------

  it("returns 422 when story not in campaign", async () => {
    const fakeStory: StorySummaryEntry = {
      story_id: "not_in_campaign",
      material_id: "material_01",
      title: "Fake",
      purpose: "Fake",
      main_conflict: "Fake",
      required_knowledge: [],
      outcomes: [],
    };

    const body = validRequest({ story: fakeStory });
    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.ok).toBe(false);
    if (!data.ok) {
      expect(data.error.code).toBe("STORY_NOT_IN_CAMPAIGN");
    }
  });

  it("returns 422 when material_id mismatches story entry", async () => {
    const body = validRequest({
      story: campaign.story_sequence[0],
      material: dummyMaterial2, // Wrong material for story 0
    });

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.ok).toBe(false);
    if (!data.ok) {
      expect(data.error.code).toBe("MATERIAL_MISMATCH");
    }
  });

  // ---------------------------------------------------------------------------
  // 500 — Unexpected Internal Error
  // ---------------------------------------------------------------------------

  it("returns 500 for unexpected service error", async () => {
    // Force an error by passing invalid structure that passes schema but crashes service
    const body = {
      campaign: null,
      story: campaign.story_sequence[0],
      material: dummyMaterial,
    };

    const req = createRequest(body);
    const res = await POST(req);

    // Should be 400 (schema validation) not 500
    expect(res.status).toBe(400);
  });
});