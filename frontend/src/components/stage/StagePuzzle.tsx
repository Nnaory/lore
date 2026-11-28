/**
 * StagePuzzle — a puzzle played on the stage canvas
 *
 * Why: the canvas draws the decision graph (a node with lines to the answer
 * boxes); each answer box is a clickable HTML button laid over it. Below
 * the canvas, a strip holds the question, feedback and the submit/continue
 * button. Answer rules come from usePuzzleInteraction. Styled with Black Cat
 * Gold Kit token classes only.
 */

"use client";

import type { Puzzle } from "@/lib/types/puzzle";
import type { Pacing } from "@/lib/story/pacing";
import {
  usePuzzleInteraction,
  type PuzzleInteractionCallbacks,
} from "@/components/story/use-puzzle-interaction";
import { StageCanvas } from "./StageCanvas";
import { choiceBoxes } from "./canvas-layout";

type StagePuzzleProps = PuzzleInteractionCallbacks & {
  puzzle: Puzzle;
  pacing: Pacing;
  seed: number;
  onComplete: () => void;
};

export function StagePuzzle({ puzzle, pacing, seed, onComplete, ...callbacks }: StagePuzzleProps) {
  const p = usePuzzleInteraction(puzzle, callbacks);
  const boxes = choiceBoxes(puzzle.choices.length);
  const choices = puzzle.choices.slice(0, 4);

  return (
    <div
      data-testid="puzzle-interaction"
      role="region"
      aria-label={`Puzzle: ${puzzle.question}`}
      className="flex h-full min-h-0 w-full flex-col gap-3"
    >
      <div className="flex min-h-0 flex-1 items-center" style={{ containerType: "size" }}>
        <StageCanvas
          scene={{ kind: "decision", props: { label: "", seed } }}
          sceneKey={`puzzle:${puzzle.puzzle_id}`}
          pacing={pacing}
        >
          <div
            data-testid="puzzle-choices"
            role="radiogroup"
            aria-label="Answer choices"
            className="absolute inset-0"
          >
            {choices.map((choice, i) => {
              const box = boxes[i];
              const selected = p.selectedChoiceId === choice.choice_id;
              const lockedIn = p.isCorrect && selected;
              const wrong = selected && p.interactionState === "incorrect";
              const stateClass = lockedIn
                ? "border-2 border-gold bg-ink text-gold"
                : wrong
                  ? "border-2 border-ember bg-ink text-ember"
                  : selected
                    ? "border-2 border-cream bg-ink text-cream"
                    : "border-2 border-smoke bg-ink/80 text-cream";
              return (
                <button
                  key={choice.choice_id}
                  type="button"
                  data-testid={`choice-${choice.choice_id}`}
                  aria-pressed={selected}
                  disabled={p.isCorrect}
                  onClick={() => p.select(choice.choice_id)}
                  className={`absolute overflow-y-auto p-[1.2%] text-left ${stateClass} ${
                    p.isCorrect && !selected ? "opacity-40" : "opacity-100"
                  } ${p.isCorrect ? "cursor-default" : "cursor-pointer"}`}
                  style={{
                    left: `${box.x}%`,
                    top: `${box.y}%`,
                    width: `${box.w}%`,
                    height: `${box.h}%`,
                    fontSize: "clamp(10px, 1.25vw, 15px)",
                    lineHeight: 1.35,
                  }}
                >
                  <span className="mb-1 block font-mono text-[0.85em] text-gold">
                    {String.fromCharCode(65 + i)}
                  </span>
                  {choice.text}
                </button>
              );
            })}
          </div>
        </StageCanvas>
      </div>

      <div className="flex flex-col gap-3 border-2 border-smoke bg-ink px-4 py-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="text-sm font-medium text-cream" data-testid="puzzle-question">
            {puzzle.question}
          </p>
          {p.lastResult &&
            p.lastResult.outcome !== "empty" &&
            p.lastResult.outcome !== "unknown_choice" && (
              <div data-testid="puzzle-feedback" role="status" className="mt-1 text-xs leading-5">
                <span className={p.lastResult.outcome === "correct" ? "text-gold" : "text-ember"}>
                  {p.lastResult.outcome === "correct" ? "Correct. " : "Not quite. "}
                </span>
                <span className="text-muted">{p.lastResult.feedback}</span>
                {p.lastResult.outcome === "correct" && (
                  <span data-testid="puzzle-explanation" className="mt-1 block text-gold">
                    {p.lastResult.explanation}
                  </span>
                )}
              </div>
            )}
          {p.lastResult &&
            (p.lastResult.outcome === "empty" || p.lastResult.outcome === "unknown_choice") && (
              <p data-testid="puzzle-empty-error" role="alert" className="mt-1 text-xs text-ember">
                {p.lastResult.feedback}
              </p>
            )}
        </div>
        {!p.isCorrect ? (
          <button
            type="button"
            data-testid="puzzle-submit"
            onClick={p.submit}
            disabled={!p.canSubmit}
            aria-disabled={!p.canSubmit}
            className={`min-h-[44px] shrink-0 px-5 font-mono text-sm font-bold ${
              !p.canSubmit
                ? "cursor-not-allowed bg-smoke text-muted"
                : "cursor-pointer bg-ember text-ink"
            }`}
          >
            {p.isSubmitting ? "Submitting…" : p.selectedBranches ? "Confirm choice →" : "Submit Answer"}
          </button>
        ) : (
          <button
            type="button"
            data-testid="puzzle-continue"
            onClick={onComplete}
            className="min-h-[44px] shrink-0 cursor-pointer bg-ember px-5 font-mono text-sm font-bold text-ink"
          >
            Continue →
          </button>
        )}
      </div>
    </div>
  );
}
