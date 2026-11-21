/**
 * Tests — AI routes when no LLM is configured.
 *
 * Every route must answer 503 PROVIDER_NOT_CONFIGURED (never a made-up
 * blueprint), and the client must turn that code into its own message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clearProvidersForTest, setProvidersForTest } from "@/lib/ai/providers";
import { POST as analyze } from "@/app/api/ai/analyze-material/route";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  clearProvidersForTest();
  vi.stubEnv("AI_PROVIDER", "google");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("routes without an LLM", () => {
  it("analyze-material answers 503 PROVIDER_NOT_CONFIGURED", async () => {
    const res = await analyze(post("/api/ai/analyze-material", { material: "belajar vector" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("PROVIDER_NOT_CONFIGURED");
  });
});

describe("analysis that finds nothing to teach", () => {
  it("analyze-material answers 422 MATERIAL_ANALYSIS_FAILED and the client says no concepts were found", async () => {
    setProvidersForTest({
      material: {
        id: "google",
        model: "stub",
        analyzeMaterial: async () => ({
          ok: false,
          error: { code: "MATERIAL_ANALYSIS_FAILED", message: "No teachable concepts were found." },
        }),
      },
    });
    const res = await analyze(post("/api/ai/analyze-material", { material: "belajar vector" }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("MATERIAL_ANALYSIS_FAILED");
    expect(messageForCode(json.error.code)).toBe(BUILD_MESSAGES.noConcepts);
  });
});
