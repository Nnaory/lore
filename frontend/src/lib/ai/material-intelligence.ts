/**
 * Material Intelligence Service — Layer 1 Pipeline
 *
 * Orchestrates: Provider → Output Parser → Validated MaterialBlueprint.
 * Pure server-side logic, no React dependencies.
 */

import { getProviderCached, resetProviderCache } from "@/lib/ai/providers";
import { parseProviderResult } from "@/lib/ai/output-parser";
import type { AnalyzeMaterialRequest, AnalyzeMaterialResult } from "@/lib/ai/types";
import type { MaterialBlueprintFromSchema } from "@/lib/ai/schemas/material.schema";

/** Service result envelope. */
export interface MaterialIntelligenceResult {
  ok: true;
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

/** Service error envelope. */
export interface MaterialIntelligenceError {
  ok: false;
  code: string;
  message: string;
  detail?: unknown;
}

export type MaterialIntelligenceResponse =
  | MaterialIntelligenceResult
  | MaterialIntelligenceError;

/**
 * Main entry point: analyze raw material through the full pipeline.
 * Returns validated MaterialBlueprint or structured error.
 */
export async function analyzeMaterial(
  request: AnalyzeMaterialRequest
): Promise<MaterialIntelligenceResponse> {
  const provider = getProviderCached();

  // 1. Call provider
  const providerResult: AnalyzeMaterialResult = await provider.analyzeMaterial(request);

  // 2. Parse and validate output
  const parseResult = parseProviderResult(providerResult);

  if (!parseResult.ok) {
    return {
      ok: false,
      code: parseResult.code,
      message: parseResult.message,
      detail: parseResult.detail,
    };
  }

  // 3. Success — return enriched result
  return {
    ok: true,
    blueprint: parseResult.blueprint,
    meta: {
      provider: parseResult.meta.provider,
      model: parseResult.meta.model,
      latencyMs: parseResult.meta.latencyMs,
      tokensIn: parseResult.meta.tokensIn,
      tokensOut: parseResult.meta.tokensOut,
      warnings: parseResult.warnings,
    },
  };
}

/** Reset provider cache (for testing). */
export function resetMaterialIntelligenceCache(): void {
  resetProviderCache();
}