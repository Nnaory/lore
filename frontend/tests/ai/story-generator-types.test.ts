/**
 * Tests — Story Generator Types (M9 Phase 1)
 *
 * Verifies the request schema, error codes, and provider contract shape.
 */

import { describe, it, expect } from "vitest";
import {
  GenerateStoryRequestSchema,
  type GenerateStoryRequest,
  type IStoryGeneratorProvider,
  type StoryGeneratorErrorCode,
} from "@/lib/ai/story-generator-types";
import {
  dummyCampaign,
  dummyMaterial,
  dummyStory,
  dummyMaterial2,
  dummyMaterial3,
  dummyPlannerOptions,
} from "@/data/dummy-campaign";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const planned = buildCampaignBlueprint(
  [dummyMaterial, dummyMaterial2, dummyMaterial3],
  dummyPlannerOptions
);
if (!planned.ok) throw new Error("fixture planning failed");

const plannedCampaign = planned.blueprint;
const entry1 = plannedCampaign.story_sequence[0];
const entry2 = plannedCampaign.story_sequence[1];

const materialById = new Map([
  [dummyMaterial.material_id, dummyMaterial],
  [dummyMaterial2.material_id, dummyMaterial2],
  [dummyMaterial3.material_id, dummyMaterial3],
]);

function validRequest(): GenerateStoryRequest {
  return {
    campaign: plannedCampaign,
    story: entry1,
    material: materialById.get(entry1.material_id)!,
  };
}

interface ZodLikeIssue {
  path: (string | number)[];
  message: string;
}

// ---------------------------------------------------------------------------
// Request schema — acceptance
// ---------------------------------------------------------------------------

describe("GenerateStoryRequestSchema — accepts valid requests", () => {
  it("accepts a planner-produced campaign entry + its material", () => {
    const result = GenerateStoryRequestSchema.safeParse(validRequest());
    expect(result.success).toBe(true);
  });

  it("accepts a second campaign entry", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      campaign: plannedCampaign,
      story: entry2,
      material: materialById.get(entry2.material_id)!,
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional continuity summaries", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      previousSummaries: [
        {
          story_id: "story_01",
          title: "Done",
          outcome_description: "Resolved",
          world_state_snapshot: { stability: 10 },
          relationship_snapshot: { char_01: 5 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional story options", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      options: { conceptsPerChapter: 2, language: "en" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a legacy campaign fixture too (schema is contract-level)", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      campaign: dummyCampaign,
      story: dummyCampaign.story_sequence[0],
      material: dummyMaterial,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Request schema — rejection
// ---------------------------------------------------------------------------

describe("GenerateStoryRequestSchema — rejects invalid requests", () => {
  it("rejects a request without a campaign", () => {
    const { campaign: _c, ...rest } = validRequest();
    expect(GenerateStoryRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a request without a story entry", () => {
    const { story: _s, ...rest } = validRequest();
    expect(GenerateStoryRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a request without a material", () => {
    const { material: _m, ...rest } = validRequest();
    expect(GenerateStoryRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a malformed campaign", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      campaign: { campaign_id: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed material", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      material: { material_id: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a story entry with an empty story_id", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      story: { ...entry1, story_id: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive conceptsPerChapter", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      options: { conceptsPerChapter: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed continuity summary", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      previousSummaries: [{ story_id: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("reports the offending path on failure", () => {
    const result = GenerateStoryRequestSchema.safeParse({
      ...validRequest(),
      story: { ...entry1, story_id: "" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues as ZodLikeIssue[];
      expect(issues.some((i) => i.path.includes("story"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

describe("StoryGeneratorErrorCode — completeness", () => {
  it("covers request, semantic, provider, parse, and unknown failures", () => {
    const expected: StoryGeneratorErrorCode[] = [
      "INVALID_REQUEST",
      "STORY_NOT_IN_CAMPAIGN",
      "MATERIAL_MISMATCH",
      "CONCEPT_COVERAGE",
      "INVALID_CONCEPT_REF",
      "PROVIDER_UNAVAILABLE",
      "OUTPUT_PARSE_FAILED",
      "VALIDATION_FAILED",
      "UNKNOWN",
    ];
    // Compile-time exhaustiveness check: every code is a valid literal.
    const codes: StoryGeneratorErrorCode[] = expected;
    expect(new Set(codes).size).toBe(expected.length);
  });
});

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

describe("IStoryGeneratorProvider — contract", () => {
  it("is implementable and returns a discriminated union", async () => {
    const provider: IStoryGeneratorProvider = {
      id: "dummy",
      model: "test-model",
      async generateStory() {
        return {
          ok: true,
          value: {
            blueprint: dummyStory,
            meta: {
              provider: "dummy",
              model: "test-model",
              latencyMs: 0,
              warnings: [],
            },
          },
        };
      },
    };

    const result = await provider.generateStory(validRequest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.provider).toBe("dummy");
      expect(result.value.blueprint.story_id).toBe(dummyStory.story_id);
    }
  });

  it("expresses failures without throwing", async () => {
    const provider: IStoryGeneratorProvider = {
      id: "dummy",
      model: "test-model",
      async generateStory() {
        return {
          ok: false,
          error: { code: "STORY_NOT_IN_CAMPAIGN", message: "not part of campaign" },
        };
      },
    };

    const result = await provider.generateStory(validRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_NOT_IN_CAMPAIGN");
    }
  });
});
