/**
 * Dummy Story Generator Provider — Layer 3 (M9)
 *
 * The only active provider in the dummy-first architecture.
 * Produces deterministic content from genre templates + material text.
 * No external API calls, no SDK, no randomness, no wall-clock time.
 *
 * Implements IStoryGeneratorProvider from story-generator-types.ts.
 */
import type {
  IStoryGeneratorProvider,
  GenerateStoryRequest,
  GenerateStoryResult,
  GenerateStoryResponse,
  GenerateStoryMeta,
} from "@/lib/ai/story-generator-types";
import { buildStoryBlueprint } from "@/lib/ai/story-generator-engine";
import { validateGeneratedStory } from "@/lib/validation/generator-validator";

const PROVIDER_ID = "dummy" as const;
const MODEL_NAME = "deterministic-template-v1";

/** Build the provider metadata object. */
function meta(latencyMs: number, warnings: GenerateStoryResponse["meta"]["warnings"]): GenerateStoryMeta {
  return { provider: PROVIDER_ID, model: MODEL_NAME, latencyMs, warnings };
}

/** The dummy provider instance. */
export const dummyStoryGeneratorProvider: IStoryGeneratorProvider = {
  id: PROVIDER_ID,
  model: MODEL_NAME,

  async generateStory(request: GenerateStoryRequest): Promise<GenerateStoryResult> {
    const start = Date.now();

    // 1. Delegate structural generation to the pure engine.
    const engineResult = buildStoryBlueprint(request);
    if (!engineResult.ok) {
      return {
        ok: false,
        error: {
          code: engineResult.code,
          message: engineResult.message,
          detail: engineResult.detail,
        },
      };
    }

    // 2. Semantic validation of the generated output.
    const { story: entry, material } = request;
    const validationResult = validateGeneratedStory(engineResult.blueprint, material, {
      entry,
      previousStories: [],
    });

    if (!validationResult.valid) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "Generated story failed semantic validation.",
          detail: validationResult.errors,
        },
      };
    }

    // 3. Combine engine warnings with any validation warnings (none currently).
    const allWarnings = [...engineResult.warnings];

    return {
      ok: true,
      value: {
        blueprint: engineResult.blueprint,
        meta: meta(Date.now() - start, allWarnings),
      },
    };
  },

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: "dummy provider always available" };
  },
};

/** Type-only export for consumers that need the provider type. */
export type DummyStoryGeneratorProvider = typeof dummyStoryGeneratorProvider;