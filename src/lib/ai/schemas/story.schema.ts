/**
 * Zod Schemas — Story Blueprint
 *
 * Validates the full story structure produced by Layer 3 (Story Generator).
 */

import { z } from "zod";
import { SceneSchema, EndingSchema } from "./scene.schema";
import { PuzzleSchema } from "./puzzle.schema";

export const DecisionRecordSchema = z.object({
  decision_id: z.string().min(1, "decision_id must not be empty"),
  description: z.string().min(1, "description must not be empty"),
  result: z.string().min(1, "result must not be empty"),
});

export const ContinuitySummarySchema = z.object({
  story_id: z.string().min(1, "story_id must not be empty"),
  outcome_description: z
    .string()
    .min(1, "outcome_description must not be empty"),
  key_decisions: z.array(DecisionRecordSchema),
  world_state_snapshot: z.record(z.string(), z.number()),
  relationship_snapshot: z.record(z.string(), z.number()),
});

export const KnowledgeMappingEntrySchema = z.object({
  concept_id: z.string().min(1, "concept_id must not be empty"),
  introduced_in_scene_id: z
    .string()
    .min(1, "introduced_in_scene_id must not be empty"),
  tested_in_puzzle_id: z
    .string()
    .min(1, "tested_in_puzzle_id must not be empty"),
});

export const ChapterSchema = z.object({
  chapter_id: z.string().min(1, "chapter_id must not be empty"),
  title: z.string().min(1, "chapter title must not be empty"),
  scenes: z.array(SceneSchema).min(1, "chapter must contain at least one scene"),
});

export const StoryBlueprintSchema = z.object({
  story_id: z.string().min(1, "story_id must not be empty"),
  material_id: z.string().min(1, "material_id must not be empty"),
  title: z.string().min(1, "story title must not be empty"),
  summary: z.string().min(1, "story summary must not be empty"),
  character_ids: z.array(z.string()),
  chapters: z
    .array(ChapterSchema)
    .min(1, "story must contain at least one chapter"),
  puzzles: z.array(PuzzleSchema),
  endings: z.array(EndingSchema),
  continuity_summary: ContinuitySummarySchema.nullable(),
  knowledge_mapping: z.array(KnowledgeMappingEntrySchema),
});

export type StoryBlueprintFromSchema = z.infer<typeof StoryBlueprintSchema>;
export type ChapterFromSchema = z.infer<typeof ChapterSchema>;
