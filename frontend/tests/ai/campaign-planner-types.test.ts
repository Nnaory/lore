/**
 * Tests — Campaign Planner Types (M8 Phase 1)
 *
 * Verifies the request schema and the ICampaignPlannerProvider contract.
 */

import { describe, it, expect } from "vitest";
import {
  PlanCampaignRequestSchema,
  CampaignPlannerOptionsSchema,
  type PlanCampaignRequest,
  type PlanCampaignResult,
  type ICampaignPlannerProvider,
  type CampaignPlannerErrorCode,
} from "@/lib/ai/campaign-planner-types";

/** Valid MaterialBlueprint fixture. */
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

const validOptions = { genre: "fantasy" as const };

const validRequest = {
  materials: [validMaterial],
  options: validOptions,
};

describe("CampaignPlannerOptionsSchema", () => {
  it("accepts valid options with only a genre", () => {
    const result = CampaignPlannerOptionsSchema.safeParse({ genre: "fantasy" });
    expect(result.success).toBe(true);
  });

  it("accepts all optional fields", () => {
    const result = CampaignPlannerOptionsSchema.safeParse({
      genre: "science_fiction",
      tone: "mysterious",
      setting: "orbital station",
      customInstructions: "More puzzles",
      campaignId: "campaign_042",
      language: "en",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown genre", () => {
    const result = CampaignPlannerOptionsSchema.safeParse({ genre: "romance" });
    expect(result.success).toBe(false);
  });

  it("rejects options without a genre", () => {
    const result = CampaignPlannerOptionsSchema.safeParse({ tone: "dark" });
    expect(result.success).toBe(false);
  });

  it("rejects non-string tone", () => {
    const result = CampaignPlannerOptionsSchema.safeParse({
      genre: "fantasy",
      tone: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe("PlanCampaignRequestSchema", () => {
  it("accepts a valid single-material request", () => {
    const result = PlanCampaignRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it("accepts a valid multi-material request", () => {
    const material2 = {
      ...validMaterial,
      material_id: "material_02",
      concepts: [
        {
          ...validMaterial.concepts[0],
          concept_id: "concept_span",
          prerequisites: ["concept_lin_comb"],
        },
      ],
    };
    const result = PlanCampaignRequestSchema.safeParse({
      materials: [validMaterial, material2],
      options: validOptions,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty materials array", () => {
    const result = PlanCampaignRequestSchema.safeParse({
      materials: [],
      options: validOptions,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing materials field", () => {
    const result = PlanCampaignRequestSchema.safeParse({
      options: validOptions,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing options field", () => {
    const result = PlanCampaignRequestSchema.safeParse({
      materials: [validMaterial],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid material (fails MaterialBlueprintSchema)", () => {
    const badMaterial = { ...validMaterial, material_id: "" };
    const result = PlanCampaignRequestSchema.safeParse({
      materials: [badMaterial],
      options: validOptions,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a material with no concepts", () => {
    const badMaterial = { ...validMaterial, concepts: [] };
    const result = PlanCampaignRequestSchema.safeParse({
      materials: [badMaterial],
      options: validOptions,
    });
    expect(result.success).toBe(false);
  });

  it("uses parsed data; inferred type matches PlanCampaignRequest", () => {
    const result = PlanCampaignRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed: PlanCampaignRequest = result.data;
      expect(parsed.materials[0].material_id).toBe("material_01");
      expect(parsed.options.genre).toBe("fantasy");
    }
  });
});

describe("ICampaignPlannerProvider — mock contract compliance", () => {
  it("a compliant mock satisfies the interface and result union", async () => {
    const mockProvider: ICampaignPlannerProvider = {
      id: "dummy",
      model: "test-planner",
      async planCampaign(request: PlanCampaignRequest): Promise<PlanCampaignResult> {
        const success: PlanCampaignResult = {
          ok: true,
          value: {
            blueprint: {
              campaign_id: "campaign_001",
              title: "Mock Campaign",
              genre: request.options.genre,
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
                  material_id: request.materials[0].material_id,
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
            },
            meta: { provider: "dummy", model: "test-planner", latencyMs: 0, warnings: [] },
          },
        };
        return success;
      },
      async healthCheck() {
        return { healthy: true };
      },
    };

    expect(mockProvider.id).toBe("dummy");
    expect(mockProvider.model).toBe("test-planner");

    const result = await mockProvider.planCampaign({
      materials: [validMaterial],
      options: { genre: "fantasy" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.provider).toBe("dummy");
      expect(result.value.blueprint.story_sequence).toHaveLength(1);
    }
  });

  it("error results narrow correctly via the result union", () => {
    const codes: CampaignPlannerErrorCode[] = [
      "INVALID_REQUEST",
      "DUPLICATE_MATERIAL_ID",
      "DUPLICATE_CONCEPT_ID",
      "INVALID_PREREQUISITE_REF",
      "PREREQUISITE_CYCLE",
      "REQUIRED_KNOWLEDGE_ORDER",
      "PROVIDER_UNAVAILABLE",
      "OUTPUT_PARSE_FAILED",
      "VALIDATION_FAILED",
      "UNKNOWN",
    ];
    expect(codes).toHaveLength(10);

    function handle(result: PlanCampaignResult): string {
      if (result.ok) return result.value.meta.model;
      return result.error.code;
    }

    const failure: PlanCampaignResult = {
      ok: false,
      error: { code: "PREREQUISITE_CYCLE", message: "cycle detected" },
    };
    expect(handle(failure)).toBe("PREREQUISITE_CYCLE");
  });
});
