/**
 * Tests — provider registry without an offline provider.
 *
 * With no reachable LLM every layer must report PROVIDER_NOT_CONFIGURED
 * (never invent a blueprint); with a key it must build the Gemini provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProvidersForTest,
  getCampaignPlannerProvider,
  getProvider,
  getStoryGeneratorProvider,
  setProvidersForTest,
} from "@/lib/ai/providers";
import { DummyProvider } from "../helpers/dummy-providers/dummy-provider";
import type { PlanCampaignRequest } from "@/lib/ai/campaign-planner-types";
import type { GenerateStoryRequest } from "@/lib/ai/story-generator-types";

beforeEach(() => {
  clearProvidersForTest(); // use the real, env-driven registry
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function expectAllLayersNotConfigured() {
  const material = await getProvider().analyzeMaterial({ material: "Vectors have magnitude and direction." });
  const plan = await getCampaignPlannerProvider().planCampaign({} as PlanCampaignRequest);
  const story = await getStoryGeneratorProvider().generateStory({} as GenerateStoryRequest);
  for (const result of [material, plan, story]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROVIDER_NOT_CONFIGURED");
  }
}

describe("provider registry without an LLM", () => {
  it("is unavailable when AI_PROVIDER is unset", async () => {
    vi.stubEnv("AI_PROVIDER", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    await expectAllLayersNotConfigured();
  });

  it("does not fall back to a dummy when AI_PROVIDER=dummy", async () => {
    vi.stubEnv("AI_PROVIDER", "dummy");
    expect(getProvider().id).toBe("none");
    await expectAllLayersNotConfigured();
  });

  it("is unavailable for an unknown provider", async () => {
    vi.stubEnv("AI_PROVIDER", "not-a-provider");
    await expectAllLayersNotConfigured();
  });

  it("is unavailable when AI_PROVIDER=google but the key is missing", async () => {
    vi.stubEnv("AI_PROVIDER", "google");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    await expectAllLayersNotConfigured();
  });

  it("warns on the server about why a layer is unavailable", () => {
    vi.stubEnv("AI_PROVIDER", "google");
    vi.stubEnv("GOOGLE_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    getProvider();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("provider registry with a key", () => {
  it("builds the Gemini provider for every layer", () => {
    vi.stubEnv("AI_PROVIDER", "google");
    vi.stubEnv("GOOGLE_API_KEY", "test-key");
    expect(getProvider().id).toBe("google");
    expect(getCampaignPlannerProvider().id).toBe("google");
    expect(getStoryGeneratorProvider().id).toBe("google");
  });
});

describe("test doubles", () => {
  it("setProvidersForTest overrides the registry and clearProvidersForTest removes it", () => {
    const double = new DummyProvider();
    setProvidersForTest({ material: double });
    expect(getProvider()).toBe(double);
    clearProvidersForTest();
    expect(getProvider()).not.toBe(double);
  });

  it("ignores overrides outside NODE_ENV=test", () => {
    vi.stubEnv("NODE_ENV", "production");
    setProvidersForTest({ material: new DummyProvider() });
    vi.stubEnv("NODE_ENV", "test");
    expect(getProvider().id).toBe("none");
  });
});
