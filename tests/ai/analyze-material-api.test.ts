/**
 * Tests — API Route /api/ai/analyze-material
 *
 * Verifies request validation, service invocation, and response format.
 * No external network calls.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetMaterialIntelligenceCache } from "@/lib/ai/material-intelligence";
import { resetProviderCache } from "@/lib/ai/providers";
import type { MaterialIntelligenceResponse } from "@/lib/ai/material-intelligence";

// Mock the service to avoid actual provider calls
vi.mock("@/lib/ai/material-intelligence", () => ({
  analyzeMaterial: vi.fn(),
  resetMaterialIntelligenceCache: vi.fn(),
}));

import { analyzeMaterial as mockedAnalyzeMaterial } from "@/lib/ai/material-intelligence";

// Import the route handler after mocking
const routeModule = await import("@/app/api/ai/analyze-material/route");

describe("API Route — POST /api/ai/analyze-material", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMaterialIntelligenceCache();
    resetProviderCache();
  });

  function createRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/ai/analyze-material", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 200 with blueprint for valid request", async () => {
    const mockBlueprint = {
      material_id: "test_01",
      title: "Test Material",
      summary: "A test summary",
      learning_objectives: ["Understand test concepts"],
      concepts: [
        {
          concept_id: "concept_01",
          name: "Test Concept",
          definition: "A test definition",
          principles: ["Principle 1"],
          methods: ["Method 1"],
          prerequisites: [],
          misconceptions: ["Misconception 1"],
          source_evidence: ["Evidence 1"],
        },
      ],
      scope_limitations: ["Limitation 1"],
    };

    (mockedAnalyzeMaterial as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      blueprint: mockBlueprint,
      meta: {
        provider: "dummy",
        model: "dummy-v1",
        latencyMs: 15,
        tokensIn: 50,
        tokensOut: 200,
        warnings: [],
      },
    } satisfies MaterialIntelligenceResponse);

    const request = createRequest({
      material: "This is a test material about linear combinations and vectors.",
    });

    const response = await routeModule.POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.data.blueprint.material_id).toBe("test_01");
    expect(data.data.meta.provider).toBe("dummy");
  });

  it("returns 400 for missing material field", async () => {
    const request = createRequest({
      context: { grade: "high school" },
    });

    const response = await routeModule.POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 400 for too-short material", async () => {
    const request = createRequest({
      material: "Short",
    });

    const response = await routeModule.POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 502 for provider validation failure", async () => {
    (mockedAnalyzeMaterial as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Output does not match schema",
      detail: {},
    } satisfies MaterialIntelligenceResponse);

    const request = createRequest({
      material: "Valid material content that passes initial validation.",
    });

    const response = await routeModule.POST(request);
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 500 for provider unavailable", async () => {
    (mockedAnalyzeMaterial as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
      message: "AI service unavailable",
    } satisfies MaterialIntelligenceResponse);

    const request = createRequest({
      material: "Valid material content that passes initial validation.",
    });

    const response = await routeModule.POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("returns 500 for unexpected service error", async () => {
    (mockedAnalyzeMaterial as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Unexpected crash")
    );

    const request = createRequest({
      material: "Valid material content that passes initial validation.",
    });

    const response = await routeModule.POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("UNKNOWN");
  });

  it("includes meta in successful response", async () => {
    (mockedAnalyzeMaterial as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      blueprint: {
        material_id: "m1",
        title: "T",
        summary: "S",
        learning_objectives: ["O"],
        concepts: [
          {
            concept_id: "c1",
            name: "N",
            definition: "D",
            principles: [],
            methods: [],
            prerequisites: [],
            misconceptions: [],
            source_evidence: ["E"],
          },
        ],
        scope_limitations: [],
      },
      meta: {
        provider: "dummy",
        model: "dummy-v1",
        latencyMs: 42,
        tokensIn: 100,
        tokensOut: 300,
        warnings: [],
      },
    } satisfies MaterialIntelligenceResponse);

    const request = createRequest({
      material: "Linear algebra content about vector spaces and bases.",
    });

    const response = await routeModule.POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.meta.latencyMs).toBe(42);
    expect(data.data.meta.tokensIn).toBe(100);
    expect(data.data.meta.tokensOut).toBe(300);
  });
});