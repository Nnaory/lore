/**
 * Story Generator Service — Layer 3 (M9)
 *
 * Orchestrates the full generation pipeline:
 *   1. Request validation (structure + cross-refs)
 *   2. Provider call (dummy or future real)
 *   3. Schema validation (Zod)
 *   4. Semantic validation (generator-validator)
 *   5. Returns discriminated union — never throws for expected failures.
 *
 * This is the ONLY public entry point for story generation.
 * All callers go through generateStory().
 */

import { GenerateStoryRequestSchema } from "@/lib/ai/story-generator-types";
import type {
  GenerateStoryRequest,
  GenerateStoryResult,
  IStoryGeneratorProvider,
  PreviousStorySummary,
  StoryGeneratorOptions,
  StoryGeneratorErrorCode,
} from "@/lib/ai/story-generator-types";
import { getStoryGeneratorProviderCached } from "@/lib/ai/providers";
import { validateGeneratedStory } from "@/lib/validation/generator-validator";
import { StoryBlueprintSchema } from "@/lib/ai/schemas/story.schema";
import type { CampaignBlueprint, StorySummaryEntry } from "@/lib/types/campaign";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { StoryBlueprint } from "@/lib/types/story";
import type { ValidationError } from "@/lib/validation/story-validator";

// ---------------------------------------------------------------------------
// Internal context (post-request-validation)
// ---------------------------------------------------------------------------

interface ValidatedContext {
  campaign: CampaignBlueprint;
  entry: StorySummaryEntry;
  material: MaterialBlueprint;
  previousSummaries: PreviousStorySummary[];
  options: StoryGeneratorOptions;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** Validate the raw request shape and cross-references. */
function validateRequest(
  raw: unknown
): { ok: true; value: ValidatedContext } | { ok: false; error: { code: StoryGeneratorErrorCode; message: string; detail?: unknown } } {
  // 1. Zod structural validation
  const parsed = GenerateStoryRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST" as StoryGeneratorErrorCode,
        message: "Request failed structural validation.",
        detail: parsed.error.flatten(),
      },
    };
  }

  const { campaign, story: entry, material, previousSummaries, options } = parsed.data;

  // 2. Story must be in campaign
  const entryInCampaign = campaign.story_sequence.some(
    (s) => s.story_id === entry.story_id
  );
  if (!entryInCampaign) {
    return {
      ok: false,
      error: {
        code: "STORY_NOT_IN_CAMPAIGN" as StoryGeneratorErrorCode,
        message: `Story "${entry.story_id}" is not part of campaign "${campaign.campaign_id}".`,
      },
    };
  }

  // 3. Material must match entry
  if (entry.material_id !== material.material_id) {
    return {
      ok: false,
      error: {
        code: "MATERIAL_MISMATCH" as StoryGeneratorErrorCode,
        message: `Story "${entry.story_id}" references material "${entry.material_id}" but material "${material.material_id}" was supplied.`,
      },
    };
  }

  return {
    ok: true,
    value: {
      campaign,
      entry,
      material,
      previousSummaries: previousSummaries ?? [],
      options: options ?? {},
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

/** Run the provider and validate its output. */
async function runPipeline(
  ctx: ValidatedContext,
  provider: IStoryGeneratorProvider
): Promise<GenerateStoryResult> {
  // 1. Provider generates candidate blueprint
  const providerResult = await provider.generateStory({
    campaign: ctx.campaign,
    story: ctx.entry,
    material: ctx.material,
    previousSummaries: ctx.previousSummaries,
    options: ctx.options,
  });

  if (!providerResult.ok) return providerResult;

  // 2. Zod schema validation (defense in depth — engine should already produce valid)
  const schemaCheck = StoryBlueprintSchema.safeParse(providerResult.value.blueprint);
  if (!schemaCheck.success) {
    return {
      ok: false,
      error: {
        code: "OUTPUT_PARSE_FAILED" as StoryGeneratorErrorCode,
        message: "Provider output failed StoryBlueprint schema validation.",
        detail: schemaCheck.error.flatten(),
      },
    };
  }

  // 3. Semantic validation (generator-specific rules)
  const semanticResult = validateGeneratedStory(
    providerResult.value.blueprint,
    ctx.material,
    {
      entry: ctx.entry,
      previousStories: [],
    }
  );

  if (!semanticResult.valid) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED" as StoryGeneratorErrorCode,
        message: "Generated story failed semantic validation.",
        detail: semanticResult.errors,
      },
    };
  }

  // 4. Merge warnings
  // semanticResult.valid is true here (early return above), so no errors to filter.
  const allWarnings: ValidationError[] = [
    ...providerResult.value.meta.warnings,
  ];

  return {
    ok: true,
    value: {
      blueprint: providerResult.value.blueprint,
      meta: {
        ...providerResult.value.meta,
        warnings: allWarnings,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a single story for a campaign entry.
 *
 * This is the main entry point. It validates the request, delegates to the
 * configured provider, validates the output, and returns a discriminated
 * union. NEVER throws for expected failures.
 *
 * @param raw - Raw request object (will be validated)
 * @param providerOverride - Optional provider for testing; defaults to cached registry provider
 */
export async function generateStory(
  raw: unknown,
  providerOverride?: IStoryGeneratorProvider
): Promise<GenerateStoryResult> {
  // 1. Validate request
  const validated = validateRequest(raw);
  if (!validated.ok) return validated;

  // 2. Get provider
  const provider = providerOverride ?? getStoryGeneratorProviderCached();

  // 3. Execute pipeline
  return runPipeline(validated.value, provider);
}

// ---------------------------------------------------------------------------
// Batch generation helper (for campaign-level tooling)
// ---------------------------------------------------------------------------

export interface GenerateCampaignStoriesResult {
  ok: boolean;
  stories: Map<string, StoryBlueprint>;
  errors: Map<string, { code: StoryGeneratorErrorCode; message: string; detail?: unknown }>;
}

/**
 * Generate all stories in a campaign sequentially.
 * Stops on first failure unless `continueOnError` is true.
 * Used by dev tooling / campaign import scripts.
 */
export async function generateCampaignStories(
  campaign: CampaignBlueprint,
  materials: MaterialBlueprint[],
  previousSummaries: PreviousStorySummary[] = [],
  options: StoryGeneratorOptions = {},
  continueOnError = false,
  providerOverride?: IStoryGeneratorProvider
): Promise<GenerateCampaignStoriesResult> {
  const materialById = new Map(materials.map((m) => [m.material_id, m]));
  const stories = new Map<string, StoryBlueprint>();
  type StoryGenError = { code: StoryGeneratorErrorCode; message: string; detail?: unknown };
  const errors = new Map<string, StoryGenError>();
  const summariesSoFar: PreviousStorySummary[] = [...previousSummaries];

  for (const entry of campaign.story_sequence) {
    const material = materialById.get(entry.material_id);
    if (!material) {
      const err = {
        code: "MATERIAL_MISMATCH" as StoryGeneratorErrorCode,
        message: `Material "${entry.material_id}" not found for story "${entry.story_id}".`,
      };
      errors.set(entry.story_id, err);
      if (!continueOnError) break;
      continue;
    }

    const result = await generateStory(
      {
        campaign,
        story: entry,
        material,
        previousSummaries: summariesSoFar,
        options,
      },
      providerOverride
    );

    if (result.ok) {
      stories.set(entry.story_id, result.value.blueprint);
      // Build a summary for the next story's continuity context
      const cs = result.value.blueprint.continuity_summary;
      if (cs) {
        summariesSoFar.push({
          story_id: entry.story_id,
          title: entry.title,
          outcome_description: cs.outcome_description,
          world_state_snapshot: cs.world_state_snapshot,
          relationship_snapshot: cs.relationship_snapshot,
        });
      }
    } else {
      // result.ok is false here, so result is narrowed to { ok: false; error: GenerateStoryError }
      const err = result.error;
      errors.set(entry.story_id, err);
      if (!continueOnError) break;
    }
  }

  return {
    ok: errors.size === 0,
    stories,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Re-export types for consumers
// ---------------------------------------------------------------------------
export type {
  GenerateStoryRequest,
  GenerateStoryResult,
  PreviousStorySummary,
  StoryGeneratorOptions,
  ValidatedContext,
};