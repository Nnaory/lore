/**
 * StoryViewer
 *
 * Full-width three-column layout:
 *   - Left: Fixed 256px sidebar (Exit navigation with warning)
 *   - Center: Flexible width, black background, chat log
 *   - Right: Fixed 256px sidebar (Story progress: chapters, HP)
 *
 * Mobile (<768px): Center full width, sidebars accessible via bottom navbar
 *
 * Theme: Dark sci-fi + gold only
 *   - Sidebars: Brown sci-fi panels
 *   - Center: Pure black
 *   - Chat bubbles: Minimalist (top/bottom lines only)
 *   - Click anywhere on chat area to advance
 */

"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import type { StoryBlueprint } from "@/lib/types/story";
import type { Character } from "@/lib/types/campaign";
import type { PlayerKnowledge } from "@/lib/types/game";
import { useStoryPlayer } from "@/lib/story/use-story-player";
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

const _SIDEBAR_WIDTH = "16rem"; // 256px

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

  // Keep a ref to the latest playerKnowledge
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

  // ── Puzzle answer handler ─────────────────────────────────────────────────
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
  );

  const location = currentScene?.location;

  // Derive ending data for the StoryComplete callback
  function handleContinueCampaign() {
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

  // Confirmation dialog state for exit
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  // Mobile navbar state
  const [mobileSidebar, setMobileSidebar] = useState<"left" | "right" | null>(null);

  // Navigation error state
  const navigationError = error;

  // Click handler for center area - advance story
  const handleCenterClick = useCallback(() => {
    // Only advance if not in a puzzle, not complete, not failed, not showing error
    if (
      currentScene &&
      currentScene.type !== "puzzle" &&
      !isComplete &&
      !isFailed &&
      !navigationError &&
      playerState.status !== "story_complete"
    ) {
      advance();
    }
  }, [currentScene, isComplete, isFailed, navigationError, playerState.status, advance]);

  // Render error or main content
  function renderContent() {
    if (navigationError) {
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
              borderColor: "var(--danger)",
            }}
          >
            <p
              className="text-xs font-semibold tracking-widest uppercase mb-2"
              style={{ color: "var(--danger)" }}
            >
              Navigation Error
            </p>
            <p className="text-sm" style={{ color: "var(--foreground-muted)" }}>
              {navigationError.message}
            </p>
          </div>
        </div>
      );
    }

    return (
      <>
        {/* ── Story Failure Overlay ─────────────────────────────────────── */}
        {isFailed ? (
          <StoryFailure storyTitle={story.title} onRetry={retryStory} />
        ) : (
          <>
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

            {/* Click hint */}
            {currentScene &&
              currentScene.type !== "puzzle" &&
              !isComplete &&
              !isFailed &&
              playerState.status !== "story_complete" && (
                <div
                  className="fixed bottom-4 left-1/2 -translate-x-1/2 pointer-events-none animate-pulse-gold"
                  style={{ zIndex: 10 }}
                  aria-hidden="true"
                >
                  <span
                    className="px-3 py-1.5 rounded text-xs font-mono"
                    style={{
                      backgroundColor: "rgba(232, 197, 71, 0.1)",
                      border: "1px solid var(--border-dim)",
                      color: "var(--accent-gold-dim)",
                    }}
                  >
                    Click anywhere to continue
                  </span>
                </div>
              )}
          </>
        )}
      </>
    );
  }

  return (
    <div
      data-testid="story-viewer"
      className="lore-bg flex h-screen overflow-hidden relative"
    >
      {/* ── Left Sidebar: Navigation / Exit ───────────────────────────────── */}
      <aside
        data-testid="left-sidebar"
        className="flex-shrink-0 flex flex-col lore-panel-bg border-r sidebar-width hidden md:flex"
        style={{
          borderRightColor: "var(--border)",
        }}
        aria-label="Navigation"
      >
        <div className="w-full flex flex-col items-center gap-6 h-full p-6">
          {/* LORE logo mark */}
          <div
            className="w-12 h-12 rounded flex items-center justify-center text-lg font-bold"
            style={{
              backgroundColor: "var(--accent-gold)",
              color: "var(--background)",
              border: "1px solid var(--accent-gold-dim)",
            }}
            aria-label="LORE"
          >
            L
          </div>

          {/* Exit button with warning */}
          <div className="w-full flex flex-col items-center gap-3 mt-auto">
            <button
              data-testid="sidebar-exit-button"
              onClick={() => setShowExitConfirm(true)}
              disabled={!onExit}
              className="w-full px-4 py-2.5 rounded text-sm font-medium transition-all"
              style={{
                backgroundColor: "var(--danger-bg)",
                color: "var(--danger)",
                border: "1px solid var(--danger)",
                cursor: onExit ? "pointer" : "not-allowed",
                opacity: onExit ? 1 : 0.5,
              }}
              aria-label="Exit story"
            >
              Exit Story
            </button>

            {/* Unsaved progress warning */}
            <p
              className="text-xs text-center"
              style={{ color: "var(--foreground-faint)" }}
            >
              Progress is not saved until you complete the story.
            </p>
          </div>
        </div>
      </aside>

      {/* ── Center: Story Content (Flexible Width, Black Background) ────── */}
      <main
        data-testid="story-main"
        className="lore-center-bg flex flex-col flex-1 min-w-0 overflow-hidden relative"
        onClick={handleCenterClick}
      >
        {/* Sticky header — only on desktop, hidden on mobile (navbar shows info) */}
        <div
          data-testid="story-header"
          className="hidden md:flex md:flex-shrink-0 border-b px-6 py-3"
          style={{ borderBottomColor: "var(--border-dim)" }}
        >
          <div className="max-w-4xl mx-auto">
            <h2
              className="text-base font-semibold tracking-wide"
              style={{ color: "var(--foreground)" }}
            >
              {location ?? story.title}
            </h2>
            {currentChapter && (
              <p
                className="text-xs tracking-widest uppercase mt-0.5"
                style={{ color: "var(--foreground-faint)" }}
              >
                {currentChapter.title}
              </p>
            )}
          </div>
        </div>

        {/* Vertically scrolling content area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto w-full p-4 md:p-6">
            {renderContent()}
          </div>
        </div>
      </main>

      {/* ── Right Sidebar: Story Progress ─────────────────────────────────── */}
      <aside
        data-testid="right-sidebar"
        className="flex-shrink-0 flex flex-col lore-panel-bg border-l sidebar-width hidden md:flex"
        style={{
          borderLeftColor: "var(--border)",
        }}
        aria-label="Story progress"
      >
        <div className="w-full flex flex-col gap-6 h-full p-6">
          {/* Story title */}
          <div className="w-full border-b pb-4" style={{ borderBottomColor: "var(--border-dim)" }}>
            <p
              className="text-xs tracking-widest uppercase mb-1"
              style={{ color: "var(--foreground-faint)" }}
            >
              Story
            </p>
            <p
              data-testid="sidebar-story-title"
              className="text-sm font-medium leading-5 truncate"
              style={{ color: "var(--foreground)" }}
            >
              {story.title}
            </p>
          </div>

          <div className="chat-divider" />

          {/* Chapter progress */}
          <div className="w-full flex-1 overflow-y-auto pr-2">
            <p
              className="text-xs tracking-widest uppercase mb-3"
              style={{ color: "var(--foreground-faint)" }}
            >
              Chapter Progress
            </p>
            <div className="space-y-2">
              {story.chapters.map((chapter, idx) => {
                const isCurrent = chapter.chapter_id === currentChapter?.chapter_id;
                const chapterIndex = story.chapters.findIndex(c => c.chapter_id === currentChapter?.chapter_id);
                const isCompleted = chapterIndex >= 0 && idx < chapterIndex;
                return (
                  <div
                    key={chapter.chapter_id}
                    data-testid={`sidebar-chapter-${chapter.chapter_id}`}
                    className="flex items-center gap-3 p-2.5 rounded transition-all"
                    style={{
                      backgroundColor: isCurrent
                        ? "rgba(232, 197, 71, 0.1)"
                        : "transparent",
                      borderWidth: isCurrent ? "1px" : 0,
                      borderStyle: "solid",
                      borderColor: "var(--accent-gold)",
                    }}
                  >
                    <span
                      className="text-xs font-mono flex-shrink-0 w-6 text-center"
                      style={{
                        color: isCurrent
                          ? "var(--accent-gold)"
                          : isCompleted
                          ? "var(--accent-gold)"
                          : "var(--foreground-faint)",
                      }}
                    >
                      {isCompleted ? "✓" : String(idx + 1).padStart(2, "0")}
                    </span>
                    <span
                      data-testid={`sidebar-chapter-name-${chapter.chapter_id}`}
                      className="text-xs leading-5 truncate"
                      style={{
                        color: isCurrent
                          ? "var(--foreground)"
                          : isCompleted
                          ? "var(--foreground-muted)"
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
          </div>

          <div className="chat-divider" />

          {/* HP display — live state */}
          <div data-testid="hp-display" className="w-full text-center border-t pt-4" style={{ borderTopColor: "var(--border-dim)" }}>
            <p
              className="text-xs tracking-widest uppercase mb-1"
              style={{ color: "var(--foreground-faint)" }}
            >
              HP
            </p>
            <p
              className="text-lg font-mono mb-2"
              data-testid="hp-value"
              aria-label={`HP: ${hp} of ${MAX_HP}`}
              aria-live="polite"
              style={{
                color: isFailed ? "var(--danger)" : "var(--foreground)",
              }}
            >
              {hp} / {MAX_HP}
            </p>
            <div className="flex gap-1 justify-center" aria-hidden="true">
              {Array.from({ length: MAX_HP }).map((_, i) => (
                <span
                  key={i}
                  className="w-2.5 h-2.5 rounded-sm transition-colors"
                  style={{
                    backgroundColor:
                      i < hp ? "var(--accent-gold)" : "var(--border-dim)",
                    opacity: 1,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* ── Mobile Navbar ─────────────────────────────────────────────────── */}
      <nav
        className="navbar md:hidden"
        role="navigation"
        aria-label="Mobile navigation"
      >
        <button
          className="navbar-btn"
          onClick={() => setMobileSidebar(mobileSidebar === "left" ? null : "left")}
          aria-expanded={mobileSidebar === "left"}
          aria-controls="mobile-left-panel"
          aria-label="Menu"
        >
          ☰ Menu
        </button>
        <button
          className="navbar-btn"
          onClick={() => setMobileSidebar(mobileSidebar === "right" ? null : "right")}
          aria-expanded={mobileSidebar === "right"}
          aria-controls="mobile-right-panel"
          aria-label="Progress"
        >
          📖 Progress
        </button>
        <button
          className="navbar-btn"
          onClick={() => setShowExitConfirm(true)}
          aria-label="Exit story"
          style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
        >
          Exit
        </button>
      </nav>

      {/* ── Mobile Left Sidebar Overlay ───────────────────────────────────── */}
      {mobileSidebar === "left" && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          style={{ backgroundColor: "rgba(10, 10, 12, 0.6)" }}
          onClick={() => setMobileSidebar(null)}
          aria-hidden="true"
        >
          <div
            id="mobile-left-panel"
            className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] lore-panel-bg border-r overflow-y-auto"
            style={{
              borderRightColor: "var(--border)",
              transform: "translateX(0)",
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
          >
            <div className="flex flex-col items-center gap-6 h-full p-6">
              <div
                className="w-12 h-12 rounded flex items-center justify-center text-lg font-bold"
                style={{
                  backgroundColor: "var(--accent-gold)",
                  color: "var(--background)",
                  border: "1px solid var(--accent-gold-dim)",
                }}
              >
                L
              </div>

              <div className="w-full flex flex-col items-center gap-3 mt-auto">
                <button
                  data-testid="sidebar-exit-button"
                  onClick={() => {
                    setMobileSidebar(null);
                    setShowExitConfirm(true);
                  }}
                  disabled={!onExit}
                  className="w-full px-4 py-2.5 rounded text-sm font-medium transition-all"
                  style={{
                    backgroundColor: "var(--danger-bg)",
                    color: "var(--danger)",
                    border: "1px solid var(--danger)",
                    cursor: onExit ? "pointer" : "not-allowed",
                    opacity: onExit ? 1 : 0.5,
                  }}
                >
                  Exit Story
                </button>
                <p className="text-xs text-center" style={{ color: "var(--foreground-faint)" }}>
                  Progress is not saved until you complete the story.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile Right Sidebar Overlay ──────────────────────────────────── */}
      {mobileSidebar === "right" && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          style={{ backgroundColor: "rgba(10, 10, 12, 0.6)" }}
          onClick={() => setMobileSidebar(null)}
          aria-hidden="true"
        >
          <div
            id="mobile-right-panel"
            className="fixed inset-y-0 right-0 z-50 w-72 max-w-[85vw] lore-panel-bg border-l overflow-y-auto"
            style={{
              borderLeftColor: "var(--border)",
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Story progress"
          >
            <div className="w-full flex flex-col gap-6 h-full p-6">
              <div className="w-full border-b pb-4" style={{ borderBottomColor: "var(--border-dim)" }}>
                <p className="text-xs tracking-widest uppercase mb-1" style={{ color: "var(--foreground-faint)" }}>
                  Story
                </p>
                <p className="text-sm font-medium leading-5 truncate" style={{ color: "var(--foreground)" }}>
                  {story.title}
                </p>
              </div>

              <div className="chat-divider" />

              <div className="w-full flex-1 overflow-y-auto pr-2">
                <p className="text-xs tracking-widest uppercase mb-3" style={{ color: "var(--foreground-faint)" }}>
                  Chapter Progress
                </p>
                <div className="space-y-2">
                  {story.chapters.map((chapter, idx) => {
                    const isCurrent = chapter.chapter_id === currentChapter?.chapter_id;
                    const chapterIndex = story.chapters.findIndex(c => c.chapter_id === currentChapter?.chapter_id);
                    const isCompleted = chapterIndex >= 0 && idx < chapterIndex;
                    return (
                      <div
                        key={chapter.chapter_id}
                        className="flex items-center gap-3 p-2.5 rounded transition-all"
                        style={{
                          backgroundColor: isCurrent
                            ? "rgba(232, 197, 71, 0.1)"
                            : "transparent",
                          borderWidth: isCurrent ? "1px" : 0,
                          borderStyle: "solid",
                          borderColor: "var(--accent-gold)",
                        }}
                      >
                        <span
                          className="text-xs font-mono flex-shrink-0 w-6 text-center"
                          style={{
                            color: isCurrent
                              ? "var(--accent-gold)"
                              : isCompleted
                              ? "var(--accent-gold)"
                              : "var(--foreground-faint)",
                          }}
                        >
                          {isCompleted ? "✓" : String(idx + 1).padStart(2, "0")}
                        </span>
                        <span
                          className="text-xs leading-5 truncate"
                          style={{
                            color: isCurrent
                              ? "var(--foreground)"
                              : isCompleted
                              ? "var(--foreground-muted)"
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
              </div>

              <div className="chat-divider" />

              <div data-testid="hp-display" className="w-full text-center border-t pt-4" style={{ borderTopColor: "var(--border-dim)" }}>
                <p className="text-xs tracking-widest uppercase mb-1" style={{ color: "var(--foreground-faint)" }}>
                  HP
                </p>
                <p
                  className="text-lg font-mono mb-2"
                  data-testid="hp-value"
                  aria-label={`HP: ${hp} of ${MAX_HP}`}
                  aria-live="polite"
                  style={{ color: isFailed ? "var(--danger)" : "var(--foreground)" }}
                >
                  {hp} / {MAX_HP}
                </p>
                <div className="flex gap-1 justify-center" aria-hidden="true">
                  {Array.from({ length: MAX_HP }).map((_, i) => (
                    <span
                      key={i}
                      className="w-2.5 h-2.5 rounded-sm transition-colors"
                      style={{
                        backgroundColor: i < hp ? "var(--accent-gold)" : "var(--border-dim)",
                        opacity: 1,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Exit confirmation dialog (shared) */}
      {showExitConfirm && (
        <div
          data-testid="exit-confirm-dialog"
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: "rgba(10, 10, 12, 0.8)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="exit-confirm-title"
        >
          <div
            className="rounded-lg p-6 max-w-sm w-full mx-4"
            style={{
              backgroundColor: "var(--background-panel)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border)",
            }}
          >
            <h3
              id="exit-confirm-title"
              className="text-sm font-semibold mb-3"
              style={{ color: "var(--foreground)" }}
            >
              Exit Story?
            </h3>
            <p className="text-sm mb-4" style={{ color: "var(--foreground-muted)" }}>
              Your progress in this story will be lost. You can retry the story later, but you&apos;ll start from the beginning.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowExitConfirm(false)}
                className="flex-1 px-4 py-2 rounded text-sm font-medium transition-all"
                style={{
                  backgroundColor: "transparent",
                  color: "var(--foreground-muted)",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowExitConfirm(false);
                  onExit?.();
                }}
                className="flex-1 px-4 py-2 rounded text-sm font-medium transition-all"
                style={{
                  backgroundColor: "var(--danger-bg)",
                  color: "var(--danger)",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--danger)",
                }}
              >
                Exit Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}