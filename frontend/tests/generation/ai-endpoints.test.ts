/**
 * Tests — AI endpoint URLs (aiUrl)
 */

import { describe, it, expect } from "vitest";
import { aiUrl, type AiStep } from "@/lib/generation/ai-endpoints";

describe("aiUrl", () => {
  const steps: AiStep[] = ["analyze-material", "plan-campaign", "generate-story"];

  it.each(steps)("points %s at the backend under /api/v1/ai", (step) => {
    expect(aiUrl(step)).toBe(`/api/v1/ai/${step}`);
  });
});
