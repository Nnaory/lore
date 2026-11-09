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

/** Derive the correct status for a given scene at a given content index. */
export function deriveStatusForScene(
  scene: Scene,
  contentIndex: number
): StoryPlayerState {
  if (scene.type === "ending") {
    return { currentSceneId: scene.scene_id, contentIndex: 0, status: "story_complete" };
  }
  if (scene.type === "puzzle") {
    return { currentSceneId: scene.scene_id, contentIndex: 0, status: "puzzle" };
  }
  const blocks = getSceneContentBlocks(scene);
  if (!blocks || blocks.length === 0 || contentIndex >= blocks.length) {
    // No content or all consumed — ready to advance
    return { currentSceneId: scene.scene_id, contentIndex: contentIndex, status: "scene_end" };
  }
  return { currentSceneId: scene.scene_id, contentIndex, status: "reading" };
}

/**
 * Advance one content block forward within the current scene.
 * If all blocks are consumed, marks the scene as ready to transition.
 *
 * Returns a new state object (pure — does not mutate).
 */
export function advanceContent(
  state: StoryPlayerState,
  scene: Scene
): StoryPlayerState {
  if (state.status !== "reading") return state;

  const blocks = getSceneContentBlocks(scene);
  if (!blocks) return { ...state, status: "scene_end" };

  const nextIndex = state.contentIndex + 1;
  if (nextIndex >= blocks.length) {
    return { ...state, contentIndex: nextIndex, status: "scene_end" };
  }
  return { ...state, contentIndex: nextIndex };
}

/**
 * Transition to the next scene.
 * Returns a new state, or an error string if the reference is invalid.
 */
export function advanceScene(
  state: StoryPlayerState,
  currentScene: Scene,
  index: SceneIndex
): StoryPlayerState | { error: string } {
  if (state.status === "story_complete") return state;

  // Puzzle scenes advance via advanceScene too (after the puzzle UI resolves)
  const nextSceneId =
    currentScene.type !== "ending" ? currentScene.next_scene_id : null;

  if (nextSceneId === null) {
    // No next scene — treat as story complete
    return { ...state, status: "story_complete" };
  }

  const nextScene = index.get(nextSceneId);
  if (!nextScene) {
    return {
      error: `Scene "${nextSceneId}" referenced by "${currentScene.scene_id}" does not exist.`,
    };
  }

  return deriveStatusForScene(nextScene, 0);
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
