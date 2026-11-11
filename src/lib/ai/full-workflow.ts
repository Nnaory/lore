/**
 * Full AI Workflow Orchestration — M10
 *
 * Chains the complete AI pipeline:
 *   1. Material Intelligence (Layer 1) — raw text → MaterialBlueprint[]
 *   2. Campaign Planner (Layer 2) — MaterialBlueprint[] → CampaignBlueprint
 *   3. Story Generator (Layer 3) — CampaignBlueprint + MaterialBlueprint[] → StoryBlueprint[]
 *
 * This is the single entry point for end-to-end campaign generation.
 * All layers use their respective service interfaces; no internal details are bypassed.
 */

import { analyzeMaterial } from "@/lib/ai/material-intelligence";
import { planCampaign } from "@/lib/ai/campaign-planner";
import { generateCampaignStories, generateStory } from "@/lib/ai/story-generator-service";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { CampaignPlannerOptions } from "@/lib/ai/campaign-planner-types";
import type { StoryGeneratorOptions } from "@/lib/ai/story-generator-types";
import type { AnalyzeMaterialRequest } from "@/lib/ai/types";
import type { ValidationError } from "@/lib/validation/story-validator";
import { validateCampaign } from "@/lib/validation/campaign-validator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for the full workflow. */
export interface FullWorkflowInput {
  /** Raw learning materials to analyze. */
  materials: AnalyzeMaterialRequest[];
  /** Campaign-level creative options. */
  campaignOptions: CampaignPlannerOptions;
  /** Optional story-level generation options. */
  storyOptions?: StoryGeneratorOptions;
}

/** Result of a single material analysis. */
export interface MaterialAnalysisResult {
  materialId: string;
  ok: boolean;
  blueprint?: MaterialBlueprint;
  error?: { code: string; message: string; detail?: unknown };
}

/** Result of the full workflow. */
export interface FullWorkflowResult {
  ok: boolean;
  /** Successfully generated campaign blueprint (if planning succeeded). */
  campaign?: CampaignBlueprint;
  /** Map of story_id → generated StoryBlueprint (if story generation succeeded). */
  stories?: Map<string, StoryBlueprint>;
  /** Per-material analysis results. */
  materialResults: MaterialAnalysisResult[];
  /** Campaign planning result (if reached). */
  planningResult?: {
    ok: boolean;
    blueprint?: CampaignBlueprint;
    error?: { code: string; message: string; detail?: unknown };
    meta?: { provider: string; model: string; latencyMs: number; warnings: ValidationError[] };
  };
  /** Story generation results (if reached). */
  generationResult?: {
    ok: boolean;
    stories?: Map<string, StoryBlueprint>;
    errors?: Map<string, { code: string; message: string; detail?: unknown }>;
  };
  /** Aggregated warnings from all layers. */
  warnings: ValidationError[];
  /** Overall error if workflow failed before completion. */
  error?: { code: string; message: string; detail?: unknown };
}

// ---------------------------------------------------------------------------
// Full workflow orchestration
// ---------------------------------------------------------------------------

/**
 * Execute the complete AI pipeline: materials → campaign → stories.
 *
 * This function:
 * 1. Analyzes each material through Layer 1 (Material Intelligence)
 * 2. Plans the campaign through Layer 2 (Campaign Planner)
 * 3. Generates all stories through Layer 3 (Story Generator)
 * 4. Validates the final campaign against the game engine requirements
 *
 * Partial failures are captured explicitly. The result distinguishes between:
 * - Complete success (all layers ok)
 * - Material analysis failure (no campaign planned)
 * - Campaign planning failure (no stories generated)
 * - Story generation failure (campaign exists but some stories failed)
 *
 * @param input - Raw materials and generation options
 * @returns FullWorkflowResult with detailed per-layer outcomes
 */
export async function runFullWorkflow(
  input: FullWorkflowInput
): Promise<FullWorkflowResult> {
  const { materials: rawMaterials, campaignOptions, storyOptions = {} } = input;
  const allWarnings: ValidationError[] = [];
  const materialResults: MaterialAnalysisResult[] = [];

  // ============================================================
  // STEP 1: Material Intelligence (Layer 1)
  // ============================================================
  const materialBlueprints: MaterialBlueprint[] = [];

  for (const rawMaterial of rawMaterials) {
    const analysisResult = await analyzeMaterial(rawMaterial);

    if (!analysisResult.ok) {
      materialResults.push({
        materialId: rawMaterial.material ?? "unknown",
        ok: false,
        error: {
          code: analysisResult.code,
          message: analysisResult.message,
          detail: analysisResult.detail,
        },
      });
      continue;
    }

    materialBlueprints.push(analysisResult.blueprint);
    materialResults.push({
      materialId: analysisResult.blueprint.material_id,
      ok: true,
      blueprint: analysisResult.blueprint,
    });

    // Collect warnings
    allWarnings.push(...analysisResult.meta.warnings);
  }

  // If any material failed, we cannot proceed to planning
  const failedMaterials = materialResults.filter((r) => !r.ok);
  if (failedMaterials.length > 0) {
    return {
      ok: false,
      materialResults,
      planningResult: { ok: false, error: { code: "MATERIAL_ANALYSIS_FAILED", message: "One or more materials failed analysis" } },
      warnings: allWarnings,
      error: {
        code: "MATERIAL_ANALYSIS_FAILED",
        message: `${failedMaterials.length} of ${materialResults.length} materials failed analysis`,
        detail: failedMaterials.map((m) => m.error),
      },
    };
  }

  // ============================================================
  // STEP 2: Campaign Planner (Layer 2)
  // ============================================================
  const planningResult = await planCampaign({
    materials: materialBlueprints,
    options: campaignOptions,
  });

  if (!planningResult.ok) {
    return {
      ok: false,
      materialResults,
      planningResult: {
        ok: false,
        error: {
          code: planningResult.code,
          message: planningResult.message,
          detail: planningResult.detail,
        },
      },
      warnings: allWarnings,
      error: {
        code: planningResult.code,
        message: planningResult.message,
        detail: planningResult.detail,
      },
    };
  }

  const campaign = planningResult.blueprint;
  allWarnings.push(...planningResult.meta.warnings);

  // ============================================================
  // STEP 3: Story Generator (Layer 3)
  // ============================================================
  const generationResult = await generateCampaignStories(
    campaign,
    materialBlueprints,
    [], // no previous summaries for initial generation
    storyOptions,
    false, // stop on first error by default
  );

  allWarnings.push(...generationResult.errors.values().flatMap((e) => (e.detail as ValidationError[]) ?? []));

  // ============================================================
  // STEP 4: Final validation against game engine requirements
  // ============================================================
  const finalValidation = validateCampaign(campaign, materialBlueprints);
  if (!finalValidation.valid) {
    // Type guard: finalValidation is { valid: false; errors: ValidationError[] } here
    allWarnings.push(...finalValidation.errors);
  }

  const success = generationResult.ok && finalValidation.valid;

  // Extract validation errors with proper type narrowing
  const validationErrors = finalValidation.valid ? [] : finalValidation.errors;

  return {
    ok: success,
    campaign,
    stories: generationResult.stories,
    materialResults,
    planningResult: {
      ok: true,
      blueprint: campaign,
      meta: {
        provider: planningResult.meta.provider,
        model: planningResult.meta.model,
        latencyMs: planningResult.meta.latencyMs,
        warnings: planningResult.meta.warnings,
      },
    },
    generationResult: {
      ok: generationResult.ok,
      stories: generationResult.stories,
      errors: generationResult.errors,
    },
    warnings: allWarnings,
    error: success
      ? undefined
      : {
          code: generationResult.ok ? "CAMPAIGN_VALIDATION_FAILED" : "STORY_GENERATION_FAILED",
          message: generationResult.ok
            ? "Campaign generated but failed final validation"
            : `${generationResult.errors.size} story(s) failed generation`,
          detail: generationResult.ok ? validationErrors : Array.from(generationResult.errors.values()),
        },
  };
}

// ---------------------------------------------------------------------------
// Convenience: Generate a single story (for on-demand generation)
// ---------------------------------------------------------------------------

/**
 * Generate a single story for an already-planned campaign.
 * Useful when stories are generated on-demand during gameplay.
 *
 * @param campaign - The planned campaign blueprint
 * @param materials - All materials referenced by the campaign
 * @param storyId - The specific story to generate
 * @param previousSummaries - Continuity context from completed stories
 * @param options - Story generation options
 * @returns Single story generation result
 */
export async function generateSingleStory(
  campaign: CampaignBlueprint,
  materials: MaterialBlueprint[],
  storyId: string,
  previousSummaries: import("@/lib/types/game").PreviousStorySummary[] = [],
  options: StoryGeneratorOptions = {}
) {
  const entry = campaign.story_sequence.find((s) => s.story_id === storyId);
  if (!entry) {
    return {
      ok: false as const,
      error: { code: "STORY_NOT_IN_CAMPAIGN" as const, message: `Story "${storyId}" not found in campaign` },
    };
  }

  const material = materials.find((m) => m.material_id === entry.material_id);
  if (!material) {
    return {
      ok: false as const,
      error: { code: "MATERIAL_MISMATCH" as const, message: `Material "${entry.material_id}" not found for story "${storyId}"` },
    };
  }

  return generateStory(
    {
      campaign,
      story: entry,
      material,
      previousSummaries,
      options,
    }
  );
}

// ---------------------------------------------------------------------------
// Cache reset helpers (for testing)
// ---------------------------------------------------------------------------

import { resetProviderCache } from "@/lib/ai/providers";
import { resetCampaignPlannerCache } from "@/lib/ai/campaign-planner";
import { resetStoryGeneratorProviderCache } from "@/lib/ai/providers";

export function resetFullWorkflowCaches(): void {
  resetProviderCache();
  resetCampaignPlannerCache();
  resetStoryGeneratorProviderCache();
}