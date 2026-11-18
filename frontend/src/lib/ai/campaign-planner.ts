/**
 * Campaign Planner Service — Layer 2 Pipeline (M8)
 *
 * Orchestrates: Provider → Output Parser → Validated CampaignBlueprint.
 * Pure server-side logic, no React dependencies.
 *
 * Mirrors M7 `material-intelligence.ts` conventions exactly.
 */

import { getCampaignPlannerProviderCached, resetCampaignPlannerProviderCache } from "@/lib/ai/providers";
import { parseCampaignProviderResult } from "@/lib/ai/campaign-output-parser";
import type {
  PlanCampaignRequest,
  PlanCampaignResult,
} from "@/lib/ai/campaign-planner-types";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { ValidationError } from "@/lib/validation/story-validator";

/** Service result envelope on success. */
export interface CampaignPlannerResult {
  ok: true;
  blueprint: CampaignBlueprint;
  meta: {
    provider: string;
    model: string;
    latencyMs: number;
    warnings: ValidationError[];
  };
}

/** Service result envelope on failure. */
export interface CampaignPlannerError {
  ok: false;
  code: string;
  message: string;
  detail?: unknown;
}

export type CampaignPlannerResponse = CampaignPlannerResult | CampaignPlannerError;

/**
 * Main entry point: plan a campaign from materials and options.
 * Returns validated CampaignBlueprint or structured error.
 * Never throws for expected failures.
 */
export async function planCampaign(
  request: PlanCampaignRequest
): Promise<CampaignPlannerResponse> {
  // 1. Call provider. Providers are contractually no-throw, but a misbehaving
  //    or future implementation must never break the service surface.
  let providerResult: PlanCampaignResult;
  try {
    const provider = getCampaignPlannerProviderCached();
    providerResult = await provider.planCampaign(request);
  } catch (err) {
    return {
      ok: false,
      code: "UNKNOWN",
      message: "Campaign planner provider threw an unexpected error.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Parse and validate output
  const parseResult = parseCampaignProviderResult(providerResult, request.materials);

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
    blueprint: parseResult.value.blueprint,
    meta: {
      provider: parseResult.value.meta.provider,
      model: parseResult.value.meta.model,
      latencyMs: parseResult.value.meta.latencyMs,
      warnings: parseResult.value.meta.warnings,
    },
  };
}

/** Reset provider cache (for testing). */
export function resetCampaignPlannerCache(): void {
  resetCampaignPlannerProviderCache();
}
