/**
 * Tests — AI endpoint selection (resolveAiBackend, aiUrl)
 */

import { describe, it, expect } from "vitest";
import { AI_BACKEND, aiUrl, resolveAiBackend, type AiStep } from "@/lib/generation/ai-endpoints";

describe("resolveAiBackend", () => {
  it("selects api only for the exact value 'api'", () => {
    expect(resolveAiBackend("api")).toBe("api");
  });

  it.each([undefined, "", "next", "API", " api", "http", "weird"])("falls back to next for %j", (raw) => {
    expect(resolveAiBackend(raw)).toBe("next");
  });
});

describe("aiUrl", () => {
  const steps: AiStep[] = ["analyze-material", "plan-campaign", "generate-story"];

  it.each(steps)("next backend uses /api/ai/%s", (step) => {
    expect(aiUrl(step, "next")).toBe(`/api/ai/${step}`);
  });

  it.each(steps)("api backend uses /api/v1/ai/%s", (step) => {
    expect(aiUrl(step, "api")).toBe(`/api/v1/ai/${step}`);
  });
});

describe("AI_BACKEND", () => {
  it("defaults to next when the flag is not set in tests", () => {
    expect(AI_BACKEND).toBe("next");
  });
});
