/**
 * API Route — POST /api/ai/generate-story
 *
 * Story Generation (Layer 3) endpoint.
 * Validates request, invokes service, returns structured response.
 * Server-side only — no client exposure of provider details.
 *
 * Status code policy:
 *   400 — malformed request (schema validation failure).
 *   422 — semantically invalid input (STORY_NOT_IN_CAMPAIGN, MATERIAL_MISMATCH,
 *         CONCEPT_COVERAGE, REQUIRED_KNOWLEDGE_SELF_REFERENCE,
 *         REQUIRED_KNOWLEDGE_UNTESTABLE).
 *   502 — upstream provider produced invalid output.
 *   500 — unexpected internal error.
 */

import { NextRequest, NextResponse } from "next/server";
import { GenerateStoryRequestSchema } from "@/lib/ai/story-generator-types";
import { generateStory } from "@/lib/ai/story-generator-service";
import type { StoryBlueprint } from "@/lib/types/story";
import type { ValidationError } from "@/lib/validation/story-validator";

/** Standard success response data. */
interface GenerateStorySuccessData {
  blueprint: StoryBlueprint;
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
  data: GenerateStorySuccessData;
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

/** Error codes that indicate the caller supplied unusable generation input. */
const SEMANTIC_ERROR_CODES = new Set([
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

/** POST /api/ai/generate-story */
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    // 1. Parse and validate request body
    const body = await request.json();
    const parseResult = GenerateStoryRequestSchema.safeParse(body);

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

    // 2. Invoke Story Generator service
    const serviceResult = await generateStory(parseResult.data);

    // 3. Return standardized response
    if (!serviceResult.ok) {
      return NextResponse.json<ErrorResponse>(
        {
          ok: false,
          error: {
            code: serviceResult.error.code,
            message: serviceResult.error.message,
            detail: serviceResult.error.detail,
          },
        },
        { status: statusForErrorCode(serviceResult.error.code) }
      );
    }

    return NextResponse.json<SuccessResponse>(
      {
        ok: true,
        data: {
          blueprint: serviceResult.value.blueprint,
          meta: serviceResult.value.meta,
        },
      },
      { status: 200 }
    );
  } catch (err) {
    // Unexpected errors — never leak internals
    console.error("[API] /api/ai/generate-story error:", err);
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