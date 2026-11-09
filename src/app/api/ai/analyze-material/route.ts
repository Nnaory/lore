/**
 * API Route — POST /api/ai/analyze-material
 *
 * Material Intelligence (Layer 1) endpoint.
 * Validates request, invokes service, returns structured response.
 * Server-side only — no client exposure of provider details.
 */

import { NextRequest, NextResponse } from "next/server";
import { AnalyzeMaterialRequestSchema } from "@/lib/ai/types";
import { analyzeMaterial } from "@/lib/ai/material-intelligence";

/** Standard success response data. */
interface AnalyzeMaterialSuccessData {
  blueprint: MaterialBlueprintFromSchema;
  meta: {
    provider: string;
    model: string;
    latencyMs: number;
    tokensIn?: number;
    tokensOut?: number;
    warnings: Array<{ code: string; message: string; path: string }>;
  };
}

/** Standard success response envelope. */
interface SuccessResponse {
  ok: true;
  data: AnalyzeMaterialSuccessData;
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

import { MaterialBlueprintFromSchema } from "@/lib/ai/schemas/material.schema";

/** POST /api/ai/analyze-material */
export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    // 1. Parse and validate request body
    const body = await request.json();
    const parseResult = AnalyzeMaterialRequestSchema.safeParse(body);

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

    // 2. Invoke Material Intelligence service
    const serviceResult = await analyzeMaterial(parseResult.data);

    // 3. Return standardized response
    if (!serviceResult.ok) {
      const status = serviceResult.code === "VALIDATION_FAILED" ? 502 : 500;
      return NextResponse.json<ErrorResponse>(
        {
          ok: false,
          error: {
            code: serviceResult.code,
            message: serviceResult.message,
            detail: serviceResult.detail,
          },
        },
        { status }
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
    console.error("[API] /api/ai/analyze-material error:", err);
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