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
import { KnowledgeStatusSchema } from "./schemas/game.schema";
import { MaterialBlueprintSchema } from "./schemas/material.schema";
import { StoryBlueprintSchema } from "./schemas/story.schema";

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

// ---------------------------------------------------------------------------
// Layer 4 - ask (mid-story Q&A)
// ---------------------------------------------------------------------------

export const MIN_QUESTION_CHARS = 1;
export const MAX_QUESTION_CHARS = 1_000;

export const AskKnowledgeEntrySchema = z.object({
  concept_id: z.string().min(1, "concept_id must not be empty"),
  status: KnowledgeStatusSchema,
});

export type AskKnowledgeEntry = z.infer<typeof AskKnowledgeEntrySchema>;

export const AskLogItemSchema = z.object({
  kind: z.enum(["narration", "dialogue", "lesson", "question", "answer"]),
  speaker: z.string().optional(),
  title: z.string().optional(),
  text: z.string().min(1, "log text must not be empty"),
});

export type AskLogItem = z.infer<typeof AskLogItemSchema>;

export const AskTurnSchema = z.object({
  question: z.string().min(1, "question must not be empty"),
  answer: z.string().min(1, "answer must not be empty"),
});

export type AskTurn = z.infer<typeof AskTurnSchema>;

export const AskSceneContextSchema = z.object({
  scene_id: z.string().min(1, "scene_id must not be empty"),
  chapter_id: z.string().optional(),
  chapter_title: z.string().optional(),
  block_index: z.number().int().min(0).optional(),
  speaker_character_id: z.string().optional(),
  recent_log: z.array(AskLogItemSchema).max(20).optional(),
  qa_history: z.array(AskTurnSchema).max(12).optional(),
  player_knowledge: z.record(z.string(), AskKnowledgeEntrySchema).optional(),
});

export const AskQuestionRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(MIN_QUESTION_CHARS, `question must be at least ${MIN_QUESTION_CHARS} character`)
    .max(MAX_QUESTION_CHARS, `question must be at most ${MAX_QUESTION_CHARS} characters`),
  campaign: CampaignBlueprintSchema,
  story: StoryBlueprintSchema,
  materials: z.array(MaterialBlueprintSchema),
  context: AskSceneContextSchema,
});

export type AskQuestionRequest = z.infer<typeof AskQuestionRequestSchema>;

export const AskQuestionReplySchema = z.object({
  answer: z.string().min(1, "answer must not be empty"),
  expression: z.enum(["calm", "smile", "worried", "surprised", "angry"]),
  referenced_concept_ids: z.array(z.string()),
  out_of_scope: z.boolean(),
});

export type AskQuestionReply = z.infer<typeof AskQuestionReplySchema>;
