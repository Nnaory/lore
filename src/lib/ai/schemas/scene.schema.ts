/**
 * Zod Schemas — Scene & Scene Content
 *
 * Validates scene data produced by AI (Layer 3/4).
 * Uses discriminated unions matching the SceneType enum.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Content block schemas
// ---------------------------------------------------------------------------

export const NarrationContentSchema = z.object({
  type: z.literal("narration"),
  text: z.string().min(1, "narration text must not be empty"),
});

export const DialogueContentSchema = z.object({
  type: z.literal("dialogue"),
  character_id: z.string().min(1, "character_id must not be empty"),
  expression: z.string().min(1, "expression must not be empty"),
  text: z.string().min(1, "dialogue text must not be empty"),
});

export const LearningContentSchema = z.object({
  type: z.literal("learning_info"),
  title: z.string().min(1, "learning_info title must not be empty"),
  body: z.string().min(1, "learning_info body must not be empty"),
  concept_ids: z
    .array(z.string())
    .min(1, "learning_info must reference at least one concept"),
});

export const SceneContentSchema = z.discriminatedUnion("type", [
  NarrationContentSchema,
  DialogueContentSchema,
  LearningContentSchema,
]);

// ---------------------------------------------------------------------------
// Ending schema
// ---------------------------------------------------------------------------

export const EndingTypeSchema = z.enum(["success", "failure", "partial_success"]);

export const EndingSchema = z.object({
  ending_id: z.string().min(1, "ending_id must not be empty"),
  type: EndingTypeSchema,
  title: z.string().min(1, "ending title must not be empty"),
  narration: z.string().min(1, "ending narration must not be empty"),
  world_state_changes: z.record(z.string(), z.number()),
  relationship_changes: z.record(z.string(), z.number()),
});

// ---------------------------------------------------------------------------
// Scene base
// ---------------------------------------------------------------------------

const SceneBaseSchema = z.object({
  scene_id: z.string().min(1, "scene_id must not be empty"),
  location: z.string().optional(),
  characters_present: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Scene variant schemas
// ---------------------------------------------------------------------------

export const NarrativeSceneSchema = SceneBaseSchema.extend({
  type: z.literal("narrative"),
  content: z.array(SceneContentSchema).min(1, "narrative scene must have content"),
  next_scene_id: z.string().nullable(),
});

export const LearningSceneSchema = SceneBaseSchema.extend({
  type: z.literal("learning"),
  content: z.array(SceneContentSchema).min(1, "learning scene must have content"),
  next_scene_id: z.string().nullable(),
});

export const InteractionSceneSchema = SceneBaseSchema.extend({
  type: z.literal("interaction"),
  content: z.array(SceneContentSchema).min(1, "interaction scene must have content"),
  next_scene_id: z.string().nullable(),
});

export const PuzzleSceneSchema = SceneBaseSchema.extend({
  type: z.literal("puzzle"),
  puzzle_id: z.string().min(1, "puzzle_id must not be empty"),
  next_scene_id: z.string().nullable(),
});

export const ConsequenceSceneSchema = SceneBaseSchema.extend({
  type: z.literal("consequence"),
  content: z.array(SceneContentSchema).min(1, "consequence scene must have content"),
  next_scene_id: z.string().nullable(),
});

export const EndingSceneSchema = SceneBaseSchema.extend({
  type: z.literal("ending"),
  ending_id: z.string().min(1, "ending_id must not be empty"),
});

/** Discriminated union of all scene variants. */
export const SceneSchema = z.discriminatedUnion("type", [
  NarrativeSceneSchema,
  LearningSceneSchema,
  InteractionSceneSchema,
  PuzzleSceneSchema,
  ConsequenceSceneSchema,
  EndingSceneSchema,
]);

export type SceneContentFromSchema = z.infer<typeof SceneContentSchema>;
export type SceneFromSchema = z.infer<typeof SceneSchema>;
export type EndingFromSchema = z.infer<typeof EndingSchema>;
