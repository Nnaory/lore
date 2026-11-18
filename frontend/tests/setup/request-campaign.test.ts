/**
 * Tests — requestCampaign (browser call to /api/ai/full-workflow)
 *
 * Includes a round trip through the real route handler with the dummy
 * provider, so the client and server contracts are checked together.
 */

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { requestCampaign, BUILD_MESSAGES } from "@/lib/setup/request-campaign";
import { POST } from "@/app/api/ai/full-workflow/route";
import type { FullWorkflowRequestBody } from "@/lib/ai/full-workflow-schema";
import { dummyCampaign } from "@/data/dummy-campaign";
import { linearStory, linearStory2 } from "../fixtures/linear-story";

const body: FullWorkflowRequestBody = {
  materials: [{ material: "Linear algebra: a linear combination scales vectors and adds them." }],
  campaignOptions: { genre: "fantasy" },
};

function respond(status: number, json: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
}

/** A fetch that forwards to the real route handler in-process. */
const routeFetch: typeof fetch = async (_url, init) =>
  POST(new NextRequest("http://localhost/api/ai/full-workflow", { method: "POST", body: init?.body as string }));

describe("requestCampaign", () => {
  it("returns the campaign and its stories in story order", async () => {
    const result = await requestCampaign(
      body,
      respond(200, { ok: true, data: { campaign: dummyCampaign, stories: { story_02: linearStory2, story_01: linearStory } } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.campaign.campaign_id).toBe("campaign_001");
    expect([...result.stories.keys()]).toEqual(["story_01", "story_02"]);
  });

  it("works end to end against the real route with the dummy provider", async () => {
    const result = await requestCampaign(body, routeFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.campaign.genre).toBe("fantasy");
    expect(result.stories.size).toBe(result.campaign.story_sequence.length);
  });

  it("explains a material-analysis failure", async () => {
    const result = await requestCampaign(body, respond(500, { ok: false, error: { code: "MATERIAL_ANALYSIS_FAILED", message: "x" } }));
    expect(result).toEqual({ ok: false, message: BUILD_MESSAGES.noConcepts });
  });

  it("asks the user to retry when the AI provider is busy", async () => {
    const result = await requestCampaign(body, respond(503, { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "x" } }));
    expect(result).toEqual({ ok: false, message: BUILD_MESSAGES.busy });
  });

  it("reports a rejected request from the real route", async () => {
    const result = await requestCampaign({ ...body, materials: [{ material: "short" }] }, routeFetch);
    expect(result).toEqual({ ok: false, message: BUILD_MESSAGES.invalidRequest });
  });

  it("reports a network failure", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await requestCampaign(body, offline)).toEqual({ ok: false, message: BUILD_MESSAGES.network });
  });

  it("rejects a success response whose story fails validation", async () => {
    const broken = { ...linearStory, chapters: [] };
    const result = await requestCampaign(
      body,
      respond(200, { ok: true, data: { campaign: dummyCampaign, stories: { story_01: broken, story_02: linearStory2 } } })
    );
    expect(result).toEqual({ ok: false, message: BUILD_MESSAGES.unexpected });
  });

  it("rejects a success response missing a story from the sequence", async () => {
    const result = await requestCampaign(
      body,
      respond(200, { ok: true, data: { campaign: dummyCampaign, stories: { story_01: linearStory } } })
    );
    expect(result).toEqual({ ok: false, message: BUILD_MESSAGES.storyFailed });
  });
});
