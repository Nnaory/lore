/**
 * SceneRenderer
 *
 * Dispatches rendering based on the current scene type.
 * Manages the "revealed so far" content log.
 * - Content scenes: show blocks one by one, click anywhere to advance.
 * - Puzzle scenes: show PuzzleInteraction.
 * - Ending scenes: show EndingDisplay.
 * - Bad-branch scenes: show content blocks, then a "Try Again" button when done.
 *
 * No continue button on normal scenes — click anywhere on chat area to advance.
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
  /** Called once per incorrect puzzle submission that has NO bad branch. */
  onPuzzleIncorrect?: () => void;
  /**
   * Called when a wrong choice that has a bad-branch scene is submitted.
   * Parent deducts HP and navigates to the branch scene.
   */
  onPuzzleBadBranch?: (choiceId: string) => void;
  /**
   * Called once per valid puzzle submission (correct or incorrect).
   * Used for knowledge tracking. Receives `correct` flag.
   */
  onPuzzleAnswerSubmitted?: (correct: boolean) => void;
  /** When true, puzzle interaction is fully disabled (story failed). */
  isFailed?: boolean;
  /**
   * Called when the player clicks "Try Again" at the end of a bad-branch sequence.
   * Returns them to the puzzle scene.
   */
  onReturnToPuzzle?: () => void;
};

export function SceneRenderer({
  scene,
  story,
  contentIndex,
  status,
  characterIndex,
  onAdvance: _onAdvance,
  onPuzzleComplete,
  onPuzzleIncorrect,
  onPuzzleBadBranch,
  onPuzzleAnswerSubmitted,
  isFailed = false,
  onReturnToPuzzle,
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
          style={{ backgroundColor: "var(--background-panel)", color: "var(--danger)" }}
          role="alert"
        >
          Ending not found for {scene.ending_id}.
        </div>
      );
    }
    // Bad-branch ending — show EndingDisplay plus a "Try Again" button
    if (status === "story_complete" && onReturnToPuzzle) {
      return (
        <div className="flex flex-col gap-6">
          <EndingDisplay ending={ending} />
          <div className="flex justify-center">
            <button
              data-testid="bad-ending-return-btn"
              onClick={onReturnToPuzzle}
              className="px-6 py-3 rounded text-sm font-medium transition-all"
              style={{
                backgroundColor: "transparent",
                color: "var(--accent-gold)",
                border: "1px solid var(--accent-gold)",
              }}
            >
              ↩ Try a different choice
            </button>
          </div>
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
          style={{ backgroundColor: "var(--background-panel)", color: "var(--danger)" }}
          role="alert"
        >
          Puzzle not found for {scene.puzzle_id}.
        </div>
      );
    }

    // Build the set of choice_ids that have a bad-branch scene
    const badBranchChoiceIds = scene.on_incorrect_scene_id
      ? new Set(Object.keys(scene.on_incorrect_scene_id))
      : undefined;

    return (
      <PuzzleInteraction
        puzzle={puzzle}
        onComplete={onPuzzleComplete}
        onIncorrect={onPuzzleIncorrect}
        onBadBranch={onPuzzleBadBranch}
        onAnswerSubmitted={onPuzzleAnswerSubmitted}
        isFailed={isFailed}
        badBranchChoiceIds={badBranchChoiceIds}
      />
    );
  }

  // ── Content scene (narrative / learning / interaction / consequence) ───────
  const allBlocks = getSceneContentBlocks(scene) ?? [];
  // Show only blocks up to and including the current index
  const revealedBlocks = allBlocks.slice(0, contentIndex + 1);

  // Bad-branch sequence: when all content is consumed, show "Try Again" button
  const isBadBranchDone =
    status === "bad_branch" && contentIndex >= allBlocks.length;

  return (
    <div className="flex flex-col gap-3" data-testid="scene-content">
      {revealedBlocks.map((block, idx) => (
        <ContentBlockRenderer
          key={`${scene.scene_id}-block-${idx}`}
          block={block}
          characterIndex={characterIndex}
        />
      ))}

      {/* Bad-branch end: offer return to puzzle */}
      {isBadBranchDone && onReturnToPuzzle && (
        <div className="flex justify-center mt-4">
          <button
            data-testid="bad-branch-return-btn"
            onClick={onReturnToPuzzle}
            className="px-6 py-3 rounded text-sm font-medium transition-all"
            style={{
              backgroundColor: "transparent",
              color: "var(--accent-gold)",
              border: "1px solid var(--accent-gold)",
            }}
          >
            ↩ Try a different choice
          </button>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
}
