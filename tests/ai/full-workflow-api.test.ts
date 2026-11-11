/**
 * Tests — API Route POST /api/ai/full-workflow (M10)
 *
 * Verifies the end-to-end campaign generation endpoint:
 * - Valid request returns 200 with campaign + stories
 * - Invalid request returns 400
 * - Semantic validation failures return 422
 * - Determinism under dummy provider
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/ai/full-workflow/route";
import {
  dummyMaterial,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import { resetProviderCache } from "@/lib/ai/providers";
import { resetCampaignPlannerCache } from "@/lib/ai/campaign-planner";
import { resetStoryGeneratorProviderCache } from "@/lib/ai/providers";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import { validateCampaign } from "@/lib/validation/campaign-validator";

describe("API Route — POST /api/ai/full-workflow", () => {
  beforeEach(() => {
    resetProviderCache();
    resetCampaignPlannerCache();
    resetStoryGeneratorProviderCache();
  });

  afterEach(() => {
    resetProviderCache();
    resetCampaignPlannerCache();
    resetStoryGeneratorProviderCache();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  // Use content that the dummy provider recognizes (linear algebra keywords)
  // so all three materials produce distinct blueprints
  const linearAlgebraContent = [
    "Linear combinations are fundamental to linear algebra. A linear combination of vectors v1, v2 is c1*v1 + c2*v2. Vector span is the set of all linear combinations.",
    "Vector spaces and basis vectors. A basis is a set of linearly independent vectors that span the space. Linear independence means no vector is a linear combination of the others.",
    "Matrix transformations and eigenvalues. Matrices act on vectors as linear transformations. Eigenvalues and eigenvectors reveal the structure of a linear transformation.",
  ];

  const validRequest = {
    materials: linearAlgebraContent.map((content) => ({ material: content })),
    campaignOptions: dummyPlannerOptions,
    storyOptions: {},
  };

  function createRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/ai/full-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ---------------------------------------------------------------------------
  // Success Cases
  // ---------------------------------------------------------------------------

  it("returns 200 with campaign and all stories for valid request", async () => {
    const req = createRequest(validRequest);
    const res = await POST(req);

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.ok).toBe(true);

    if (data.ok) {
      // Campaign structure
      expect(data.data.campaign).toBeDefined();
      expect(data.data.campaign.campaign_id).toBeDefined();
      expect(data.data.campaign.title).toBeDefined();
      expect(data.data.campaign.story_sequence).toHaveLength(3);
      expect(data.data.campaign.characters.length).toBeGreaterThan(0);

      // Stories structure
      expect(data.data.stories).toBeDefined();
      expect(Object.keys(data.data.stories)).toHaveLength(3);

      for (const story of Object.values(data.data.stories) as StoryBlueprint[]) {
        expect(story.story_id).toBeDefined();
        expect(story.chapters.length).toBeGreaterThan(0);
        expect(story.puzzles.length).toBeGreaterThan(0);
        expect(story.endings.length).toBe(1); // Single ending enforced
        expect(story.knowledge_mapping.length).toBeGreaterThan(0);
      }

      // Material results
      expect(data.data.materialResults).toHaveLength(3);
      for (const mr of data.data.materialResults) {
        expect(mr.ok).toBe(true);
        expect(mr.blueprint).toBeDefined();
      }

      // Meta
      expect(data.data.meta.provider).toBeDefined();
      expect(data.data.meta.model).toBeDefined();
      expect(data.data.meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(data.data.meta.warnings)).toBe(true);
    }
  });

  it("generated campaign passes game-engine validation", async () => {
    const req = createRequest(validRequest);
    const res = await POST(req);
    const data = await res.json();

    expect(data.ok).toBe(true);

    if (data.ok) {
      // Use materials from the response, not dummy fixtures
      type MaterialResult = { ok: boolean; blueprint?: unknown };
      const materials = data.data.materialResults
        .filter((mr: MaterialResult): mr is MaterialResult & { ok: true; blueprint: unknown } =>
          mr.ok && mr.blueprint != null
        )
        .map((mr: MaterialResult & { ok: true; blueprint: unknown }) => mr.blueprint);
      const validation = validateCampaign(data.data.campaign, materials);
      expect(validation.valid).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Determinism
  // ---------------------------------------------------------------------------

  it("is deterministic under dummy provider (same input = same output)", async () => {
    const req1 = createRequest(validRequest);
    const res1 = await POST(req1);
    const data1 = await res1.json();

    // Reset caches and run again
    resetProviderCache();
    resetCampaignPlannerCache();
    resetStoryGeneratorProviderCache();

    const req2 = createRequest(validRequest);
    const res2 = await POST(req2);
    const data2 = await res2.json();

    expect(data1.ok).toBe(true);
    expect(data2.ok).toBe(true);

    if (data1.ok && data2.ok) {
      // Campaign IDs should match
      expect(data1.data.campaign.campaign_id).toBe(data2.data.campaign.campaign_id);
      expect(data1.data.campaign.title).toBe(data2.data.campaign.title);

      // Story IDs should match
      for (const storyId of Object.keys(data1.data.stories)) {
        const s1 = data1.data.stories[storyId];
        const s2 = data2.data.stories[storyId];
        expect(s1.story_id).toBe(s2.story_id);
        expect(s1.title).toBe(s2.title);
        expect(s1.chapters.length).toBe(s2.chapters.length);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 400 — Malformed Request
  // ---------------------------------------------------------------------------

  it("returns 400 for missing materials array", async () => {
    const body = { ...validRequest };
    delete (body as Record<string, unknown>).materials;

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
    if (!data.ok) {
      expect(data.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("returns 400 for empty materials array", async () => {
    const body = { ...validRequest, materials: [] };

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it("returns 400 for missing campaignOptions", async () => {
    const body = { ...validRequest };
    delete (body as Record<string, unknown>).campaignOptions;

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it("returns 400 for invalid material (too short)", async () => {
    const body = {
      ...validRequest,
      materials: [{ material: "Short" }],
    };

    const req = createRequest(body);
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Error Response Structure
  // ---------------------------------------------------------------------------

  it("error responses follow standard envelope", async () => {
    const req = createRequest({ materials: [] });
    const res = await POST(req);
    const data = await res.json();

    expect(data.ok).toBe(false);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBeDefined();
    expect(data.error.message).toBeDefined();
  });
});