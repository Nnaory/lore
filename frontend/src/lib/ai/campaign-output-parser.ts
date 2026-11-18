/**
 * Output Parser & Validator — Campaign Planner (Layer 2, M8)
 *
 * Parses raw provider output, validates against the CampaignBlueprint schema,
 * then runs the planner-specific semantic validator. Never rewrites or repairs
 * structurally invalid output. Never mutates its input.
 *
 * Mirrors the M7 `output-parser.ts` conventions: a discriminated union result,
 * structured error codes, and non-blocking warnings.
 */

import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";
import { validatePlannedCampaign } from "@/lib/validation/planner-validator";
import type { ValidationError } from "@/lib/validation/story-validator";
import type { MaterialBlueprint } from "@/lib/types/material";
import type {
  CampaignPlannerErrorCode,
  PlanCampaignResult,
  PlanCampaignResponse,
} from "@/lib/ai/campaign-planner-types";

/** Parsed and validated output. */
export interface ParsedCampaignResult {
  ok: true;
  value: PlanCampaignResponse;
}

/** Parse error with standardized code. */
export interface CampaignParseError {
  ok: false;
  code: CampaignPlannerErrorCode;
  message: string;
  detail?: unknown;
}

export type CampaignParseOutcome = ParsedCampaignResult | CampaignParseError;

/**
 * Parse and validate a raw provider result.
 *
 * @param providerResult  The PlanCampaignResult returned by a provider.
 * @param materials       The materials the campaign was planned from. Required
 *                        for planner-specific semantic validation.
 * @returns A CampaignParseOutcome (never throws).
 */
export function parseCampaignProviderResult(
  providerResult: PlanCampaignResult,
  materials: MaterialBlueprint[]
): CampaignParseOutcome {
  // ── 1. Provider-level failure passes through unchanged ──────────────────
  if (!providerResult.ok) {
    return {
      ok: false,
      code: providerResult.error.code,
      message: providerResult.error.message,
      detail: providerResult.error.detail,
    };
  }

  return parseAndValidateCampaignOutput(providerResult.value, materials);
}

/**
 * Validate a candidate campaign response against the schema and planner rules.
 *
 * @param rawResponse  Provider response with a candidate blueprint and meta.
 * @param materials    Materials used to produce the blueprint.
 */
export function parseAndValidateCampaignOutput(
  rawResponse: PlanCampaignResponse,
  materials: MaterialBlueprint[]
): CampaignParseOutcome {
  const { blueprint: rawBlueprint, meta } = rawResponse;

  // ── 1. Zod schema validation ────────────────────────────────────────────
  const schemaResult = CampaignBlueprintSchema.safeParse(rawBlueprint);
  if (!schemaResult.success) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Provider output does not match the CampaignBlueprint schema.",
      detail: schemaResult.error.flatten(),
    };
  }

  const blueprint = schemaResult.data;

  // ── 2. Planner-specific semantic validation ─────────────────────────────
  const semantic = validatePlannedCampaign(blueprint, materials);
  if (!semantic.valid) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Provider output failed planner semantic validation.",
      detail: semantic.errors,
    };
  }

  // ── 3. Non-blocking warnings from the provider ──────────────────────────
  const warnings: ValidationError[] = Array.isArray(meta.warnings)
    ? [...meta.warnings]
    : [];

  return {
    ok: true,
    value: {
      blueprint,
      meta: { ...meta, warnings },
    },
  };
}
