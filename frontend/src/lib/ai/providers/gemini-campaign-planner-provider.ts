/**
 * Gemini Campaign Planner provider (Layer 2)
 *
 * Structure comes from the deterministic planning engine (story order,
 * IDs, required_knowledge, outcomes). Gemini only rewrites the creative
 * fields — campaign title, premise, setting, tone, world rules, character
 * names/roles/descriptions, and each story's title/purpose/conflict.
 *
 * If Gemini fails or returns something unusable, the engine's template text
 * is kept and a warning is attached: planning never fails because of the
 * creative step.
 */

import { z } from "zod";
import type {
  ICampaignPlannerProvider,
  PlanCampaignRequest,
  PlanCampaignResult,
} from "@/lib/ai/campaign-planner-types";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { ValidationError } from "@/lib/validation/story-validator";
import { buildCampaignBlueprint } from "@/lib/ai/campaign-planner-engine";
import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";
import { generateJson, type GeminiConfig } from "./gemini-client";

const text = z.string().trim().min(1).max(600);

const CreativeSchema = z.object({
  title: text.optional(),
  premise: text.optional(),
  setting: text.optional(),
  tone: z.string().trim().min(1).max(60).optional(),
  main_conflict: text.optional(),
  world_rules: z.array(text).max(6).optional(),
  characters: z
    .array(z.object({ name: z.string().trim().min(1).max(60), role: z.string().trim().min(1).max(60), description: text }))
    .optional(),
  stories: z
    .array(z.object({ story_id: z.string(), title: text.optional(), purpose: text.optional(), main_conflict: text.optional() }))
    .optional(),
});

type Creative = z.infer<typeof CreativeSchema>;

const GENRE_LABEL: Record<string, string> = {
  fantasy: "fantasy (ancient realms, fading magic)",
  modern: "non-fiction / modern day (the real world, today)",
  science_fiction: "science fiction (research stations, future technology)",
  mystery: "mystery",
  historical: "historical",
  survival: "survival",
  horror: "atmospheric horror (no gore)",
  custom: "a genre chosen by the player",
};

function buildPrompt(skeleton: CampaignBlueprint, request: PlanCampaignRequest): string {
  const materials = new Map(request.materials.map((m) => [m.material_id, m]));
  const stories = skeleton.story_sequence.map((s) => {
    const m = materials.get(s.material_id);
    return {
      story_id: s.story_id,
      material_title: m?.title,
      learning_objectives: m?.learning_objectives,
      concepts: m?.concepts.map((c) => c.name),
    };
  });
  const language = request.options.language === "id" ? "Indonesian" : "English";
  return [
    `Design the world for an interactive learning story. Genre: ${GENRE_LABEL[skeleton.genre] ?? skeleton.genre}.`,
    `Write every field in ${language}.`,
    request.options.customInstructions ? `Player's wishes (follow them unless unsafe): ${request.options.customInstructions}` : "",
    "",
    "Stories (one per learning material, in this order):",
    JSON.stringify(stories, null, 2),
    "",
    `Characters: exactly ${skeleton.characters.length}. Character 1 is a Guide who frames challenges; character 2 is a Companion who learns alongside the player.`,
    "",
    "Return JSON with this shape:",
    `{"title": string, "premise": string (2-3 sentences), "setting": string (one phrase), "tone": string (one or two words),`,
    ` "main_conflict": string (one sentence), "world_rules": string[] (2-4 rules; the world's logic must match the material),`,
    ` "characters": [{"name": string, "role": string, "description": string}],`,
    ` "stories": [{"story_id": string (copy from above), "title": string, "purpose": string (one sentence), "main_conflict": string (one sentence, where the concepts are needed to solve it)}]}`,
    "",
    "Rules: the learning content must stay academically correct; the world only frames it. Keep names original (no existing franchises).",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Overlay valid creative fields onto the engine's blueprint; structure is untouched. */
export function mergeCreativeFields(skeleton: CampaignBlueprint, creative: Creative): CampaignBlueprint {
  const storyById = new Map((creative.stories ?? []).map((s) => [s.story_id, s]));
  return {
    ...skeleton,
    title: creative.title ?? skeleton.title,
    premise: creative.premise ?? skeleton.premise,
    setting: creative.setting ?? skeleton.setting,
    tone: creative.tone ?? skeleton.tone,
    main_conflict: creative.main_conflict ?? skeleton.main_conflict,
    world_rules: creative.world_rules && creative.world_rules.length > 0 ? creative.world_rules : skeleton.world_rules,
    characters: skeleton.characters.map((c, i) => {
      const written = creative.characters?.[i];
      return written ? { ...c, name: written.name, role: written.role, description: written.description } : c;
    }),
    story_sequence: skeleton.story_sequence.map((s) => {
      const written = storyById.get(s.story_id);
      return written
        ? {
            ...s,
            title: written.title ?? s.title,
            purpose: written.purpose ?? s.purpose,
            main_conflict: written.main_conflict ?? s.main_conflict,
          }
        : s;
    }),
  };
}

export class GeminiCampaignPlannerProvider implements ICampaignPlannerProvider {
  readonly id = "google" as const;
  readonly model: string;

  constructor(
    private readonly config: GeminiConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.model = config.models[0];
  }

  async planCampaign(request: PlanCampaignRequest): Promise<PlanCampaignResult> {
    const start = Date.now();
    const engine = buildCampaignBlueprint(request.materials, request.options);
    if (!engine.ok) {
      return { ok: false, error: { code: engine.code, message: engine.message, detail: engine.detail } };
    }

    const warnings: ValidationError[] = [...engine.warnings];
    let blueprint = engine.blueprint;
    let model = "deterministic-template";

    const result = await generateJson(
      { system: "You are a narrative designer for educational games. Respond with JSON only.", prompt: buildPrompt(engine.blueprint, request), maxOutputTokens: 2_000, temperature: 0.9 },
      this.config,
      this.fetchImpl
    );

    const creative = result.ok ? CreativeSchema.safeParse(result.json) : null;
    if (result.ok && creative?.success) {
      const merged = mergeCreativeFields(engine.blueprint, creative.data);
      if (CampaignBlueprintSchema.safeParse(merged).success) {
        blueprint = merged;
        model = result.model;
      }
    }
    if (model === "deterministic-template") {
      warnings.push({
        code: "CREATIVE_FALLBACK",
        message: result.ok
          ? "The AI world design was unusable; template campaign text was used."
          : `The AI provider was unavailable (${result.code}); template campaign text was used.`,
        path: "campaign",
      });
    }

    return {
      ok: true,
      value: { blueprint, meta: { provider: this.id, model, latencyMs: Date.now() - start, warnings } },
    };
  }
}
