/**
 * useStoryPlayer — React hook
 *
 * Wraps the pure story-player logic with React state.
 * Components call this hook to get current scene, current content block,
 * and handlers to advance the story.
 *
 * Milestone 4 additions:
 *   - hp: number — current HP for this story run (0–5).
 *   - isFailed: boolean — derived from hp, never stored separately.
 *     `isFailed = hp <= FAILURE_HP`
 *   - onPuzzleIncorrect() — deducts 1 HP via a pure functional updater.
 *   - retryStory() — resets navigation state and HP without touching
 *     CampaignState.
 *
 * State purity note:
 *   `isFailed` is NOT stored as independent React state.
 *   It is derived from `hp` on every render. This guarantees that hp and
 *   isFailed are always consistent and that no state update is nested inside
 *   another state updater.
 */

"use client";

import { useState, useMemo, useCallback } from "react";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Character } from "@/lib/types/campaign";
import type { Scene, SceneContent } from "@/lib/types/scene";
import {
  buildSceneIndex,
  buildCharacterIndex,
  createInitialPlayerState,
  advanceContent,
  advanceScene,
  getSceneContentBlocks,
  getChapterForScene,
  type StoryPlayerState,
  type StoryPlayerStatus,
  type SceneIndex,
  type CharacterIndex,
} from "./story-player";
import {
  deductHp,
  initialHp,
  isStoryFailed,
  FAILURE_HP,
} from "@/lib/game/hp-manager";

export type { StoryPlayerStatus };

export type StoryPlayerError = {
  message: string;
};

export type UseStoryPlayerReturn = {
  // Current navigation state
  playerState: StoryPlayerState;
  currentScene: Scene | null;
  /** The content block being displayed at the current index, or null. */
  currentContentBlock: SceneContent | null;
  /** All content blocks of the current scene (for rendering history / chat log). */
  allContentBlocks: SceneContent[] | null;
  /** Chapter info for the current scene. */
  currentChapter: { chapter_id: string; title: string } | undefined;
  /** Story completion flag. */
  isComplete: boolean;
  /** Whether the story player hit an unrecoverable navigation error. */
  error: StoryPlayerError | null;
  // HP state (Milestone 4)
  /** Current HP for this story run. Range: 0–5. */
  hp: number;
  /**
   * True when hp <= FAILURE_HP.
   * Derived from hp on every render — never stored as independent state.
   */
  isFailed: boolean;
  // Indices
  sceneIndex: SceneIndex;
  characterIndex: CharacterIndex;
  // Actions
  /** Reveal the next content block. Blocked when story is failed. */
  advance: () => void;
  /**
   * Called by PuzzleInteraction (via SceneRenderer) after a correct puzzle
   * submission. Moves to the next scene.
   */
  completePuzzle: () => void;
  /**
   * Called by PuzzleInteraction (via SceneRenderer) after an incorrect puzzle
   * submission. Deducts 1 HP using a pure functional updater.
   * Guards against deduction when HP is already at FAILURE_HP.
   */
  onPuzzleIncorrect: () => void;
  /**
   * Resets the story to its initial state (first scene, full HP).
   * CampaignState is NOT touched — only the current story run is reset.
   */
  retryStory: () => void;
};

export function useStoryPlayer(
  story: StoryBlueprint,
  characters: Character[]
): UseStoryPlayerReturn {
  const sceneIndex = useMemo(() => buildSceneIndex(story), [story]);
  const characterIndex = useMemo(
    () => buildCharacterIndex(characters),
    [characters]
  );

  const [playerState, setPlayerState] = useState<StoryPlayerState>(() =>
    createInitialPlayerState(story)
  );
  const [error, setError] = useState<StoryPlayerError | null>(null);

  // ── HP state ─────────────────────────────────────────────────────────────
  const [hp, setHp] = useState<number>(() => initialHp());

  // isFailed is derived, not stored — hp and isFailed cannot become inconsistent.
  const isFailed: boolean = hp <= FAILURE_HP;

  const currentScene = sceneIndex.get(playerState.currentSceneId) ?? null;

  const allContentBlocks = useMemo<SceneContent[] | null>(() => {
    if (!currentScene) return null;
    return getSceneContentBlocks(currentScene);
  }, [currentScene]);

  const currentContentBlock = useMemo<SceneContent | null>(() => {
    if (!allContentBlocks) return null;
    if (playerState.contentIndex >= allContentBlocks.length) return null;
    return allContentBlocks[playerState.contentIndex] ?? null;
  }, [allContentBlocks, playerState.contentIndex]);

  const currentChapter = useMemo(
    () => getChapterForScene(story, playerState.currentSceneId),
    [story, playerState.currentSceneId]
  );

  // ── Navigation ───────────────────────────────────────────────────────────

  const advance = useCallback(() => {
    if (!currentScene) return;
    if (error) return;
    if (isFailed) return;
    if (playerState.status === "story_complete") return;

    if (playerState.status === "reading") {
      setPlayerState(advanceContent(playerState, currentScene));
      return;
    }

    if (playerState.status === "scene_end") {
      const result = advanceScene(playerState, currentScene, sceneIndex);
      if ("error" in result) {
        setError({ message: result.error });
        return;
      }
      setPlayerState(result);
    }
  }, [currentScene, error, isFailed, playerState, sceneIndex]);

  const completePuzzle = useCallback(() => {
    if (!currentScene) return;
    if (playerState.status !== "puzzle") return;
    if (isFailed) return;

    const result = advanceScene(playerState, currentScene, sceneIndex);
    if ("error" in result) {
      setError({ message: result.error });
      return;
    }
    setPlayerState(result);
  }, [currentScene, isFailed, playerState, sceneIndex]);

  /**
   * Pure HP deduction.
   * The functional updater reads the latest HP value from React, so stale
   * closures cannot cause incorrect calculations.
   * The guard `hp <= FAILURE_HP` (read from the current render's value)
   * prevents deduction once the story is already failed.
   */
  const onPuzzleIncorrect = useCallback(() => {
    // Guard: if story is already failed, this is a no-op.
    // We read `hp` (render-time value) rather than deriving it inside the
    // updater to keep the updater itself pure.
    if (hp <= FAILURE_HP) return;

    setHp((currentHp) => deductHp(currentHp));
  }, [hp]);

  const retryStory = useCallback(() => {
    setPlayerState(createInitialPlayerState(story));
    setHp(initialHp());
    setError(null);
  }, [story]);

  return {
    playerState,
    currentScene,
    currentContentBlock,
    allContentBlocks,
    currentChapter,
    isComplete: playerState.status === "story_complete",
    error,
    hp,
    isFailed,
    sceneIndex,
    characterIndex,
    advance,
    completePuzzle,
    onPuzzleIncorrect,
    retryStory,
  };
}
