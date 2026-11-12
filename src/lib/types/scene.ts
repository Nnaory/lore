/**
 * Scene Types
 *
 * Represents a single scene within a chapter.
 * Each scene has a type that determines how it is rendered and processed.
 */

/** Possible scene types as defined in the LORE data contract. */
export type SceneType =
  | "narrative"
  | "learning"
  | "interaction"
  | "puzzle"
  | "consequence"
  | "ending";

// ---------------------------------------------------------------------------
// Scene content building blocks
// ---------------------------------------------------------------------------

/** A paragraph of narration — no speaker, no expression. */
export type NarrationContent = {
  type: "narration";
  text: string;
};

/** A line of dialogue spoken by a character. */
export type DialogueContent = {
  type: "dialogue";
  character_id: string;
  /** Key referencing a character's expression map, e.g. "worried" or "happy". */
  expression: string;
  text: string;
};

/**
 * An in-world presentation of a learning concept.
 * Teaches the principle without directly giving away puzzle answers.
 */
export type LearningContent = {
  type: "learning_info";
  title: string;
  body: string;
  /** IDs of concepts from the MaterialBlueprint that this content introduces. */
  concept_ids: string[];
};

/** Union of all content block types that can appear inside a scene. */
export type SceneContent = NarrationContent | DialogueContent | LearningContent;

// ---------------------------------------------------------------------------
// Ending data
// ---------------------------------------------------------------------------

/** The final outcome state of a story. */
export type EndingType = "success" | "failure" | "partial_success";

export type Ending = {
  ending_id: string;
  type: EndingType;
  title: string;
  narration: string;
  /** How this ending affects the campaign-level world state. */
  world_state_changes: Record<string, number>;
  /** How this ending affects relationship scores. */
  relationship_changes: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Scene variants (discriminated union)
// ---------------------------------------------------------------------------

/** Base fields shared by all scene variants. */
type SceneBase = {
  scene_id: string;
  location?: string;
  /** IDs of characters who are present in this scene. */
  characters_present: string[];
};

/** A scene that primarily shows narration and/or dialogue. */
export type NarrativeScene = SceneBase & {
  type: "narrative";
  content: SceneContent[];
  next_scene_id: string | null;
};

/** A scene dedicated to teaching a concept before a puzzle. */
export type LearningScene = SceneBase & {
  type: "learning";
  content: SceneContent[];
  next_scene_id: string | null;
};

/** A scene where the player interacts with a character or object. */
export type InteractionScene = SceneBase & {
  type: "interaction";
  content: SceneContent[];
  next_scene_id: string | null;
};

/**
 * A scene that presents a puzzle to the player.
 * The actual puzzle data lives in `StoryBlueprint.puzzles`.
 */
export type PuzzleScene = SceneBase & {
  type: "puzzle";
  puzzle_id: string;
  /** Scene to navigate to after the puzzle is solved correctly. */
  next_scene_id: string | null;
  /**
   * Optional mapping from a wrong choice_id to a "bad branch" scene_id.
   * When present, selecting that incorrect choice navigates the player through
   * a consequence/ending sequence instead of simply showing inline feedback.
   * After the bad branch plays out, the player is offered a "Return to Puzzle"
   * option that brings them back here (with HP already deducted).
   * If a wrong choice_id is NOT listed here, the classic inline-feedback
   * behaviour applies.
   */
  on_incorrect_scene_id?: Record<string, string>;
};

/** A scene that shows the consequence of a player decision. */
export type ConsequenceScene = SceneBase & {
  type: "consequence";
  content: SceneContent[];
  next_scene_id: string | null;
};

/**
 * The final scene of a story.
 * References an ending from `StoryBlueprint.endings`.
 */
export type EndingScene = SceneBase & {
  type: "ending";
  ending_id: string;
};

/** Discriminated union of all scene types. */
export type Scene =
  | NarrativeScene
  | LearningScene
  | InteractionScene
  | PuzzleScene
  | ConsequenceScene
  | EndingScene;
