/**
 * Client call to build a playable campaign from the create form.
 *
 * POSTs to /api/ai/full-workflow and validates the response again in the
 * browser before the game engine sees it. Never throws: failures come back
 * as a message that can be shown to the user.
 */

import { z } from "zod";
import { CampaignBlueprintSchema } from "@/lib/ai/schemas/campaign.schema";
import { StoryBlueprintSchema } from "@/lib/ai/schemas/story.schema";
import type { FullWorkflowRequestBody } from "@/lib/ai/full-workflow-schema";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { StoryBlueprint } from "@/lib/types/story";

export type CampaignBuildResult =
  | { ok: true; campaign: CampaignBlueprint; stories: ReadonlyMap<string, StoryBlueprint> }
  | { ok: false; message: string };

const SuccessSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    campaign: CampaignBlueprintSchema,
    stories: z.record(z.string(), StoryBlueprintSchema),
  }),
});

const ErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string() }),
});

export const BUILD_MESSAGES = {
  network: "Couldn't reach the server. Check your connection and try again.",
  noConcepts: "We couldn't find learning concepts in this material. Try including more sections.",
  invalidRequest: "The material couldn't be sent. Try deselecting some sections, then try again.",
  storyFailed: "The story could not be built from this material. Try again, or change the selected sections.",
  busy: "The AI storyteller is busy right now. Wait a moment, then try again.",
  unexpected: "Something went wrong while building your story. Try again.",
} as const;

/** A user-facing message for an AI route error code. */
export function messageForCode(code: string): string {
  switch (code) {
    case "MATERIAL_ANALYSIS_FAILED":
      return BUILD_MESSAGES.noConcepts;
    case "PROVIDER_UNAVAILABLE":
    case "RATE_LIMITED":
    case "TIMEOUT":
      return BUILD_MESSAGES.busy;
    case "INVALID_REQUEST":
      return BUILD_MESSAGES.invalidRequest;
    case "STORY_GENERATION_FAILED":
    case "CAMPAIGN_VALIDATION_FAILED":
    case "VALIDATION_FAILED":
    case "OUTPUT_PARSE_FAILED":
      return BUILD_MESSAGES.storyFailed;
    default:
      return BUILD_MESSAGES.unexpected;
  }
}

export async function requestCampaign(
  body: FullWorkflowRequestBody,
  fetchImpl: typeof fetch = fetch
): Promise<CampaignBuildResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/ai/full-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  const failure = ErrorSchema.safeParse(json);
  if (failure.success) return { ok: false, message: messageForCode(failure.data.error.code) };

  const success = SuccessSchema.safeParse(json);
  if (!response.ok || !success.success) return { ok: false, message: BUILD_MESSAGES.unexpected };

  const campaign: CampaignBlueprint = success.data.data.campaign;
  const stories = new Map<string, StoryBlueprint>();
  for (const entry of campaign.story_sequence) {
    const story = success.data.data.stories[entry.story_id];
    if (!story) return { ok: false, message: BUILD_MESSAGES.storyFailed };
    stories.set(entry.story_id, story);
  }
  return { ok: true, campaign, stories };
}
