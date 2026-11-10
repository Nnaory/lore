/**
 * API Route — POST /api/ai/plan-campaign
 *
 * Campaign Planner (Layer 2) endpoint.
 * Validates request, invokes service, returns structured response.
 * Server-side only — no client exposure of provider details.
 *
 * Status code policy:
 *   400 — malformed request (schema validation failure).
 *   422 — semantically invalid planning input (duplicate IDs, cycles,
 *         unresolved prerequisites).
 *   502 — upstream provider produced invalid output.
 *   500 — unexpected internal error.
 */

import { NextRequest, NextResponse } from "next/server";
import { PlanCampaignRequestSchema } from "@/lib/ai/campaign-planner-types";
import { planCampaign } from "@/lib/ai/campaign-planner";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { ValidationError } from "@/lib/validation/story-validator";

/** Standard success response data. */
interface PlanCampaignSuccessData {
  blueprint: CampaignBlueprint;
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
  data: PlanCampaignSuccessData;
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

/** Error codes that indicate the caller supplied unusable planning input. */
const SEMANTIC_ERROR_CODES = new Set([
  "DUPLICATE_MATERIAL_ID",
  "DUPLICATE_CONCEPT_ID",
  "INVALID_PREREQUISITE_REF",
  "PREREQUISITE_CYCLE",
  "REQUIRED_KNOWLEDGE_ORDER",
]);

/** Error codes that indicate an upstream provider produced invalid output. */
const UPSTREAM_ERROR_CODES = new Set(["OUTPUT_PARSE_FAILED", "VALIDATION_FAILED"]);

function statusForErrorCode(code: string): number {
  if (code === "INVALID_REQUEST") return 400;
  if (SEMANTIC_ERROR_CODES.has(code)) return 422;
  if (UPSTREAM_ERROR_CODES.has(code)) return 502;
  return 500;
}

/** POST /api/ai/plan-campaign */
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    // 1. Parse and validate request body
    const body = await request.json();
    const parseResult = PlanCampaignRequestSchema.safeParse(body);

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

    // 2. Invoke Campaign Planner service
    const serviceResult = await planCampaign(parseResult.data);

    // 3. Return standardized response
    if (!serviceResult.ok) {
      return NextResponse.json<ErrorResponse>(
        {
          ok: false,
          error: {
            code: serviceResult.code,
            message: serviceResult.message,
            detail: serviceResult.detail,
          },
        },
        { status: statusForErrorCode(serviceResult.code) }
      );
    }

    return NextResponse.json<SuccessResponse>(
      {
        ok: true,
        data: {
          blueprint: serviceResult.blueprint,
          meta: serviceResult.meta,
        },
      },
      { status: 200 }
    );
  } catch (err) {
    // Unexpected errors — never leak internals
    console.error("[API] /api/ai/plan-campaign error:", err);
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
