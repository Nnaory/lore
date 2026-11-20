import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCampaignPlannerProviderCached,
  getProviderCached,
  getStoryGeneratorProviderCached,
  resetCampaignPlannerProviderCache,
  resetProviderCache,
  resetStoryGeneratorProviderCache,
} from "@/lib/ai/providers";

const getters = {
  material: getProviderCached,
  planner: getCampaignPlannerProviderCached,
  story: getStoryGeneratorProviderCached,
};

function useGemini(nodeEnv: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("AI_PROVIDER", "google");
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetProviderCache();
  resetCampaignPlannerProviderCache();
  resetStoryGeneratorProviderCache();
});

describe("provider cache", () => {
  it.each(Object.entries(getters))("reuses the %s provider outside development", (_name, get) => {
    useGemini("production");
    expect(get()).toBe(get());
  });

  it.each(Object.entries(getters))("builds a fresh %s provider per call under next dev", (_name, get) => {
    useGemini("development");
    const a = get();
    const b = get();
    expect(a).not.toBe(b);
    expect(a.id).toBe("google"); // still the configured provider
  });
});
