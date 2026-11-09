/**
 * Zod Schemas — Campaign Blueprint
 *
 * Used to validate AI output from Layer 2 (Campaign Planner).
 */

import { z } from "zod";

export const GenreSchema = z.enum([
  "fantasy",
  "modern",
  "science_fiction",
  "mystery",
  "historical",
  "survival",
  "horror",
  "custom",
]);

export const CharacterSchema = z.object({
  character_id: z.string().min(1, "character_id must not be empty"),
  name: z.string().min(1, "character name must not be empty"),
  role: z.string().min(1, "character role must not be empty"),
  description: z.string().min(1, "character description must not be empty"),
  expressions: z.record(z.string(), z.string()),
});

export const StoryOutcomeSchema = z.object({
  outcome_id: z.string().min(1, "outcome_id must not be empty"),
  description: z.string().min(1, "outcome description must not be empty"),
  world_state_changes: z.record(z.string(), z.number()),
});

export const StorySummaryEntrySchema = z.object({
  story_id: z.string().min(1, "story_id must not be empty"),
  material_id: z.string().min(1, "material_id must not be empty"),
  title: z.string().min(1, "story title must not be empty"),
  purpose: z.string().min(1, "story purpose must not be empty"),
  main_conflict: z.string().min(1, "main_conflict must not be empty"),
  required_knowledge: z.array(z.string()),
  outcomes: z.array(StoryOutcomeSchema),
});

export const CampaignBlueprintSchema = z.object({
  campaign_id: z.string().min(1, "campaign_id must not be empty"),
  title: z.string().min(1, "campaign title must not be empty"),
  genre: GenreSchema,
  tone: z.string().min(1, "tone must not be empty"),
  premise: z.string().min(1, "premise must not be empty"),
  main_conflict: z.string().min(1, "main_conflict must not be empty"),
  setting: z.string().min(1, "setting must not be empty"),
  characters: z
    .array(CharacterSchema)
    .min(1, "at least one character is required"),
  world_rules: z.array(z.string()),
  story_sequence: z
    .array(StorySummaryEntrySchema)
    .min(1, "story_sequence must contain at least one story"),
});

export type CharacterFromSchema = z.infer<typeof CharacterSchema>;
export type CampaignBlueprintFromSchema = z.infer<typeof CampaignBlueprintSchema>;
