/**
 * CanvasPane — the filled CanvasFrame of the Stage (docs/DESIGN-SYSTEM.md §4.1, §4.2, §4.4).
 *
 * Why: the Kit `CanvasFrame` is only a window. This pane puts the Remotion
 * `StageCanvas` (controls off, `bare`), the lesson/visual/decision scenes and
 * the `PlayerBar` inside it, at 736x414 (desktop) or 366x246 (phone) with a
 * 40 px footer and no overflow. Everything is Kit tokens and Kit components.
 *
 * Puzzle mode (desktop): under the decision canvas sit the question, the
 * feedback (`ErrorLine` for a wrong or empty answer) and one row of
 * `ChoiceButton`s (44 px, min width 112, gap 10) plus `puzzle-submit` /
 * `puzzle-continue`. On phone the choices live in the dialogue box, so the
 * pane shows only the canvas and the caller renders `PuzzleChoices` and
 * `PuzzleActions` itself.
 *
 * Right and wrong come only from `usePuzzleInteraction` (which calls
 * `validateMultipleChoice`). The interaction is passed in, so state can be
 * hoisted above the layout switch. This file does no HP or scoring.
 */

"use client";

import type { PlayerRef } from "@remotion/player";
import { useRef } from "react";
import { ChoiceButton } from "@/components/story/DialogueBox";
import { CanvasFrame, PlayerBar } from "@/components/story/CanvasFrame";
import type { usePuzzleInteraction } from "@/components/story/use-puzzle-interaction";
import { Button } from "@/components/ui/Button";
import { ErrorLine } from "@/components/ui/ErrorLine";
import type { Pacing } from "@/lib/story/pacing";
import { canvasLabel } from "@/lib/stage/playback";
import { useCanvasPlayback } from "@/lib/stage/use-canvas-playback";
import type { Puzzle } from "@/lib/types/puzzle";
import { CANVAS_FPS } from "./canvas-layout";
import { StageCanvas, sceneDurationFrames, type CanvasScene } from "./StageCanvas";

export type PuzzleInteraction = ReturnType<typeof usePuzzleInteraction>;

/** Scenes a CanvasFrame can hold (OQ-12: ambient scenes have no frame). */
export type FramedScene = Exclude<CanvasScene, { kind: "ambient" }>;

export type CanvasPuzzle = {
  puzzle: Puzzle;
  interaction: PuzzleInteraction;
  onComplete: () => void;
};

/** Literal classes so Tailwind can see them. */
const SIZE = {
  desktop: "h-[414px] w-[736px]",
  phone: "h-[246px] w-[366px]",
} as const;

const MAX_CHOICES = 4;
const LETTERS = ["A", "B", "C", "D"] as const;

export function CanvasPane({
  scene,
  sceneKey,
  pacing,
  layout,
  label,
  puzzle,
  className,
}: {
  scene: FramedScene;
  sceneKey: string;
  pacing: Pacing;
  layout: "desktop" | "phone";
  /** Text after `CANVAS /`; made snake_case and clipped to 24 characters. */
  label: string;
  puzzle?: CanvasPuzzle;
  className?: string;
}) {
  const total = sceneDurationFrames(scene);
  const playback = useCanvasPlayback(total, CANVAS_FPS);
  const instance = useRef<PlayerRef | null>(null);
  const setPlayer = (p: PlayerRef | null) => {
    instance.current = p;
    playback.playerRef(p);
  };
  const onPlay = () => {
    const p = instance.current;
    if (!p) return;
    if (playback.ended) p.seekTo(0);
    p.play();
  };

  const named = canvasLabel(label);
  const status = puzzle ? (puzzle.interaction.isCorrect ? "resumed" : "paused") : "playing";
  const showControls = puzzle !== undefined && layout === "desktop";

  return (
    <CanvasFrame
      label={named.ok ? named.label : "scene"}
      status={status}
      className={`${SIZE[layout]} shrink-0 overflow-hidden ${className ?? ""}`}
      footer={<PlayerBar progress={playback.progress} keyframes={[]} time={playback.time} onPlay={onPlay} />}
    >
      <div className="absolute inset-0 flex min-h-0 flex-col">
        <div className="min-h-0 flex-1 px-2 py-2" style={{ containerType: "size" }}>
          <StageCanvas scene={scene} sceneKey={sceneKey} pacing={pacing} playerRef={setPlayer} bare />
        </div>
        {showControls && puzzle && (
          <div
            data-testid="puzzle-interaction"
            role="region"
            aria-label={`Puzzle: ${puzzle.puzzle.question}`}
            className="flex shrink-0 flex-col items-center gap-2.5 px-4 pb-2"
          >
            <PuzzleFeedback puzzle={puzzle.puzzle} interaction={puzzle.interaction} />
            <div className="flex max-h-24 max-w-full items-center justify-center gap-2.5 overflow-y-auto">
              <PuzzleChoices puzzle={puzzle.puzzle} interaction={puzzle.interaction} />
              <PuzzleActions interaction={puzzle.interaction} onComplete={puzzle.onComplete} />
            </div>
          </div>
        )}
      </div>
    </CanvasFrame>
  );
}

/** Question line plus the answer feedback (`aria-live`). */
export function PuzzleFeedback({ puzzle, interaction }: { puzzle: Puzzle; interaction: PuzzleInteraction }) {
  const r = interaction.lastResult;
  return (
    <div aria-live="polite" className="max-h-14 w-full overflow-y-auto text-center font-mono text-xs leading-[1.5]">
      <p data-testid="puzzle-question" className="text-muted">
        {puzzle.question}
      </p>
      {r && r.outcome === "correct" && (
        <div data-testid="puzzle-feedback" role="status">
          <span className="text-gold">Correct. </span>
          <span className="text-cream">{r.feedback}</span>
          <span data-testid="puzzle-explanation" className="block text-muted">
            {r.explanation}
          </span>
        </div>
      )}
      {r && r.outcome === "incorrect" && (
        <ErrorLine data-testid="puzzle-feedback" className="justify-center text-left">
          Not quite. {r.feedback}
        </ErrorLine>
      )}
      {r && (r.outcome === "empty" || r.outcome === "unknown_choice") && (
        <ErrorLine data-testid="puzzle-empty-error" className="justify-center text-left">
          {r.feedback}
        </ErrorLine>
      )}
    </div>
  );
}

/** The answer chips, at most four, as `aria-pressed` toggle buttons. */
export function PuzzleChoices({
  puzzle,
  interaction,
  gapClass = "gap-2.5",
}: {
  puzzle: Puzzle;
  interaction: PuzzleInteraction;
  /** Tailwind gap class; the phone dialogue box uses `gap-1.5`. */
  gapClass?: string;
}) {
  return (
    <div data-testid="puzzle-choices" role="group" aria-label="Answer choices" className={`flex min-w-0 flex-1 ${gapClass}`}>
      {puzzle.choices.slice(0, MAX_CHOICES).map((choice, i) => {
        const selected = interaction.selectedChoiceId === choice.choice_id;
        return (
          <ChoiceButton
            key={choice.choice_id}
            label={choice.text}
            letter={LETTERS[i]}
            testId={`choice-${choice.choice_id}`}
            ariaPressed={selected}
            disabled={interaction.isCorrect}
            state={selected ? (interaction.isCorrect ? "correct" : "picked") : "idle"}
            onClick={() => interaction.select(choice.choice_id)}
          />
        );
      })}
    </div>
  );
}

/** `puzzle-submit` until the answer is right, then `puzzle-continue`. */
export function PuzzleActions({
  interaction,
  onComplete,
  className = "shrink-0",
}: {
  interaction: PuzzleInteraction;
  onComplete: () => void;
  className?: string;
}) {
  if (interaction.isCorrect) {
    return (
      <Button data-testid="puzzle-continue" className={className} onClick={onComplete}>
        Continue →
      </Button>
    );
  }
  return (
    <Button
      data-testid="puzzle-submit"
      className={className}
      variant={interaction.canSubmit ? "primary" : "disabled"}
      onClick={interaction.submit}
    >
      {interaction.isSubmitting ? "Submitting…" : interaction.selectedBranches ? "Confirm choice →" : "Submit Answer"}
    </Button>
  );
}
