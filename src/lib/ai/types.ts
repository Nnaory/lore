/**
 * AI Provider Types — Material Intelligence (Layer 1)
 *
 * Defines the contract between the application and AI providers.
 * Future real providers MUST implement IMaterialIntelligenceProvider.
 * All types are serializable and server-side only.
 */

import type { MaterialBlueprint } from "@/lib/types/material";

/** Supported AI provider identifiers. */
export type AIProviderId = "dummy" | "openai" | "anthropic" | "google";

/** Input for Material Intelligence (Layer 1). */
export interface AnalyzeMaterialRequest {
  /** Raw user-provided learning material text. */
  material: string;
  /** Optional learning context (grade level, language, etc.). */
  context?: Record<string, unknown>;
  /** Optional genre hint to influence framing. */
  genre?: string;
}

/** Successful provider response. */
export interface AnalyzeMaterialResponse {
  /** The structured MaterialBlueprint. */
  blueprint: MaterialBlueprint;
  /** Provider-specific metadata (tokens used, model, latency, etc.). */
  meta: ProviderMeta;
}

/** Provider error — never throws, always returned. */
export interface AnalyzeMaterialError {
  code: AIErrorCode;
  message: string;
  /** Optional provider-specific detail for debugging. */
  detail?: unknown;
}

/** Union type for handling results without exceptions. */
export type AnalyzeMaterialResult =
  | { ok: true; value: AnalyzeMaterialResponse }
  | { ok: false; error: AnalyzeMaterialError };

/** Standardized error codes. */
export type AIErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "OUTPUT_PARSE_FAILED"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNKNOWN";

/** Provider metadata for observability. */
export interface ProviderMeta {
  provider: AIProviderId;
  model: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** Provider interface — future real providers MUST implement this. */
export interface IMaterialIntelligenceProvider {
  /** Unique provider identifier. */
  readonly id: AIProviderId;
  /** Model name used by this provider instance. */
  readonly model: string;

  /**
   * Analyze raw material and return a MaterialBlueprint.
   * MUST NOT throw — return AnalyzeMaterialResult.
   * MUST be deterministic when provider = "dummy".
   */
  analyzeMaterial(request: AnalyzeMaterialRequest): Promise<AnalyzeMaterialResult>;

  /** Optional health check. */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

/** Request validation schema (Zod) — used by API route. */
import { z } from "zod";

export const AnalyzeMaterialRequestSchema = z.object({
  material: z.string().min(10, "material must be at least 10 characters"),
  context: z.record(z.unknown()).optional(),
  genre: z.string().optional(),
});

export type AnalyzeMaterialRequestInput = z.infer<typeof AnalyzeMaterialRequestSchema>;