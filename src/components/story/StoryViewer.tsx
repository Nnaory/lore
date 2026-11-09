/**
 * StoryViewer
 *
 * The main story display component.
 * Implements the three-column layout from DESIGN.md §5.1:
 *   Left sidebar  | Main story area | Right sidebar
 *
 * - Left sidebar: navigation (exit action — Milestone 5)
 * - Main story area: sticky header + scrollable content
 * - Right sidebar: chapter progress + live HP display
 *
 * Milestone 5 additions:
 *   - onStoryComplete: called when the player reaches a story ending and
 *     chooses to record completion and advance the campaign.
 *   - onExit: called when the player exits mid-story or from the
 *     completion screen. Does NOT mark the story complete.
 *   - isCampaignComplete: controls what StoryComplete shows.
 *   - StoryComplete screen replaces the passive "— End of Story —" text.
 *   - Exit button in the left sidebar is now active.
 */

"use client";

import type { StoryBlueprint } from "@/lib/types/story";
import type { Character } from "@/lib/types/campaign";
import { useStoryPlayer } from "@/lib/story/use-story-player";
import { StoryHeader } from "./StoryHeader";
import { SceneRenderer } from "./SceneRenderer";
import { StoryFailure } from "./StoryFailure";
import { StoryComplete } from "./StoryComplete";
import { MAX_HP } from "@/lib/game/hp-manager";

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
};

export function StoryViewer({
  story,
  characters,
  onStoryComplete,
  onExit,
  isCampaignComplete = false,
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
