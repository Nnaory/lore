/**
 * Request schemas for the three AI routes (analyze-material, plan-campaign,
 * generate-story).
 *
 * Pure Zod. The FastAPI backend is the only implementation of these steps, so
 * the browser keeps one definition of what a valid request looks like (used by
 * the contract tests and by client code that builds request options).
 */

import { z } from "zod";
import { MAX_MATERIAL_CHARS, MIN_MATERIAL_CHARS } from "@/lib/ingest/limits";
import { CampaignBlueprintSchema, GenreSchema, StorySummaryEntrySchema } from "./schemas/campaign.schema";
import { MaterialBlueprintSchema } from "./schemas/material.schema";

// ---------------------------------------------------------------------------
// Layer 1 - analyze-material
// ---------------------------------------------------------------------------

export const AnalyzeMaterialRequestSchema = z.object({
  material: z
    .string()
    .min(MIN_MATERIAL_CHARS, `material must be at least ${MIN_MATERIAL_CHARS} characters`)
    .max(MAX_MATERIAL_CHARS, `material must be at most ${MAX_MATERIAL_CHARS} characters`),
  context: z.record(z.unknown()).optional(),
  genre: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Layer 2 - plan-campaign
// ---------------------------------------------------------------------------

/** Campaign-level creative options supplied by the caller. */
export const CampaignPlannerOptionsSchema = z.object({
  genre: GenreSchema,
  /** Narrative tone. Providers may override this when omitted. */
  tone: z.string().optional(),
  /** World setting. Providers may override this when omitted. */
  setting: z.string().optional(),
  /** Extra instructions from the player, passed to the storyteller. */
  customInstructions: z.string().optional(),
  /** Optional explicit campaign identifier. Defaults to a deterministic value. */
  campaignId: z.string().optional(),
  /** Optional language hint for the storyteller. */
  language: z.string().optional(),
});

export type CampaignPlannerOptions = z.infer<typeof CampaignPlannerOptionsSchema>;

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

// ---------------------------------------------------------------------------
// Layer 3 - generate-story
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
  /** Extra instructions from the player, passed to the storyteller. */
  customInstructions: z.string().optional(),
  /** Optional language hint for the storyteller. */
  language: z.string().optional(),
  /** Append a final Last Boss chapter with 1 challenge puzzle per concept. */
  includeBossChapter: z.boolean().optional(),
});

/**
 * Story Generator request - ONE story at a time.
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
