/**
 * API Route — POST /api/ai/full-workflow
 *
 * End-to-end campaign generation: materials → campaign → stories.
 * Orchestrates all three AI layers in a single request.
 * Server-side only — no client exposure of provider details.
 *
 * Status code policy:
 *   400 — malformed request (schema validation failure).
 *   422 — semantically invalid input at any layer.
 *   502 — upstream provider produced invalid output.
 *   500 — unexpected internal error.
 */

import { NextRequest, NextResponse } from "next/server";
import { runFullWorkflow } from "@/lib/ai/full-workflow";
import { AnalyzeMaterialRequestSchema } from "@/lib/ai/types";
import { CampaignPlannerOptionsSchema } from "@/lib/ai/campaign-planner-types";
import { StoryGeneratorOptionsSchema } from "@/lib/ai/story-generator-types";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { ValidationError } from "@/lib/validation/story-validator";

/** Full workflow request schema. */
const FullWorkflowRequestSchema = z.object({
  materials: z.array(AnalyzeMaterialRequestSchema).min(1, "at least one material is required"),
  campaignOptions: CampaignPlannerOptionsSchema,
  storyOptions: StoryGeneratorOptionsSchema.optional(),
});

import { z } from "zod";

/** Standard success response data. */
interface FullWorkflowSuccessData {
  campaign: CampaignBlueprint;
  stories: Record<string, StoryBlueprint>;
  materialResults: Array<{
    materialId: string;
    ok: boolean;
    blueprint?: MaterialBlueprint;
    error?: { code: string; message: string; detail?: unknown };
  }>;
  meta: {
    provider: string;
    model: string;
    latencyMs: number;
    warnings: ValidationError[];
  };
}

/** Standard success response envelope. */
interface SuccessResponse {
  ok: true;
  data: FullWorkflowSuccessData;
}

/** Standard error response envelope. */
interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

type ApiResponse = SuccessResponse | ErrorResponse;

/** Error codes that indicate the caller supplied unusable input. */
const SEMANTIC_ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "DUPLICATE_MATERIAL_ID",
  "DUPLICATE_CONCEPT_ID",
  "INVALID_PREREQUISITE_REF",
  "PREREQUISITE_CYCLE",
  "REQUIRED_KNOWLEDGE_ORDER",
  "STORY_NOT_IN_CAMPAIGN",
  "MATERIAL_MISMATCH",
  "CONCEPT_COVERAGE",
  "REQUIRED_KNOWLEDGE_SELF_REFERENCE",
  "REQUIRED_KNOWLEDGE_UNTESTABLE",
]);

/** Error codes that indicate an upstream provider produced invalid output. */
const UPSTREAM_ERROR_CODES = new Set(["OUTPUT_PARSE_FAILED", "VALIDATION_FAILED"]);

function statusForErrorCode(code: string): number {
  if (code === "INVALID_REQUEST") return 400;
  if (SEMANTIC_ERROR_CODES.has(code)) return 422;
  if (UPSTREAM_ERROR_CODES.has(code)) return 502;
  return 500;
}

/** POST /api/ai/full-workflow */
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  const startTime = Date.now();

  try {
    // 1. Parse and validate request body
    const body = await request.json();
    const parseResult = FullWorkflowRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json<ErrorResponse>(
        {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid request body",
            detail: parseResult.error.flatten(),
          },
        },
        { status: 400 }
      );
    }

    // 2. Invoke full workflow
    const workflowResult = await runFullWorkflow(parseResult.data);

    // 3. Return standardized response
    const latencyMs = Date.now() - startTime;

    if (!workflowResult.ok) {
      return NextResponse.json<ErrorResponse>(
        {
          ok: false,
          error: {
            code: workflowResult.error?.code ?? "UNKNOWN",
            message: workflowResult.error?.message ?? "Workflow failed",
            detail: workflowResult.error?.detail,
          },
        },
        { status: statusForErrorCode(workflowResult.error?.code ?? "UNKNOWN") }
      );
    }

    // Convert Map to Record for JSON serialization
    const storiesRecord: Record<string, StoryBlueprint> = {};
    workflowResult.stories?.forEach((blueprint, storyId) => {
      storiesRecord[storyId] = blueprint;
    });

    // workflowResult.ok === true guarantees planningResult has meta (per runFullWorkflow contract)
    const planningMeta = workflowResult.planningResult! as {
      ok: true;
      meta: { provider: string; model: string; latencyMs: number; warnings: ValidationError[] };
    };

    return NextResponse.json<SuccessResponse>(
      {
        ok: true,
        data: {
          campaign: workflowResult.campaign!,
          stories: storiesRecord,
          materialResults: workflowResult.materialResults,
          meta: {
            provider: planningMeta.meta.provider ?? "dummy",
            model: planningMeta.meta.model ?? "deterministic-template-v1",
            latencyMs,
            warnings: workflowResult.warnings,
          },
        },
      },
      { status: 200 }
    );
  } catch (err) {
    // Unexpected errors — never leak internals
    console.error("[API] /api/ai/full-workflow error:", err);
    return NextResponse.json<ErrorResponse>(
      {
        ok: false,
        error: {
          code: "UNKNOWN",
          message: "Internal server error",
        },
      },
      { status: 500 }
    );
  }
}