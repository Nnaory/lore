/**
 * Story Player — Pure Navigation Logic
 *
 * This module contains the pure (non-React) logic for navigating a story:
 * advancing through content blocks within a scene, transitioning between
 * scenes, and detecting story completion.
 *
 * It is separated from React state so it can be tested without a DOM.
 */

import type { Scene, SceneContent } from "@/lib/types/scene";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Character } from "@/lib/types/campaign";

// ---------------------------------------------------------------------------
// Scene index — flat map for O(1) lookup
// ---------------------------------------------------------------------------

/** A flat map from scene_id → Scene, built once from a StoryBlueprint. */
export type SceneIndex = ReadonlyMap<string, Scene>;

/** Build a flat scene index from a StoryBlueprint. */
export function buildSceneIndex(story: StoryBlueprint): SceneIndex {
  const map = new Map<string, Scene>();
  for (const chapter of story.chapters) {
    for (const scene of chapter.scenes) {
      map.set(scene.scene_id, scene);
    }
  }
  return map;
}

/** Build a character index from an array of characters. */
export type CharacterIndex = ReadonlyMap<string, Character>;

export function buildCharacterIndex(characters: Character[]): CharacterIndex {
  const map = new Map<string, Character>();
  for (const char of characters) {
    map.set(char.character_id, char);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/**
 * Returns the ordered content blocks for a scene, or null if the scene
 * has no content (puzzle scenes, ending scenes).
 */
export function getSceneContentBlocks(scene: Scene): SceneContent[] | null {
  if (
    scene.type === "narrative" ||
    scene.type === "learning" ||
    scene.type === "interaction" ||
    scene.type === "consequence"
  ) {
    return scene.content;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation state
// ---------------------------------------------------------------------------

export type StoryPlayerStatus =
  | "reading"      // Player is reading content blocks within a scene
  | "scene_end"    // All content blocks consumed; ready to advance to next scene
  | "puzzle"       // Waiting on puzzle interaction
  | "bad_branch"   // Navigated into a wrong-choice consequence branch; reading it
  | "story_complete"; // Reached an ending scene

/**
 * The navigation state managed by the story player.
 * This is a plain data object — React state wraps it.
 */
export type StoryPlayerState = {
  currentSceneId: string;
  /** Index into the content block array of the current scene. */
  contentIndex: number;
  status: StoryPlayerStatus;
  /**
   * When status is "bad_branch" (or any scene navigated from a bad branch),
   * this holds the scene_id of the puzzle the player should return to after
   * the bad ending sequence finishes.
   */
  returnToPuzzleSceneId?: string;
};

// ---------------------------------------------------------------------------
// Transitions — pure functions, no side effects
// ---------------------------------------------------------------------------

/**
 * Derive the initial player state for a story.
 * Starts at the first scene of the first chapter.
 */
export function createInitialPlayerState(story: StoryBlueprint): StoryPlayerState {
  const firstChapter = story.chapters[0];
  if (!firstChapter || firstChapter.scenes.length === 0) {
    throw new Error(
      `Story "${story.story_id}" has no chapters or scenes.`
    );
  }
  const firstScene = firstChapter.scenes[0];
  return deriveStatusForScene(firstScene, 0);
}

/**
 * Derive the correct status for a given scene at a given content index.
 * Pass `returnToPuzzleSceneId` to carry the bad-branch return pointer
 * through the entire consequence/ending sequence.
 */
export function deriveStatusForScene(
  scene: Scene,
  contentIndex: number,
  returnToPuzzleSceneId?: string
): StoryPlayerState {
  if (scene.type === "ending") {
    return {
      currentSceneId: scene.scene_id,
      contentIndex: 0,
      status: "story_complete",
      returnToPuzzleSceneId,
    };
  }
  if (scene.type === "puzzle") {
    return { currentSceneId: scene.scene_id, contentIndex: 0, status: "puzzle" };
  }
  const blocks = getSceneContentBlocks(scene);
  if (!blocks || blocks.length === 0 || contentIndex >= blocks.length) {
    return {
      currentSceneId: scene.scene_id,
      contentIndex,
      status: returnToPuzzleSceneId ? "bad_branch" : "scene_end",
      returnToPuzzleSceneId,
    };
  }
  return {
    currentSceneId: scene.scene_id,
    contentIndex,
    status: returnToPuzzleSceneId ? "bad_branch" : "reading",
    returnToPuzzleSceneId,
  };
}

/**
 * Advance one content block forward within the current scene.
 * If all blocks are consumed, marks the scene as ready to transition.
 * Preserves `returnToPuzzleSceneId` throughout bad-branch traversal.
 *
 * Returns a new state object (pure — does not mutate).
 */
export function advanceContent(
  state: StoryPlayerState,
  scene: Scene
): StoryPlayerState {
  if (state.status !== "reading" && state.status !== "bad_branch") return state;

  const blocks = getSceneContentBlocks(scene);
  const rtp = state.returnToPuzzleSceneId;

  if (!blocks) return { ...state, status: rtp ? "bad_branch" : "scene_end" };

  const nextIndex = state.contentIndex + 1;
  if (nextIndex >= blocks.length) {
    return {
      ...state,
      contentIndex: nextIndex,
      status: rtp ? "bad_branch" : "scene_end",
    };
  }
  return { ...state, contentIndex: nextIndex };
}

/**
 * Transition to the next scene.
 * Returns a new state, or an error string if the reference is invalid.
 * Preserves `returnToPuzzleSceneId` so the whole bad-branch chain
 * knows where to send the player when it finishes.
 */
export function advanceScene(
  state: StoryPlayerState,
  currentScene: Scene,
  index: SceneIndex
): StoryPlayerState | { error: string } {
  if (state.status === "story_complete") return state;

  const nextSceneId =
    currentScene.type !== "ending" ? currentScene.next_scene_id : null;

  if (nextSceneId === null) {
    return { ...state, status: "story_complete" };
  }

  const nextScene = index.get(nextSceneId);
  if (!nextScene) {
    return {
      error: `Scene "${nextSceneId}" referenced by "${currentScene.scene_id}" does not exist.`,
    };
  }

  // Carry the return pointer through the branch
  return deriveStatusForScene(nextScene, 0, state.returnToPuzzleSceneId);
}

/**
 * Branch into a wrong-choice consequence scene.
 * Called by the puzzle engine when the player picks an incorrect choice
 * that has an `on_incorrect_scene_id` mapping.
 *
 * @param puzzleScene   The current PuzzleScene (source of the branch).
 * @param branchSceneId The scene_id to navigate to.
 * @param index         The flat scene index.
 */
export function branchToIncorrectScene(
  puzzleScene: Scene & { type: "puzzle" },
  branchSceneId: string,
  index: SceneIndex
): StoryPlayerState | { error: string } {
  const branchScene = index.get(branchSceneId);
  if (!branchScene) {
    return {
      error: `Bad-branch scene "${branchSceneId}" referenced by puzzle "${puzzleScene.scene_id}" does not exist.`,
    };
  }
  return deriveStatusForScene(branchScene, 0, puzzleScene.scene_id);
}

// ---------------------------------------------------------------------------
// Chapter title helper
// ---------------------------------------------------------------------------

/** Return the chapter title for the given scene_id, or undefined. */
export function getChapterForScene(
  story: StoryBlueprint,
  sceneId: string
): { chapter_id: string; title: string } | undefined {
  for (const chapter of story.chapters) {
    if (chapter.scenes.some((s) => s.scene_id === sceneId)) {
      return { chapter_id: chapter.chapter_id, title: chapter.title };
    }
  }
  return undefined;
}
