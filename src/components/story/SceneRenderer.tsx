/**
 * SceneRenderer
 *
 * Dispatches rendering based on the current scene type.
 * Manages the "revealed so far" content log.
 * - Content scenes: show blocks one by one, click anywhere to advance.
 * - Puzzle scenes: show PuzzleInteraction.
 * - Ending scenes: show EndingDisplay.
 *
 * No continue button — click anywhere on chat area to advance.
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
  onAdvance: _onAdvance,
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
          style={{ backgroundColor: "var(--background-panel)", color: "var(--danger)" }}
          role="alert"
        >
          Ending not found for {scene.ending_id}.
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
  const _isSceneEnd = status === "scene_end";

  return (
    <div className="flex flex-col gap-3" data-testid="scene-content">
      {revealedBlocks.map((block, idx) => (
        <ContentBlockRenderer
          key={`${scene.scene_id}-block-${idx}`}
          block={block}
          characterIndex={characterIndex}
        />
      ))}

      {/* Scroll anchor */}
      <div ref={bottomRef} />

      {/* No continue button — click anywhere on chat area to advance */}
    </div>
  );
}