/**
 * Tests - shared AI fixture contract (FastAPI backend <-> client)
 *
 * backend/tests/fixtures/ai/*.json holds the request/response payloads the
 * backend promises for the three AI steps. This file runs them through the
 * REAL client code (request schemas, postBlueprint, messageForCode) so any
 * drift between the FastAPI response shape and what the client accepts fails
 * here.
 *
 * Fixtures are discovered by name, so plan-campaign.* and generate-story.*
 * are covered automatically once they are added:
 *   <step>.request.json, <step>.success.json, error-*.json
 * (<step>.gemini-output.json is raw model output and is deliberately skipped.)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnalyzeMaterialRequestSchema,
  GenerateStoryRequestSchema,
  PlanCampaignRequestSchema,
} from "@/lib/contracts/ai-requests";
import { messageForCode } from "@/lib/contracts/error-messages";
import { CampaignBlueprintSchema } from "@/lib/contracts/schemas/campaign.schema";
import { MaterialBlueprintSchema } from "@/lib/contracts/schemas/material.schema";
import { StoryBlueprintSchema } from "@/lib/contracts/schemas/story.schema";
import { postBlueprint } from "@/lib/generation/generation";

const DIR = join(__dirname, "..", "..", "..", "backend", "tests", "fixtures", "ai");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), "utf8"));
}

function jsonResponse(body: unknown, status: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

type StepSpec = {
  step: string;
  request: z.ZodTypeAny;
  blueprint: z.ZodType<unknown, z.ZodTypeDef, unknown>;
};

const ALL_STEPS: StepSpec[] = [
  { step: "analyze-material", request: AnalyzeMaterialRequestSchema, blueprint: MaterialBlueprintSchema },
  { step: "plan-campaign", request: PlanCampaignRequestSchema, blueprint: CampaignBlueprintSchema },
  { step: "generate-story", request: GenerateStoryRequestSchema, blueprint: StoryBlueprintSchema },
];

/** The contract: error code -> HTTP status the backend answers with. */
const STATUS_FOR_CODE: Record<string, number> = {
  INVALID_REQUEST: 400,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  TIMEOUT: 503,
  // RATE_LIMITED from our own limiter is 429 (with Retry-After). The same code coming from
  // Gemini is answered as 503 by the backend, as the Next.js routes did; both map to one message.
  RATE_LIMITED: 429,
  OUTPUT_PARSE_FAILED: 502,
  VALIDATION_FAILED: 502,
  // Semantic input errors (422), as in the Next.js route handlers' status policy.
  MATERIAL_ANALYSIS_FAILED: 422,
  DUPLICATE_MATERIAL_ID: 422,
  DUPLICATE_CONCEPT_ID: 422,
  INVALID_PREREQUISITE_REF: 422,
  PREREQUISITE_CYCLE: 422,
  REQUIRED_KNOWLEDGE_ORDER: 422,
  STORY_NOT_IN_CAMPAIGN: 422,
  MATERIAL_MISMATCH: 422,
  CONCEPT_COVERAGE: 422,
  REQUIRED_KNOWLEDGE_SELF_REFERENCE: 422,
  REQUIRED_KNOWLEDGE_UNTESTABLE: 422,
  UNKNOWN: 500,
};

const MetaSchema = z.object({
  provider: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), path: z.string() })),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
});

const SuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ blueprint: z.unknown(), meta: MetaSchema }),
});

const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), detail: z.unknown().optional() }),
});

const files = readdirSync(DIR);
const errorFiles = files.filter((f) => /^error-.+\.json$/.test(f));

/** `<step>.request.json` and named variants such as `<step>.two-materials.request.json`. */
const variantFiles = (step: string, kind: "request" | "success"): string[] =>
  files.filter((f) => f === `${step}.${kind}.json` || (f.startsWith(`${step}.`) && f.endsWith(`.${kind}.json`)));

// Only steps that already have fixtures; generate-story joins automatically once it does.
const STEPS = ALL_STEPS.filter(
  (s) => variantFiles(s.step, "request").length > 0 || variantFiles(s.step, "success").length > 0
);

describe("fixture discovery", () => {
  it("has the fixture directory", () => {
    expect(existsSync(DIR)).toBe(true);
  });

  it("has at least one error fixture", () => {
    expect(errorFiles.length).toBeGreaterThan(0);
  });

  it("has analyze-material request and success fixtures", () => {
    expect(files).toContain("analyze-material.request.json");
    expect(files).toContain("analyze-material.success.json");
  });
});

describe.each(STEPS)("$step fixtures", ({ step, request, blueprint }) => {
  for (const requestFile of variantFiles(step, "request")) {
    it(`${requestFile} passes the client request schema`, () => {
      const parsed = request.safeParse(readJson(requestFile));
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });
  }

  for (const successFile of variantFiles(step, "success")) {
    const fixture = readJson(successFile) as { data: { blueprint: unknown; meta: unknown } };

    it(`${successFile} has the success envelope shape`, () => {
      const parsed = SuccessEnvelopeSchema.safeParse(fixture);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });

    it(`${successFile} is accepted by postBlueprint with the same blueprint`, async () => {
      const result = await postBlueprint(`/api/ai/${step}`, {}, blueprint, {
        fetchImpl: jsonResponse(fixture, 200),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(fixture.data.blueprint);
    });

    it(`${successFile} blueprint passes its schema without issues`, () => {
      const parsed = blueprint.safeParse(fixture.data.blueprint);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });
  }
});

describe("error fixtures", () => {
  it.each(errorFiles)("%s has the error envelope shape", (file) => {
    const parsed = ErrorEnvelopeSchema.safeParse(readJson(file));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it.each(errorFiles)("%s maps to a known status and yields messageForCode", async (file) => {
    const fixture = readJson(file) as { error: { code: string } };
    const status = STATUS_FOR_CODE[fixture.error.code];
    expect(status, `add ${fixture.error.code} to STATUS_FOR_CODE`).toBeDefined();

    const result = await postBlueprint("/api/ai/analyze-material", {}, MaterialBlueprintSchema, {
      fetchImpl: jsonResponse(fixture, status),
    });
    expect(result).toEqual({ ok: false, message: messageForCode(fixture.error.code) });
  });
});
