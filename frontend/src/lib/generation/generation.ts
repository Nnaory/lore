/**
 * Staged campaign generation — client side
 *
 * Calls the three AI endpoints one at a time so the player sees real
 * progress, reviews the extracted concepts before any story is written,
 * and can retry a failed stage without redoing earlier ones:
 *
 *   analyzing  → POST /api/v1/ai/analyze-material   (Layer 1)
 *   reviewing  → player keeps/removes concepts      (no request)
 *   planning   → POST /api/v1/ai/plan-campaign      (Layer 2)
 *   writing    → POST /api/v1/ai/generate-story     (Layer 3, once per story)
 *   done
 *
 * The endpoints are served by the FastAPI backend (see ai-endpoints.ts).
 *
 * Pure reducer + small async API helpers; the React hook lives in
 * use-generation.ts.
 */

import { z } from "zod";
import { MaterialBlueprintSchema } from "@/lib/contracts/schemas/material.schema";
import { CampaignBlueprintSchema } from "@/lib/contracts/schemas/campaign.schema";
import { StoryBlueprintSchema } from "@/lib/contracts/schemas/story.schema";
import type { GenerationRequest } from "@/lib/contracts/generation-request";
import type { MaterialBlueprint } from "@/lib/types/material";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { PreviousStorySummary } from "@/lib/types/game";
import { BUILD_MESSAGES, messageForCode } from "@/lib/contracts/error-messages";
import { aiUrl } from "./ai-endpoints";

export type GenerationStage = "analyzing" | "reviewing" | "planning" | "writing" | "done";

export type GenerationState = {
  stage: GenerationStage;
  /** running: a request is in flight; waiting: the player must act; failed: see `error`. */
  status: "running" | "waiting" | "failed";
  error: string | null;
  material: MaterialBlueprint | null;
  selectedConceptIds: string[];
  campaign: CampaignBlueprint | null;
  stories: Record<string, StoryBlueprint>;
};

export const initialGenerationState: GenerationState = {
  stage: "analyzing",
  status: "running",
  error: null,
  material: null,
  selectedConceptIds: [],
  campaign: null,
  stories: {},
};

export type GenerationAction =
  | { type: "reset" }
  | { type: "stage_started"; stage: Exclude<GenerationStage, "reviewing" | "done"> }
  | { type: "material_ready"; material: MaterialBlueprint }
  | { type: "concept_toggled"; conceptId: string }
  | { type: "campaign_ready"; campaign: CampaignBlueprint }
  | { type: "story_ready"; story: StoryBlueprint }
  | { type: "all_stories_ready" }
  | { type: "failed"; message: string };

export function generationReducer(state: GenerationState, action: GenerationAction): GenerationState {
  switch (action.type) {
    case "reset":
      return initialGenerationState;
    case "stage_started":
      return { ...state, stage: action.stage, status: "running", error: null };
    case "material_ready":
      return {
        ...state,
        material: action.material,
        selectedConceptIds: action.material.concepts.map((c) => c.concept_id),
        stage: "reviewing",
        status: "waiting",
      };
    case "concept_toggled": {
      if (state.stage !== "reviewing") return state;
      const has = state.selectedConceptIds.includes(action.conceptId);
      return {
        ...state,
        selectedConceptIds: has
          ? state.selectedConceptIds.filter((id) => id !== action.conceptId)
          : [...state.selectedConceptIds, action.conceptId],
      };
    }
    case "campaign_ready":
      return { ...state, campaign: action.campaign };
    case "story_ready":
      return { ...state, stories: { ...state.stories, [action.story.story_id]: action.story } };
    case "all_stories_ready":
      return { ...state, stage: "done", status: "waiting" };
    case "failed":
      return { ...state, status: "failed", error: action.message };
  }
}

/**
 * The material with only the selected concepts. Prerequisites pointing at a
 * removed concept are dropped so the planner never sees a dangling reference.
 */
export function selectConcepts(material: MaterialBlueprint, conceptIds: readonly string[]): MaterialBlueprint {
  const keep = new Set(conceptIds);
  return {
    ...material,
    concepts: material.concepts
      .filter((c) => keep.has(c.concept_id))
      .map((c) => ({ ...c, prerequisites: c.prerequisites.filter((p) => keep.has(p)) })),
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export type ApiResult<T> = { ok: true; value: T } | { ok: false; message: string };

const ErrorEnvelope = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });
const SuccessEnvelope = z.object({ ok: z.literal(true), data: z.object({ blueprint: z.unknown() }) });

/** POST JSON to an AI route and validate `data.blueprint` with `schema`. */
export async function postBlueprint<T>(
  url: string,
  body: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<ApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch {
    return { ok: false, message: BUILD_MESSAGES.network };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, message: BUILD_MESSAGES.unexpected };
  }

  const failure = ErrorEnvelope.safeParse(json);
  if (failure.success) return { ok: false, message: messageForCode(failure.data.error.code) };

  const envelope = SuccessEnvelope.safeParse(json);
  const blueprint = envelope.success ? schema.safeParse(envelope.data.data.blueprint) : null;
  if (!response.ok || !blueprint?.success) return { ok: false, message: BUILD_MESSAGES.unexpected };
  return { ok: true, value: blueprint.data };
}

export type GenerationInput = GenerationRequest;

export const api = {
  analyze: (input: GenerationInput, o?: { signal?: AbortSignal; fetchImpl?: typeof fetch }) =>
    postBlueprint(aiUrl("analyze-material"), input.materials[0], MaterialBlueprintSchema, o),

  plan: (input: GenerationInput, material: MaterialBlueprint, o?: { signal?: AbortSignal; fetchImpl?: typeof fetch }) =>
    postBlueprint(
      aiUrl("plan-campaign"),
      { materials: [material], options: input.campaignOptions },
      CampaignBlueprintSchema,
      o
    ),

  story: (
    input: GenerationInput,
    campaign: CampaignBlueprint,
    storyId: string,
    material: MaterialBlueprint,
    previousSummaries: PreviousStorySummary[],
    o?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
  ) =>
    postBlueprint(
      aiUrl("generate-story"),
      {
        campaign,
        story: campaign.story_sequence.find((s) => s.story_id === storyId),
        material,
        previousSummaries,
        options: input.storyOptions,
      },
      StoryBlueprintSchema,
      o
    ),
};
