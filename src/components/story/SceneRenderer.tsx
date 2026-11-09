/**
 * SceneRenderer
 *
 * Dispatches rendering based on the current scene type.
 * Manages the "revealed so far" content log and handles interaction:
 * - Content scenes: show blocks one by one, continue button reveals next.
 * - Puzzle scenes: show PuzzlePlaceholder.
 * - Ending scenes: show EndingDisplay.
 *
 * The story log grows as blocks are revealed. This creates the visual
 * novel chat-log feel described in DESIGN.md §5.3.
 */

"use client";

import { useRef, useEffect } from "react";
import type { Scene } from "@/lib/types/scene";
import type { StoryBlueprint } from "@/lib/types/story";
import type { CharacterIndex } from "@/lib/story/story-player";
import { getSceneContentBlocks } from "@/lib/story/story-player";
import { ContentBlockRenderer } from "./ContentBlockRenderer";
import { PuzzleInteraction } from "./PuzzleInteraction";
import { EndingDisplay } from "./EndingDisplay";
import type { StoryPlayerStatus } from "@/lib/story/use-story-player";

type SceneRendererProps = {
  scene: Scene;
  story: StoryBlueprint;
  contentIndex: number;
  status: StoryPlayerStatus;
  characterIndex: CharacterIndex;
  onAdvance: () => void;
  onPuzzleComplete: () => void;
  /** Called once per incorrect puzzle submission (HP deduction). */
  onPuzzleIncorrect?: () => void;
  /**
   * Called once per valid puzzle submission (correct or incorrect).
   * Used for knowledge tracking. Receives `correct` flag.
   */
  onPuzzleAnswerSubmitted?: (correct: boolean) => void;
  /** When true, puzzle interaction is fully disabled (story failed). */
  isFailed?: boolean;
};

export function SceneRenderer({
  scene,
  story,
  contentIndex,
  status,
  characterIndex,
  onAdvance,
  onPuzzleComplete,
  onPuzzleIncorrect,
  onPuzzleAnswerSubmitted,
  isFailed = false,
}: SceneRendererProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content is revealed
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [contentIndex, scene.scene_id]);

  // ── Ending scene ──────────────────────────────────────────────────────────
  if (scene.type === "ending") {
    const ending = story.endings.find((e) => e.ending_id === scene.ending_id);
    if (!ending) {
      return (
        <div
          data-testid="scene-error"
          className="p-4 rounded"
          style={{ backgroundColor: "var(--background-panel)", color: "#eb5757" }}
          role="alert"
        >
          Ending &quot;{scene.ending_id}&quot; not found.
        </div>
      );
    }
    return <EndingDisplay ending={ending} />;
  }

  // ── Puzzle scene ──────────────────────────────────────────────────────────
  if (scene.type === "puzzle") {
    const puzzle = story.puzzles.find((p) => p.puzzle_id === scene.puzzle_id);
    if (!puzzle) {
      return (
        <div
          data-testid="scene-error"
          className="p-4 rounded"
          style={{ backgroundColor: "var(--background-panel)", color: "#eb5757" }}
          role="alert"
        >
          Puzzle &quot;{scene.puzzle_id}&quot; not found.
        </div>
      );
    }
    return (
      <PuzzleInteraction
        puzzle={puzzle}
        onComplete={onPuzzleComplete}
        onIncorrect={onPuzzleIncorrect}
        onAnswerSubmitted={onPuzzleAnswerSubmitted}
        isFailed={isFailed}
      />
    );
  }

  // ── Content scene (narrative / learning / interaction / consequence) ───────
  const allBlocks = getSceneContentBlocks(scene) ?? [];
  // Show only blocks up to and including the current index
  const revealedBlocks = allBlocks.slice(0, contentIndex + 1);
  const isSceneEnd = status === "scene_end";

  return (
    <div className="flex flex-col gap-4" data-testid="scene-content">
      {revealedBlocks.map((block, idx) => (
        <ContentBlockRenderer
          key={`${scene.scene_id}-block-${idx}`}
          block={block}
          characterIndex={characterIndex}
        />
      ))}

      {/* Scroll anchor */}
      <div ref={bottomRef} />

      {/* Continue button — hidden only when story is complete */}
      {status !== "story_complete" && (
        <div className="flex justify-center pt-2 pb-4">
          <button
            onClick={onAdvance}
            data-testid="continue-button"
            className="flex items-center gap-2 px-6 py-2 rounded text-sm font-medium transition-opacity hover:opacity-80 active:opacity-60"
            style={{
              backgroundColor: "var(--background-panel)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border)",
              color: "var(--foreground-muted)",
            }}
            aria-label="Continue story"
          >
            <span>{isSceneEnd ? "Next ›" : "Continue"}</span>
            <span aria-hidden="true" style={{ color: "var(--accent-gold)" }}>
              ▾
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
