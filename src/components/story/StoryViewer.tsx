/**
 * StoryViewer
 *
 * The main story display component.
 * Implements the three-column layout from DESIGN.md §5.1.
 *
 * Milestone 6 additions:
 *   - onKnowledgeUpdate prop: called when a learning_info block is revealed
 *     or a puzzle answer is submitted. Wires into useCampaign.
 *   - Scene-entry learning detection: when the player advances into a scene
 *     that contains learning_info blocks, concepts are marked as introduced.
 *   - Puzzle answer tracking: each submission is forwarded up with
 *     isFirstAttempt derived from useStoryPlayer.isPuzzleFirstAttempt.
 */

"use client";

import { useEffect, useCallback, useRef } from "react";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Character } from "@/lib/types/campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import { useStoryPlayer } from "@/lib/story/use-story-player";
import { StoryHeader } from "./StoryHeader";
import { SceneRenderer } from "./SceneRenderer";
import { StoryFailure } from "./StoryFailure";
import { StoryComplete } from "./StoryComplete";
import { MAX_HP } from "@/lib/game/hp-manager";
import {
  getOrCreateKnowledge,
  recordLearningExposure,
  recordPuzzleSubmission,
  getConceptIdsFromScene,
} from "@/lib/game/knowledge-manager";

type StoryViewerProps = {
  story: StoryBlueprint;
  characters: Character[];
  /** Called when the player completes the story and chooses "Continue Campaign". */
  onStoryComplete?: (opts?: {
    worldStateChanges?: Record<string, number>;
    relationshipChanges?: Record<string, number>;
    outcomeDescription?: string;
  }) => void;
  /** Called when the player exits the story (from sidebar or from completion screen). */
  onExit?: () => void;
  /** True when this was the last story — alters the completion screen. */
  isCampaignComplete?: boolean;
  /**
   * Called when knowledge state needs updating (learning exposure or puzzle answer).
   * Provided by useCampaign via game/page.tsx.
   */
  onKnowledgeUpdate?: (updates: Record<string, PlayerKnowledge>) => void;
  /**
   * The current player_knowledge map from CampaignState.
   * Used to build knowledge update objects with the latest state.
   */
  playerKnowledge?: Record<string, PlayerKnowledge>;
};

export function StoryViewer({
  story,
  characters,
  onStoryComplete,
  onExit,
  isCampaignComplete = false,
  onKnowledgeUpdate,
  playerKnowledge = {},
}: StoryViewerProps) {
  const {
    playerState,
    currentScene,
    currentChapter,
    isComplete,
    error,
    hp,
    isFailed,
    characterIndex,
    advance,
    completePuzzle,
    onPuzzleIncorrect,
    retryStory,
  } = useStoryPlayer(story, characters);

  // Keep a ref to the latest playerKnowledge so that the puzzle answer
  // handler always reads the most recent evidence without needing to re-create
  // the callback on every render (which would risk stale closure bugs and
  // React warnings about unnecessary re-renders).
  const playerKnowledgeRef = useRef(playerKnowledge);
  useEffect(() => {
    playerKnowledgeRef.current = playerKnowledge;
  });

  // ── Learning exposure: when entering a scene, record learning_info concepts ─
  useEffect(() => {
    if (!currentScene) return;
    if (!onKnowledgeUpdate) return;

    const conceptIds = getConceptIdsFromScene(story, currentScene.scene_id);
    if (conceptIds.length === 0) return;

    const updates: Record<string, PlayerKnowledge> = {};
    for (const conceptId of conceptIds) {
      const current = getOrCreateKnowledge(playerKnowledge, conceptId);
      const updated = recordLearningExposure(current, currentScene.scene_id);
      if (updated !== current) {
        updates[conceptId] = updated;
      }
    }
    if (Object.keys(updates).length > 0) {
      onKnowledgeUpdate(updates);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScene?.scene_id, story.story_id]);
  // ^ Intentionally excludes playerKnowledge and onKnowledgeUpdate from deps
  //   to avoid infinite loops. Scene entry fires once per scene_id change.

  // ── Puzzle answer handler ─────────────────────────────────────────────────
  // isFirstAttempt is derived from accumulated CampaignState evidence inside
  // recordPuzzleSubmission. We read playerKnowledge from a ref to ensure we
  // always see the latest state — critical for the feedback-rule correctness.
  const handlePuzzleAnswerSubmitted = useCallback(
    (correct: boolean) => {
      if (!currentScene || currentScene.type !== "puzzle") return;

      const puzzleId = currentScene.puzzle_id;
      const puzzle = story.puzzles.find((p) => p.puzzle_id === puzzleId);
      if (!puzzle) return;

      if (onKnowledgeUpdate) {
        const latestKnowledge = playerKnowledgeRef.current;
        const updates: Record<string, PlayerKnowledge> = {};
        for (const conceptId of puzzle.concept_ids) {
          const current = getOrCreateKnowledge(latestKnowledge, conceptId);
          const updated = recordPuzzleSubmission(current, puzzleId, correct);
          if (updated !== current) {
            updates[conceptId] = updated;
          }
        }
        if (Object.keys(updates).length > 0) {
          onKnowledgeUpdate(updates);
        }
      }
    },
    [currentScene, story.puzzles, onKnowledgeUpdate]
    // playerKnowledgeRef is stable and always current — no need to include it.
  );

  // ── Navigation error state ─────────────────────────────────────────────────
  if (error) {
    return (
      <div
        data-testid="story-viewer-error"
        className="flex h-full items-center justify-center p-8"
        role="alert"
        aria-live="assertive"
      >
        <div
          className="rounded-lg p-6 max-w-md text-center"
          style={{
            backgroundColor: "var(--background-panel)",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#6a2d2d",
          }}
        >
          <p
            className="text-xs font-semibold tracking-widest uppercase mb-2"
            style={{ color: "#eb5757" }}
          >
            Navigation Error
          </p>
          <p className="text-sm" style={{ color: "var(--foreground-muted)" }}>
            {error.message}
          </p>
        </div>
      </div>
    );
  }

  const location = currentScene?.location;

  // Derive ending data for the StoryComplete callback
  function handleContinueCampaign() {
    // Pull world/relationship changes from the active ending, if available
    const endingScene = story.chapters
      .flatMap((c) => c.scenes)
      .find((s) => s.type === "ending");
    let worldStateChanges: Record<string, number> | undefined;
    let relationshipChanges: Record<string, number> | undefined;
    let outcomeDescription: string | undefined;

    if (endingScene?.type === "ending") {
      const ending = story.endings.find(
        (e) => e.ending_id === endingScene.ending_id
      );
      if (ending) {
        worldStateChanges = ending.world_state_changes;
        relationshipChanges = ending.relationship_changes;
        outcomeDescription = ending.title;
      }
    }

    onStoryComplete?.({ worldStateChanges, relationshipChanges, outcomeDescription });
  }

  return (
    <div
      data-testid="story-viewer"
      className="lore-bg flex h-full overflow-hidden"
    >
      {/* ── Left Sidebar ──────────────────────────────────────────────────── */}
      <aside
        data-testid="left-sidebar"
        className="flex-shrink-0 w-14 flex flex-col items-center py-6 gap-4"
        style={{
          backgroundColor: "var(--background-panel)",
          borderRightWidth: "1px",
          borderRightStyle: "solid",
          borderRightColor: "var(--border)",
        }}
        aria-label="Story navigation"
      >
        {/* LORE logo mark */}
        <div
          className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--foreground)",
          }}
          aria-label="LORE"
        >
          L
        </div>

        <div className="flex-1" />

        {/* Exit button — active in Milestone 5 */}
        <button
          data-testid="sidebar-exit-button"
          onClick={onExit}
          disabled={!onExit}
          className="w-7 h-7 flex items-center justify-center rounded text-xs transition-opacity hover:opacity-70"
          style={{
            color: onExit ? "var(--foreground-muted)" : "var(--foreground-faint)",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "var(--border-subtle)",
            cursor: onExit ? "pointer" : "not-allowed",
          }}
          aria-label="Exit story"
          title="Exit story"
        >
          ×
        </button>
      </aside>

      {/* ── Main Story Area ───────────────────────────────────────────────── */}
      <main
        data-testid="story-main"
        className="flex flex-col flex-1 min-w-0 overflow-hidden"
      >
        {/* Sticky header */}
        <StoryHeader
          storyTitle={story.title}
          chapterTitle={currentChapter?.title}
          location={location}
        />

        {/* ── Story Failure Overlay ─────────────────────────────────────── */}
        {isFailed ? (
          <StoryFailure storyTitle={story.title} onRetry={retryStory} />
        ) : (
          /* ── Scrollable story content ─────────────────────────────────── */
          <div
            className="flex-1 overflow-y-auto px-6 pt-6 pb-2"
            style={{ maxWidth: "720px", margin: "0 auto", width: "100%" }}
            aria-live="polite"
            aria-atomic="false"
            aria-label="Story content"
          >
            {currentScene ? (
              <SceneRenderer
                scene={currentScene}
                story={story}
                contentIndex={playerState.contentIndex}
                status={playerState.status}
                characterIndex={characterIndex}
                onAdvance={advance}
                onPuzzleComplete={completePuzzle}
                onPuzzleIncorrect={onPuzzleIncorrect}
                onPuzzleAnswerSubmitted={handlePuzzleAnswerSubmitted}
                isFailed={isFailed}
              />
            ) : (
              <p style={{ color: "var(--foreground-faint)" }}>Loading scene…</p>
            )}

            {/* Story Complete panel — shown below the ending scene content */}
            {isComplete && (
              <StoryComplete
                storyTitle={story.title}
                onContinue={handleContinueCampaign}
                onExit={onExit ?? (() => {})}
                isCampaignComplete={isCampaignComplete}
              />
            )}
          </div>
        )}
      </main>

      {/* ── Right Sidebar ─────────────────────────────────────────────────── */}
      <aside
        data-testid="right-sidebar"
        className="flex-shrink-0 w-48 flex flex-col py-6 px-4 gap-3"
        style={{
          backgroundColor: "var(--background-panel)",
          borderLeftWidth: "1px",
          borderLeftStyle: "solid",
          borderLeftColor: "var(--border)",
        }}
        aria-label="Story progress"
      >
        {/* Story title */}
        <div>
          <p
            className="text-xs tracking-widest uppercase mb-1"
            style={{ color: "var(--foreground-faint)" }}
          >
            Story
          </p>
          <p
            className="text-sm font-medium leading-5"
            style={{ color: "var(--foreground)" }}
          >
            {story.title}
          </p>
        </div>

        <div className="lore-divider" />

        {/* Chapter progress */}
        <div>
          <p
            className="text-xs tracking-widest uppercase mb-1"
            style={{ color: "var(--foreground-faint)" }}
          >
            Chapter
          </p>
          {story.chapters.map((chapter, idx) => {
            const isCurrent = chapter.chapter_id === currentChapter?.chapter_id;
            return (
              <div
                key={chapter.chapter_id}
                className="flex items-start gap-2 py-1"
              >
                <span
                  className="text-xs font-mono flex-shrink-0 mt-0.5"
                  style={{
                    color: isCurrent
                      ? "var(--accent-gold)"
                      : "var(--foreground-faint)",
                  }}
                >
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <span
                  className="text-xs leading-5"
                  style={{
                    color: isCurrent
                      ? "var(--foreground)"
                      : "var(--foreground-faint)",
                    fontWeight: isCurrent ? 500 : 400,
                  }}
                >
                  {chapter.title}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex-1" />

        {/* HP display — live state */}
        <div data-testid="hp-display">
          <p
            className="text-xs tracking-widest uppercase mb-1"
            style={{ color: "var(--foreground-faint)" }}
          >
            HP
          </p>
          <p
            className="text-xs mb-1"
            data-testid="hp-value"
            aria-label={`HP: ${hp} of ${MAX_HP}`}
            style={{
              color: isFailed ? "#eb5757" : "var(--foreground-muted)",
            }}
          >
            {hp} / {MAX_HP}
          </p>
          <div className="flex gap-1" aria-hidden="true">
            {Array.from({ length: MAX_HP }).map((_, i) => (
              <span
                key={i}
                className="w-3 h-3 rounded-sm"
                style={{
                  backgroundColor:
                    i < hp ? "var(--accent)" : "var(--border)",
                  opacity: 1,
                }}
              />
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
