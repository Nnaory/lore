/**
 * Campaign Planner Types — Layer 2 (M8)
 *
 * Defines the contract between the application and campaign planner providers.
 *
 * Design notes:
 *   - The planner consumes validated MaterialBlueprints and campaign options.
 *   - The planner produces a CampaignBlueprint only. It does NOT produce story
 *     content, scenes, dialogue, or puzzles (that is Layer 3 and later).
 *   - Real AI providers are deferred. The dummy provider is the only active
 *     implementation; future providers MUST implement ICampaignPlannerProvider.
 *   - All types are serializable and server-side only.
 */

import { z } from "zod";
import { MaterialBlueprintSchema } from "@/lib/ai/schemas/material.schema";
import { GenreSchema } from "@/lib/ai/schemas/campaign.schema";
import type { AIProviderId } from "@/lib/ai/types";
import type { CampaignBlueprint, Genre } from "@/lib/types/campaign";
import type { ValidationError } from "@/lib/validation/story-validator";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Campaign-level creative options supplied by the caller. */
export const CampaignPlannerOptionsSchema = z.object({
  genre: GenreSchema,
  /** Narrative tone. Providers may override this when omitted. */
  tone: z.string().optional(),
  /** World setting. Providers may override this when omitted. */
  setting: z.string().optional(),
  /** Reserved for future real providers. Ignored by the dummy provider. */
  customInstructions: z.string().optional(),
  /** Optional explicit campaign identifier. Defaults to a deterministic value. */
  campaignId: z.string().optional(),
  /** Optional language hint for future providers. Ignored by the dummy provider. */
  language: z.string().optional(),
});

/**
 * Campaign Planner request.
 *
 * `materials` MUST contain at least one valid MaterialBlueprint. Materials are
 * validated against MaterialBlueprintSchema at the request boundary.
 */
export const PlanCampaignRequestSchema = z.object({
  materials: z
    .array(MaterialBlueprintSchema)
    .min(1, "at least one material is required"),
  options: CampaignPlannerOptionsSchema,
});

export type CampaignPlannerOptions = z.infer<typeof CampaignPlannerOptionsSchema>;
export type PlanCampaignRequest = z.infer<typeof PlanCampaignRequestSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Provider metadata for observability. Never contains secrets. */
export interface PlanCampaignMeta {
  provider: string;
  model: string;
  latencyMs: number;
  /** Non-blocking planning warnings (see Phase 2 / planner-validator). */
  warnings: ValidationError[];
}

/** Successful provider response. */
export interface PlanCampaignResponse {
  blueprint: CampaignBlueprint;
  meta: PlanCampaignMeta;
}

/**
 * Standardized planner error codes.
 *
 * INVALID_REQUEST        — request or material structure invalid.
 * DUPLICATE_MATERIAL_ID  — two materials share the same material_id.
 * DUPLICATE_CONCEPT_ID   — concept_id is not globally unique across materials.
 * INVALID_PREREQUISITE_REF — a concept prerequisite points to an unknown concept.
 * PREREQUISITE_CYCLE     — cross-material prerequisites form a cycle.
 * REQUIRED_KNOWLEDGE_ORDER — required_knowledge is not satisfiable by earlier stories.
 * PROVIDER_UNAVAILABLE   — provider could not be reached / is not configured.
 * OUTPUT_PARSE_FAILED    — provider output was not valid JSON / schema.
 * VALIDATION_FAILED      — provider output failed schema or semantic validation.
 * UNKNOWN                — unexpected internal error.
 */
export type CampaignPlannerErrorCode =
  | "INVALID_REQUEST"
  | "DUPLICATE_MATERIAL_ID"
  | "DUPLICATE_CONCEPT_ID"
  | "INVALID_PREREQUISITE_REF"
  | "PREREQUISITE_CYCLE"
  | "REQUIRED_KNOWLEDGE_ORDER"
  | "PROVIDER_UNAVAILABLE"
  | "OUTPUT_PARSE_FAILED"
  | "VALIDATION_FAILED"
  | "UNKNOWN";

/** Planner error — never thrown for expected failures, always returned. */
export interface PlanCampaignError {
  code: CampaignPlannerErrorCode;
  message: string;
  /** Optional provider-specific or validation detail. */
  detail?: unknown;
}

/** Union type for handling results without exceptions. */
export type PlanCampaignResult =
  | { ok: true; value: PlanCampaignResponse }
  | { ok: false; error: PlanCampaignError };

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

/**
 * Provider interface — future real providers MUST implement this.
 *
 * The provider is responsible for producing a candidate CampaignBlueprint.
 * The service layer is responsible for request validation, output parsing and
 * semantic validation. Providers MUST NOT throw for expected failures.
 */
export interface ICampaignPlannerProvider {
  /** Unique provider identifier. Never a secret. */
  readonly id: AIProviderId;
  /** Model name used by this provider instance. */
  readonly model: string;

  /**
   * Plan a campaign from materials and options.
   * MUST NOT throw — return PlanCampaignResult.
   * MUST be deterministic when provider = "dummy".
   */
  planCampaign(request: PlanCampaignRequest): Promise<PlanCampaignResult>;

  /** Optional health check. */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Convenience re-exports (avoid duplicate type definitions elsewhere)
// ---------------------------------------------------------------------------

export type { CampaignBlueprint, Genre };
