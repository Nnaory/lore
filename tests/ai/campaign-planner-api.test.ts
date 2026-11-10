/**
 * Tests — API Route /api/ai/plan-campaign
 *
 * Verifies request validation, service invocation, status code mapping, and
 * response envelope. No external network calls — the service is mocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CampaignPlannerResponse } from "@/lib/ai/campaign-planner";
import type { CampaignBlueprint } from "@/lib/types/campaign";

// Mock the service to avoid actual provider calls
vi.mock("@/lib/ai/campaign-planner", () => ({
  planCampaign: vi.fn(),
  resetCampaignPlannerCache: vi.fn(),
}));

import { planCampaign as mockedPlanCampaign } from "@/lib/ai/campaign-planner";

// Import the route handler after mocking
const routeModule = await import("@/app/api/ai/plan-campaign/route");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validMaterial = {
  material_id: "material_01",
  title: "Linear Combinations",
  summary: "Covers vector scaling and addition.",
  learning_objectives: ["Understand linear combinations."],
  concepts: [
    {
      concept_id: "concept_lin_comb",
      name: "Linear Combination",
      definition: "c1*v1 + c2*v2 for scalars c1, c2.",
      principles: ["Vectors can be scaled."],
      methods: ["Solve for scalar coefficients."],
      prerequisites: [],
      misconceptions: [],
      source_evidence: ["A linear combination is c1v1 + c2v2."],
    },
  ],
  scope_limitations: [],
};

const validBody = {
  materials: [validMaterial],
  options: { genre: "fantasy" },
};

const mockBlueprint: CampaignBlueprint = {
  campaign_id: "campaign_001",
  title: "Mock Campaign",
  genre: "fantasy",
  tone: "mysterious",
  premise: "Mock premise.",
  main_conflict: "Mock conflict.",
  setting: "Mock setting.",
  characters: [
    {
      character_id: "char_01",
      name: "Keeper",
      role: "Guide",
      description: "A guide.",
      expressions: { neutral: "(-_-)" },
    },
  ],
  world_rules: ["Mock rule."],
  story_sequence: [
    {
      story_id: "story_01",
      material_id: "material_01",
      title: "Mock Story",
      purpose: "Introduce the first concepts.",
      main_conflict: "Mock story conflict.",
      required_knowledge: [],
      outcomes: [
        {
          outcome_id: "outcome_01",
          description: "Success.",
          world_state_changes: { stability: 10 },
        },
      ],
    },
  ],
};

describe("API Route — POST /api/ai/plan-campaign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/ai/plan-campaign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── Success ───────────────────────────────────────────────────────────

  it("returns 200 with blueprint for valid request", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      blueprint: mockBlueprint,
      meta: {
        provider: "dummy",
        model: "dummy-planner-v1",
        latencyMs: 5,
        warnings: [],
      },
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.data.blueprint.campaign_id).toBe("campaign_001");
    expect(data.data.meta.provider).toBe("dummy");
    expect(data.data.meta.model).toBe("dummy-planner-v1");
  });

  it("passes warnings through in the success envelope", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      blueprint: mockBlueprint,
      meta: {
        provider: "dummy",
        model: "dummy-planner-v1",
        latencyMs: 5,
        warnings: [
          {
            code: "PREREQUISITE_TESTABILITY_PENDING",
            message: "pending",
            path: "story_sequence[story_02].required_knowledge",
          },
        ],
      },
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.data.meta.warnings).toHaveLength(1);
    expect(data.data.meta.warnings[0].code).toBe("PREREQUISITE_TESTABILITY_PENDING");
  });

  // ── 400 — malformed request ───────────────────────────────────────────

  it("returns 400 for malformed body (missing materials)", async () => {
    const response = await routeModule.POST(
      createRequest({ options: { genre: "fantasy" } })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("INVALID_REQUEST");
    expect(data.error.detail).toBeDefined();
  });

  it("returns 400 for empty materials array", async () => {
    const response = await routeModule.POST(
      createRequest({ materials: [], options: { genre: "fantasy" } })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 400 for invalid genre", async () => {
    const response = await routeModule.POST(
      createRequest({
        materials: [validMaterial],
        options: { genre: "romance" },
      })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 400 for structurally invalid material", async () => {
    const response = await routeModule.POST(
      createRequest({
        materials: [{ material_id: "" }],
        options: { genre: "fantasy" },
      })
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("INVALID_REQUEST");
  });

  // ── 422 — semantic planning failures ──────────────────────────────────

  it("returns 422 for duplicate concept IDs", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "DUPLICATE_CONCEPT_ID",
      message: "concept_id \"c1\" is defined twice",
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("DUPLICATE_CONCEPT_ID");
  });

  it("returns 422 for prerequisite cycles", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "PREREQUISITE_CYCLE",
      message: "cycle detected",
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.error.code).toBe("PREREQUISITE_CYCLE");
  });

  it("returns 422 for duplicate material IDs", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "DUPLICATE_MATERIAL_ID",
      message: "duplicate material",
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(422);
    expect(data.error.code).toBe("DUPLICATE_MATERIAL_ID");
  });

  // ── 502 — upstream output failures ────────────────────────────────────

  it("returns 502 when provider output fails validation", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Provider output failed planner semantic validation.",
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 502 when provider output cannot be parsed", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "OUTPUT_PARSE_FAILED",
      message: "unparseable provider output",
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data.error.code).toBe("OUTPUT_PARSE_FAILED");
  });

  // ── 500 — internal failures ───────────────────────────────────────────

  it("returns 500 for PROVIDER_UNAVAILABLE", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
      message: "upstream down",
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("returns 500 for unknown service error", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      code: "UNKNOWN",
      message: "unexpected error",
    } satisfies CampaignPlannerResponse);

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error.code).toBe("UNKNOWN");
  });

  it("returns 500 without leaking internals when the service throws", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new Error("secrets in stack trace");
      }
    );

    const response = await routeModule.POST(createRequest(validBody));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("UNKNOWN");
    expect(data.error.message).not.toContain("secrets");
    expect(JSON.stringify(data)).not.toContain("stack");
    errorSpy.mockRestore();
  });

  // ── Envelope shape ────────────────────────────────────────────────────

  it("always uses the { ok, data } / { ok, error } envelope", async () => {
    (mockedPlanCampaign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      blueprint: mockBlueprint,
      meta: {
        provider: "dummy",
        model: "dummy-planner-v1",
        latencyMs: 1,
        warnings: [],
      },
    } satisfies CampaignPlannerResponse);

    const successData = await (
      await routeModule.POST(createRequest(validBody))
    ).json();
    expect(Object.keys(successData)).toContain("ok");
    expect(Object.keys(successData)).toContain("data");
    expect(successData.ok).toBe(true);

    const failureData = await (
      await routeModule.POST(createRequest({ garbage: true }))
    ).json();
    expect(Object.keys(failureData)).toContain("ok");
    expect(Object.keys(failureData)).toContain("error");
    expect(failureData.ok).toBe(false);
  });
});
