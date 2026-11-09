/**
 * useStoryPlayer — React hook
 *
 * Wraps the pure story-player logic with React state.
 * Components call this hook to get current scene, current content block,
 * and handlers to advance the story.
 *
 * Milestone 4: HP state, isFailed (derived), onPuzzleIncorrect, retryStory.
 * Milestone 6: knowledge event callbacks.
 *
 * Knowledge design:
 *   This hook does NOT own CampaignState or player_knowledge. Instead it
 *   exposes callbacks that StoryViewer passes up to useCampaign:
 *
 *   - onSceneEntered(sceneId): called when a new scene becomes active.
 *     StoryViewer extracts the concept_ids from learning_info blocks and
 *     calls onKnowledgeUpdate on useCampaign.
 *
 *   - onPuzzleAnswer(puzzleId, correct, isFirstAttempt): called when the
 *     player submits a puzzle answer (via PuzzleInteraction / SceneRenderer).
 *     StoryViewer wires this to onKnowledgeUpdate on useCampaign.
 *
 *   The hook itself tracks per-puzzle attempt counts (to determine isFirstAttempt)
 *   using a local map that resets on retryStory.
 *
 * State purity:
 *   `isFailed` is NOT stored as independent React state. It is derived from
 *   `hp` on every render. This guarantees hp and isFailed stay consistent.
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
  FAILURE_HP,
} from "@/lib/game/hp-manager";

export type { StoryPlayerStatus };

export type StoryPlayerError = {
  message: string;
};

export type UseStoryPlayerReturn = {
  playerState: StoryPlayerState;
  currentScene: Scene | null;
  currentContentBlock: SceneContent | null;
  allContentBlocks: SceneContent[] | null;
  currentChapter: { chapter_id: string; title: string } | undefined;
  isComplete: boolean;
  error: StoryPlayerError | null;
  hp: number;
  isFailed: boolean;
  sceneIndex: SceneIndex;
  characterIndex: CharacterIndex;
  advance: () => void;
  completePuzzle: () => void;
  onPuzzleIncorrect: () => void;
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
  const [hp, setHp] = useState<number>(() => initialHp());

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

  const onPuzzleIncorrect = useCallback(() => {
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
