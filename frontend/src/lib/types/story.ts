/**
 * Story Blueprint Types
 *
 * Represents the structured output of Layer 3 (Story Generator).
 * Contains chapters, scenes, puzzles, and endings for a single story.
 */

import type { Scene, Ending } from "./scene";
import type { Puzzle } from "./puzzle";

/** A summary of how an important decision played out in this story. */
export type DecisionRecord = {
  decision_id: string;
  description: string;
  result: string;
};

/**
 * A compact summary produced at the end of a story.
 * Passed to the next Story Generator to maintain narrative continuity
 * without re-sending the full story content.
 */
export type ContinuitySummary = {
  story_id: string;
  outcome_description: string;
  key_decisions: DecisionRecord[];
  /** Snapshot of world state values after this story ended. */
  world_state_snapshot: Record<string, number>;
  /** Relationship score snapshot after this story ended. */
  relationship_snapshot: Record<string, number>;
};

/**
 * Maps a concept to the knowledge status the player achieved
 * by the end of this story.
 */
export type KnowledgeMappingEntry = {
  concept_id: string;
  introduced_in_scene_id: string;
  tested_in_puzzle_id: string;
};

/** A single chapter, which contains an ordered list of scenes. */
export type Chapter = {
  chapter_id: string;
  title: string;
  /** Ordered list of scenes. The first scene is the entry point of this chapter. */
  scenes: Scene[];
};

/**
 * The full content blueprint for one story.
 * Produced by Layer 3 (Story Generator) and consumed by the game engine.
 */
export type StoryBlueprint = {
  story_id: string;
  material_id: string;
  title: string;
  summary: string;
  /** IDs of characters from CampaignBlueprint who appear in this story. */
  character_ids: string[];
  chapters: Chapter[];
  /** All puzzles referenced by puzzle scenes in this story. */
  puzzles: Puzzle[];
  /** All endings referenced by ending scenes in this story. */
  endings: Ending[];
  continuity_summary: ContinuitySummary | null;
  knowledge_mapping: KnowledgeMappingEntry[];
};
