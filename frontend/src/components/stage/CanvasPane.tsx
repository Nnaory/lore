/**
 * CanvasPane — the filled CanvasFrame of the Stage (docs/DESIGN-SYSTEM.md §4.1, §4.2, §4.4).
 *
 * Why: the Kit `CanvasFrame` is only a window. This pane puts the Remotion
 * `StageCanvas` (controls off, `bare`), the lesson/visual/decision scenes and
 * the `PlayerBar` inside it, at 736x414 (desktop) or 366x246 (phone) with a
 * 40 px footer and no overflow. Everything is Kit tokens and Kit components.
 *
 * The player the bar drives is typed `PlayerLike` (the four events and three methods the bar
 * uses), so the Remotion player and the sandbox player of an `animation` scene fit the same
 * `useCanvasPlayback`, `PlayerBar` and `onPlay` (design 7.6, Requirement 30.3).
 *
 * Animation scene (Requirements 30.8, 31.14): the pane keeps the status the scene reports, as
 * `{key, value}` like `StageCanvas` does. While the iframe is shown (`playing` or `paused`) the bar
 * has the animation's length and one pause marker at `pause_at_frame / duration * 100` (none for a
 * lesson). In every other status (`loading`, `failed:<phase>`) the bar has the Fallback_Scene's
 * length and markers, so it does not jump. For any other scene nothing changes. The puzzle's
 * `isCorrect` goes to the canvas as `answerCorrect`, so the animation can continue past its question;
 * the pane still never decides what is right.
 *
 * Puzzle mode (desktop): the canvas draws the AI's picture of the problem and the
 * question itself (`kind: "puzzle"`, or `"decision"` when there is no picture), so
 * under it sit only the feedback (`ErrorLine` for a wrong or empty answer) and one
 * row of `ChoiceButton`s (at least 44 px tall, they grow to four lines so no answer
 * is cut off, min width 112, gap 10) plus `puzzle-submit` / `puzzle-continue`. The
 * question stays in the DOM for screen readers. On phone the choices live in the
 * dialogue box, so the pane shows only the canvas and the caller renders
 * `PuzzleChoices` and `PuzzleActions` itself.
 *
 * Voice council: when the caller passes `voices` (who "says" each answer, see
 * `lib/story/voice-council.ts`), a puzzle with no picture or animation (desktop) draws its answers
 * as `VoiceCouncil` inside the frame instead of the question-only canvas; with a picture the canvas
 * stays and the answer buttons name their speakers. Selecting a voice is selecting an answer.
 *
 * Right and wrong come only from `usePuzzleInteraction` (which calls
 * `validateMultipleChoice`). The interaction is passed in, so state can be
 * hoisted above the layout switch. This file does no HP or scoring.
 */

"use client";

import { useRef, useState } from "react";
import { ChoiceButton } from "@/components/story/DialogueBox";
import { CanvasFrame, PlayerBar } from "@/components/story/CanvasFrame";
import type { usePuzzleInteraction } from "@/components/story/use-puzzle-interaction";
import { Button } from "@/components/ui/Button";
import { ErrorLine } from "@/components/ui/ErrorLine";
import type { AnimationStatus } from "@/lib/animation/scene-status";
import {
  iframeShown,
  pauseKeyframes,
  sceneKeyframes,
  statusForScene,
  type CanvasAnimationStatus,
} from "@/lib/stage/canvas-timeline";
import type { PlayerLike } from "@/lib/stage/player-like";
import type { Pacing } from "@/lib/story/pacing";
import { canvasLabel } from "@/lib/stage/playback";
import { useCanvasPlayback } from "@/lib/stage/use-canvas-playback";
import type { Puzzle } from "@/lib/types/puzzle";
import { VOICE_NAME_CLASS, type CouncilLanguage, type Voice } from "@/lib/story/voice-council";
import { CANVAS_FPS } from "./canvas-layout";
import { StageCanvas, sceneDurationFrames, type CanvasScene } from "./StageCanvas";
import { VoiceCouncil } from "./VoiceCouncil";

export type PuzzleInteraction = ReturnType<typeof usePuzzleInteraction>;

/** Scenes a CanvasFrame can hold (OQ-12: ambient scenes have no frame). */
export type FramedScene = Exclude<CanvasScene, { kind: "ambient" }>;

export type CanvasPuzzle = {
  puzzle: Puzzle;
  interaction: PuzzleInteraction;
  onComplete: () => void;
  /** Who says each answer. With two or more voices the answers are drawn as a voice council. */
  voices?: Voice[];
  /** Language of the council's own words (title, "Trust <name>"). Default English. */
  language?: CouncilLanguage;
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
  const animation = scene.kind === "animation" ? scene.props : null;
  /** Last status the animation scene reported, with the key of the scene that reported it. */
  const [reported, setReported] = useState<{ key: string; value: AnimationStatus } | null>(null);
  const animationStatus: CanvasAnimationStatus =
    animation === null ? "off" : statusForScene(reported, sceneKey);
  /** The animation, while its iframe is on screen; otherwise `null` and the bar follows a Remotion scene. */
  const shownAnimation = animation !== null && iframeShown(animationStatus) ? animation.animation : null;
  /** The scene the bar follows: the Fallback_Scene of an animation that is not shown, else the scene. */
  const barScene: CanvasScene = animation !== null && shownAnimation === null ? animation.fallback : scene;

  const total = sceneDurationFrames(barScene);
  const playback = useCanvasPlayback(total, CANVAS_FPS);
  const instance = useRef<PlayerLike | null>(null);
  const setPlayer = (p: PlayerLike | null) => {
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
  // A puzzle with no picture or animation (the canvas would only repeat the question) gets the
  // voice council in its place; with a picture the canvas stays and the answers name their speakers.
  const council =
    showControls && puzzle && scene.kind === "decision" && (puzzle.voices?.length ?? 0) >= 2 ? puzzle : null;
  const keyframes =
    shownAnimation !== null
      ? pauseKeyframes(shownAnimation.duration_in_frames, shownAnimation.pause_at_frame)
      : sceneKeyframes(barScene.kind);

  return (
    <div className={showControls ? "flex w-[736px] flex-col items-center gap-2.5" : undefined}>
      <CanvasFrame
        label={named.ok ? named.label : "scene"}
        status={status}
        className={`${SIZE[layout]} shrink-0 overflow-hidden ${className ?? ""}`}
        footerless={council !== null}
        footer={<PlayerBar progress={playback.progress} keyframes={keyframes} time={playback.time} onPlay={onPlay} />}
      >
        {council ? (
          <VoiceCouncil
            question={council.puzzle.question}
            voices={council.voices ?? []}
            language={council.language ?? "en"}
            selectedChoiceId={council.interaction.selectedChoiceId}
            locked={council.interaction.isCorrect}
            onSelect={council.interaction.select}
          />
        ) : (
          <div className="absolute inset-0 flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 px-1 py-1" style={{ containerType: "size" }}>
              <StageCanvas
                scene={scene}
                sceneKey={sceneKey}
                pacing={pacing}
                playerRef={setPlayer}
                answerCorrect={puzzle?.interaction.isCorrect}
                onAnimationStatus={(value) => setReported({ key: sceneKey, value })}
                bare
              />
            </div>
          </div>
        )}
      </CanvasFrame>
      {showControls && puzzle && (
        <div
          data-testid="puzzle-interaction"
          role="region"
          aria-label={`Puzzle: ${puzzle.puzzle.question}`}
          className="flex w-full flex-col items-center gap-2.5"
        >
          <PuzzleFeedback
            puzzle={puzzle.puzzle}
            interaction={puzzle.interaction}
            hideQuestion
            surfaceClassName="border border-smoke bg-ink px-3 py-1.5"
            maxHeightClassName="max-h-[76px]"
          />
          <div className="flex max-w-full flex-wrap items-center justify-center gap-2.5">
            {!council && (
              <PuzzleChoices
                puzzle={puzzle.puzzle}
                interaction={puzzle.interaction}
                voices={puzzle.voices}
              />
            )}
            <PuzzleActions interaction={puzzle.interaction} onComplete={puzzle.onComplete} />
          </div>
        </div>
      )}
    </div>
  );
}

function splitLeadPrefix(text: string, pattern: RegExp, fallback: string): [string, string] {
  const m = text.match(pattern);
  return m ? [m[1], text.slice(m[1].length)] : [fallback, text];
}

/**
 * Question line plus the answer feedback (`aria-live`). `hideQuestion` keeps the question for
 * screen readers only, for when the canvas already draws it large.
 */
export function PuzzleFeedback({
  puzzle,
  interaction,
  hideQuestion = false,
  surfaceClassName = "",
  maxHeightClassName = "max-h-24",
}: {
  puzzle: Puzzle;
  interaction: PuzzleInteraction;
  hideQuestion?: boolean;
  /** Visible panel backing applied when a result banner is shown. */
  surfaceClassName?: string;
  maxHeightClassName?: string;
}) {
  const r = interaction.lastResult;
  const correctParts =
    r && r.outcome === "correct"
      ? splitLeadPrefix(r.feedback, /^(correct[.!]?\s*)/i, "Correct. ")
      : null;
  const incorrectText =
    r && r.outcome === "incorrect"
      ? /^(not quite|incorrect)\b/i.test(r.feedback)
        ? r.feedback
        : `Not quite. ${r.feedback}`
      : "";

  return (
    <div
      aria-live="polite"
      className={
        r
          ? `${maxHeightClassName} w-full overflow-y-auto text-center font-mono text-xs leading-[1.5] ${surfaceClassName}`
          : "text-center font-mono text-xs"
      }
    >
      <p data-testid="puzzle-question" className={hideQuestion ? "sr-only" : "text-muted"}>
        {puzzle.question}
      </p>
      {correctParts && r && r.outcome === "correct" && (
        <div data-testid="puzzle-feedback" role="status">
          <span className="text-gold">{correctParts[0]}</span>
          <span className="text-cream">{correctParts[1]}</span>
          <span data-testid="puzzle-explanation" className="block text-muted">
            {r.explanation}
          </span>
        </div>
      )}
      {r && r.outcome === "incorrect" && (
        <ErrorLine data-testid="puzzle-feedback" className="justify-center text-left">
          {incorrectText}
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

/** The answer chips, at most four, stacked on phone and wrapped row on desktop. */
export function PuzzleChoices({
  puzzle,
  interaction,
  gapClass = "gap-2.5",
  voices,
}: {
  puzzle: Puzzle;
  interaction: PuzzleInteraction;
  /** Tailwind gap class; the phone dialogue box uses `gap-1.5`. */
  gapClass?: string;
  /** Who says each answer; the speaker's name is shown above the answer. */
  voices?: Voice[];
}) {
  return (
    <div
      data-testid="puzzle-choices"
      role="group"
      aria-label="Answer choices"
      className={`flex min-w-0 flex-1 flex-col md:flex-row ${gapClass}`}
    >
      {puzzle.choices.slice(0, MAX_CHOICES).map((choice, i) => {
        const selected = interaction.selectedChoiceId === choice.choice_id;
        const voice = voices?.find((v) => v.choiceId === choice.choice_id);
        return (
          <ChoiceButton
            key={choice.choice_id}
            label={choice.text}
            letter={voice ? undefined : LETTERS[i]}
            speaker={voice ? { name: voice.name, colorClass: VOICE_NAME_CLASS[voice.castId] } : undefined}
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
