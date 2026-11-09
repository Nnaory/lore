/**
 * Game State Types
 *
 * Defines the runtime state of LORE during a play session.
 * Separated into StoryState (per-story) and CampaignState (cross-story).
 */

// ---------------------------------------------------------------------------
// Story State — resets when a story is retried
// ---------------------------------------------------------------------------

/** Possible statuses for the currently active story. */
export type StoryStatus =
  | "not_started"
  | "in_progress"
  | "story_failed"
  | "completed";

/** Records one attempt at a puzzle. */
export type PuzzleAttempt = {
  attempt_number: number;
  chosen_choice_id: string;
  correct: boolean;
  timestamp: number;
};

/** All attempts made on a single puzzle during this story. */
export type PuzzleAttemptRecord = {
  puzzle_id: string;
  attempts: PuzzleAttempt[];
  /** Whether the puzzle has been solved (regardless of attempt count). */
  solved: boolean;
};

/** A player decision recorded during the current story. */
export type StoryDecision = {
  decision_id: string;
  scene_id: string;
  chosen_choice_id: string;
  timestamp: number;
};

/**
 * Transient state for the currently active story.
 * This is the only state that gets reset when the player retries a story.
 *
 * HP range: 0–5.
 */
export type StoryState = {
  story_id: string;
  current_chapter_id: string;
  current_scene_id: string;
  /** Current HP value. Must be between 0 and 5 inclusive. */
  hp: number;
  status: StoryStatus;
  /** Map of puzzle_id → attempt record for all puzzles touched this run. */
  puzzle_attempts: Record<string, PuzzleAttemptRecord>;
  /** Ordered list of decisions made in this story run. */
  story_decisions: StoryDecision[];
};

// ---------------------------------------------------------------------------
// Campaign State — persists across stories
// ---------------------------------------------------------------------------

/** Knowledge status for a concept as demonstrated by the player. */
export type KnowledgeStatus =
  | "not_introduced"
  | "introduced"
  | "developing"
  | "demonstrated";

/** Evidence linking a player action to a concept's knowledge status. */
export type KnowledgeEvidence = {
  /** Human-readable description of the evidence, e.g. "puzzle_01_correct_first_try". */
  source: string;
  /** The puzzle or scene that generated this evidence. */
  reference_id: string;
  timestamp: number;
};

/** The learning status of a single concept as tracked across the campaign. */
export type PlayerKnowledge = {
  concept_id: string;
  status: KnowledgeStatus;
  evidence: KnowledgeEvidence[];
};

/** A major decision recorded at the campaign level for cross-story continuity. */
export type MajorDecision = {
  decision_id: string;
  story_id: string;
  description: string;
  result: string;
  timestamp: number;
};

/**
 * A compact summary of a completed story.
 * Stored so the next Story Generator can maintain narrative continuity.
 */
export type PreviousStorySummary = {
  story_id: string;
  title: string;
  outcome_description: string;
  world_state_snapshot: Record<string, number>;
  relationship_snapshot: Record<string, number>;
};

/**
 * Persistent state that survives across stories in a campaign.
 * This must NOT be reset when the player retries the current story.
 *
 * Only decisions and state from *completed* stories are stored here.
 */
export type CampaignState = {
  campaign_id: string;
  current_story_id: string;
  /** IDs of stories the player has successfully completed. */
  completed_stories: string[];
  /** Numeric world state values (e.g. stability, resources). */
  world_state: Record<string, number>;
  /** Relationship scores keyed by character_id. */
  relationships: Record<string, number>;
  /** Important decisions that carry narrative weight across stories. */
  major_decisions: MajorDecision[];
  /** Map of concept_id → PlayerKnowledge for all concepts encountered. */
  player_knowledge: Record<string, PlayerKnowledge>;
  /** Ordered summaries of completed stories, used by the Story Generator. */
  previous_story_summaries: PreviousStorySummary[];
};
