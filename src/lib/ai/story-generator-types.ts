/**
 * Story Generator Types — Layer 3 (M9)
 *
 * Defines the contract between the application and story generation providers.
 *
 * Design notes:
 *   - The generator consumes ONE campaign story entry plus the campaign
 *     blueprint it belongs to and the material that entry references.
 *   - It produces exactly one StoryBlueprint that the existing, unmodified
 *     game engine can play.
 *   - Real AI providers are deferred. DummyStoryGeneratorProvider is the only
 *     active implementation; future providers MUST implement
 *     IStoryGeneratorProvider.
 *   - Providers supply CONTENT. Deterministic structure (IDs, scene chain,
 *     knowledge mappings) and all validation remain application-owned.
 *   - All types are serializable and server-side only.
 */

import { z } from "zod";
import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";
import { MaterialBlueprintSchema } from "@/lib/ai/schemas/material.schema";
import { StorySummaryEntrySchema } from "@/lib/ai/schemas/campaign.schema";
import type { AIProviderId } from "@/lib/ai/types";
import type { CampaignBlueprint, StorySummaryEntry } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import type { ValidationError } from "@/lib/validation/story-validator";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** A compact snapshot of a previously completed story, for continuity. */
export const PreviousStorySummarySchema = z.object({
  story_id: z.string().min(1, "story_id must not be empty"),
  title: z.string().min(1, "title must not be empty"),
  outcome_description: z.string(),
  world_state_snapshot: z.record(z.string(), z.number()),
  relationship_snapshot: z.record(z.string(), z.number()),
});

/** Story-level creative options supplied by the caller. */
export const StoryGeneratorOptionsSchema = z.object({
  /** Number of concepts to teach per chapter. Defaults to all concepts in one chapter. */
  conceptsPerChapter: z.number().int().min(1).optional(),
  /** Reserved for future real providers. Ignored by the dummy provider. */
  customInstructions: z.string().optional(),
  /** Optional language hint for future providers. Ignored by the dummy provider. */
  language: z.string().optional(),
});

/**
 * Story Generator request — ONE story at a time.
 *
 * `story` must be an entry of `campaign.story_sequence`, and `material` must
 * be the material that entry references (`story.material_id`). Both are
 * validated structurally here and semantically by the service.
 */
export const GenerateStoryRequestSchema = z.object({
  campaign: CampaignBlueprintSchema,
  story: StorySummaryEntrySchema,
  material: MaterialBlueprintSchema,
  /** Optional continuity context from earlier completed stories. */
  previousSummaries: z.array(PreviousStorySummarySchema).optional(),
  /** Optional story-level options. */
  options: StoryGeneratorOptionsSchema.optional(),
});

export type PreviousStorySummary = z.infer<typeof PreviousStorySummarySchema>;
export type StoryGeneratorOptions = z.infer<typeof StoryGeneratorOptionsSchema>;
export type GenerateStoryRequest = z.infer<typeof GenerateStoryRequestSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Provider metadata for observability. Never contains secrets. */
export interface GenerateStoryMeta {
  provider: string;
  model: string;
  latencyMs: number;
  /** Non-blocking generator warnings. */
  warnings: ValidationError[];
}

/** Successful provider response. */
export interface GenerateStoryResponse {
  blueprint: StoryBlueprint;
  meta: GenerateStoryMeta;
}

/**
 * Standardized story generator error codes.
 *
 * INVALID_REQUEST        — request structure invalid.
 * STORY_NOT_IN_CAMPAIGN  — story entry is not part of campaign.story_sequence.
 * MATERIAL_MISMATCH      — supplied material_id does not match story.material_id.
 * CONCEPT_COVERAGE       — a concept in the material has no learning+test pairing,
 *                          or a required_knowledge concept is untestable.
 * INVALID_CONCEPT_REF    — a concept reference does not resolve to the material.
 * PROVIDER_UNAVAILABLE   — provider could not be reached / is not configured.
 * OUTPUT_PARSE_FAILED    — provider output was not valid JSON / schema.
 * VALIDATION_FAILED      — provider output failed schema or semantic validation.
 * UNKNOWN                — unexpected internal error.
 */
export type StoryGeneratorErrorCode =
  | "INVALID_REQUEST"
  | "STORY_NOT_IN_CAMPAIGN"
  | "MATERIAL_MISMATCH"
  | "CONCEPT_COVERAGE"
  | "INVALID_CONCEPT_REF"
  | "PROVIDER_UNAVAILABLE"
  | "OUTPUT_PARSE_FAILED"
  | "VALIDATION_FAILED"
  | "UNKNOWN";

/** Generator error — never thrown for expected failures, always returned. */
export interface GenerateStoryError {
  code: StoryGeneratorErrorCode;
  message: string;
  /** Optional provider-specific or validation detail. */
  detail?: unknown;
}

/** Union type for handling results without exceptions. */
export type GenerateStoryResult =
  | { ok: true; value: GenerateStoryResponse }
  | { ok: false; error: GenerateStoryError };

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

/**
 * Provider interface — future real providers MUST implement this.
 *
 * The provider is responsible for producing a candidate StoryBlueprint.
 * The service layer is responsible for request validation, output parsing and
 * semantic validation. Providers MUST NOT throw for expected failures.
 * Providers MUST NEVER decide game outcomes: puzzle correctness is evaluated
 * exclusively by the game engine (src/lib/game/answer-validator.ts).
 */
export interface IStoryGeneratorProvider {
  /** Unique provider identifier. Never a secret. */
  readonly id: AIProviderId;
  /** Model name used by this provider instance. */
  readonly model: string;

  /**
   * Generate a story for a single campaign entry.
   * MUST NOT throw — return GenerateStoryResult.
   * MUST be deterministic when provider = "dummy".
   */
  generateStory(request: GenerateStoryRequest): Promise<GenerateStoryResult>;

  /** Optional health check. */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Service-level request context (post-validation)
// ---------------------------------------------------------------------------

/**
 * The validated context the engine/validator work with. Produced by the
 * service after it verifies `story ∈ campaign.story_sequence` and
 * `material.material_id === story.material_id`.
 */
export interface StoryGenerationContext {
  campaign: CampaignBlueprint;
  entry: StorySummaryEntry;
  material: MaterialBlueprint;
  previousSummaries: PreviousStorySummary[];
  options: StoryGeneratorOptions;
}

export type { CampaignBlueprint, StorySummaryEntry, MaterialBlueprint, StoryBlueprint };
