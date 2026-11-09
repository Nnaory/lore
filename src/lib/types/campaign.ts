/**
 * Campaign Blueprint Types
 *
 * Represents the structured output of Layer 2 (Campaign Planner).
 * Defines the overarching narrative arc connecting all stories.
 */

export type Genre =
  | "fantasy"
  | "modern"
  | "science_fiction"
  | "mystery"
  | "historical"
  | "survival"
  | "horror"
  | "custom";

/** A named character within the campaign world. */
export type Character = {
  character_id: string;
  name: string;
  role: string;
  description: string;
  /** Kaomoji-style expression keys mapped to display strings, e.g. "happy" -> "(^_^)". */
  expressions: Record<string, string>;
};

/** The planned outcome variants of a story depending on player decisions. */
export type StoryOutcome = {
  outcome_id: string;
  description: string;
  /** Key-value pairs that describe how this outcome changes the campaign world state. */
  world_state_changes: Record<string, number>;
};

/** High-level plan for a single story within the campaign. */
export type StorySummaryEntry = {
  story_id: string;
  material_id: string;
  title: string;
  purpose: string;
  main_conflict: string;
  /** IDs of concepts the player is expected to know before starting this story. */
  required_knowledge: string[];
  outcomes: StoryOutcome[];
};

/**
 * The structured blueprint produced by Layer 2 (Campaign Planner).
 * Defines characters, world rules, and the ordered sequence of stories.
 */
export type CampaignBlueprint = {
  campaign_id: string;
  title: string;
  genre: Genre;
  tone: string;
  premise: string;
  main_conflict: string;
  setting: string;
  characters: Character[];
  /** High-level rules that govern the world and must not be violated across stories. */
  world_rules: string[];
  story_sequence: StorySummaryEntry[];
};
