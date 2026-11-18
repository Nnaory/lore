/**
 * API Route — GET /api/health
 *
 * Runtime liveness endpoint for Docker HEALTHCHECK and smoke tests.
 * Reads request headers so Next.js evaluates the handler dynamically
 * even with cacheComponents enabled.
 */

import { NextRequest, NextResponse } from "next/server";

interface HealthResponse {
  status: "ok";
}

/** GET /api/health */
export async function GET(request: NextRequest): Promise<NextResponse<HealthResponse>> {
  // Touch request metadata so cacheComponents treats this as dynamic at runtime.
  void request.headers.get("user-agent");

  return NextResponse.json<HealthResponse>(
    { status: "ok" },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
