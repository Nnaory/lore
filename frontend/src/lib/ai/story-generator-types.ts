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
 *   - The Gemini provider is the only real implementation; future providers
 *     MUST implement IStoryGeneratorProvider. With no LLM configured the
 *     registry returns an unavailable provider (PROVIDER_NOT_CONFIGURED).
 *   - Providers supply CONTENT. Deterministic structure (IDs, scene chain,
 *     knowledge mappings) and all validation remain application-owned.
 *   - All types are serializable and server-side only.
 */

import type { z } from "zod";
import {
  PreviousStorySummarySchema,
  StoryGeneratorOptionsSchema,
  GenerateStoryRequestSchema,
} from "@/lib/contracts/ai-requests";
import type { AIProviderId } from "@/lib/ai/types";
import type { CampaignBlueprint, StorySummaryEntry } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import type { ValidationError } from "@/lib/validation/story-validator";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export { PreviousStorySummarySchema, StoryGeneratorOptionsSchema, GenerateStoryRequestSchema };

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
 * PROVIDER_UNAVAILABLE   — provider could not be reached.
 * PROVIDER_NOT_CONFIGURED — no AI provider/API key is set up on this server.
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
  | "PROVIDER_NOT_CONFIGURED"
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
   */
  generateStory(request: GenerateStoryRequest): Promise<GenerateStoryResult>;

  /** Optional health check. */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

export type { CampaignBlueprint, StorySummaryEntry, MaterialBlueprint, StoryBlueprint };
