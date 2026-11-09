/**
 * Zod Schemas — Game State
 *
 * Validates runtime game state for StoryState and CampaignState.
 * Enforces business rules like HP range (0–5) and valid enum values.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Story State
// ---------------------------------------------------------------------------

export const StoryStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "story_failed",
  "completed",
]);

export const PuzzleAttemptSchema = z.object({
  attempt_number: z.number().int().positive(),
  chosen_choice_id: z.string().min(1, "chosen_choice_id must not be empty"),
  correct: z.boolean(),
  timestamp: z.number().int().nonnegative(),
});

export const PuzzleAttemptRecordSchema = z.object({
  puzzle_id: z.string().min(1, "puzzle_id must not be empty"),
  attempts: z.array(PuzzleAttemptSchema),
  solved: z.boolean(),
});

export const StoryDecisionSchema = z.object({
  decision_id: z.string().min(1, "decision_id must not be empty"),
  scene_id: z.string().min(1, "scene_id must not be empty"),
  chosen_choice_id: z.string().min(1, "chosen_choice_id must not be empty"),
  timestamp: z.number().int().nonnegative(),
});

export const StoryStateSchema = z.object({
  story_id: z.string().min(1, "story_id must not be empty"),
  current_chapter_id: z.string().min(1, "current_chapter_id must not be empty"),
  current_scene_id: z.string().min(1, "current_scene_id must not be empty"),
  /** HP must be within the valid range of 0–5. */
  hp: z.number().int().min(0, "HP cannot be negative").max(5, "HP cannot exceed 5"),
  status: StoryStatusSchema,
  puzzle_attempts: z.record(z.string(), PuzzleAttemptRecordSchema),
  story_decisions: z.array(StoryDecisionSchema),
});

// ---------------------------------------------------------------------------
// Campaign State
// ---------------------------------------------------------------------------

export const KnowledgeStatusSchema = z.enum([
  "not_introduced",
  "introduced",
  "developing",
  "demonstrated",
]);

export const KnowledgeEvidenceSchema = z.object({
  source: z.string().min(1, "evidence source must not be empty"),
  reference_id: z.string().min(1, "reference_id must not be empty"),
  timestamp: z.number().int().nonnegative(),
});

export const PlayerKnowledgeSchema = z.object({
  concept_id: z.string().min(1, "concept_id must not be empty"),
  status: KnowledgeStatusSchema,
  evidence: z.array(KnowledgeEvidenceSchema),
});

export const MajorDecisionSchema = z.object({
  decision_id: z.string().min(1, "decision_id must not be empty"),
  story_id: z.string().min(1, "story_id must not be empty"),
  description: z.string().min(1, "description must not be empty"),
  result: z.string().min(1, "result must not be empty"),
  timestamp: z.number().int().nonnegative(),
});

export const PreviousStorySummarySchema = z.object({
  story_id: z.string().min(1, "story_id must not be empty"),
  title: z.string().min(1, "title must not be empty"),
  outcome_description: z.string().min(1, "outcome_description must not be empty"),
  world_state_snapshot: z.record(z.string(), z.number()),
  relationship_snapshot: z.record(z.string(), z.number()),
});

export const CampaignStateSchema = z.object({
  campaign_id: z.string().min(1, "campaign_id must not be empty"),
  current_story_id: z.string().min(1, "current_story_id must not be empty"),
  completed_stories: z.array(z.string()),
  world_state: z.record(z.string(), z.number()),
  relationships: z.record(z.string(), z.number()),
  major_decisions: z.array(MajorDecisionSchema),
  player_knowledge: z.record(z.string(), PlayerKnowledgeSchema),
  previous_story_summaries: z.array(PreviousStorySummarySchema),
});

export type StoryStateFromSchema = z.infer<typeof StoryStateSchema>;
export type CampaignStateFromSchema = z.infer<typeof CampaignStateSchema>;
export type PlayerKnowledgeFromSchema = z.infer<typeof PlayerKnowledgeSchema>;
