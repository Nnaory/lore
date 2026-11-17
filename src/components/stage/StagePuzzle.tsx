/**
 * StagePuzzle — a puzzle played on the stage canvas (wireframe layout)
 *
 * The canvas draws the decision graph (a node with lines to the answer
 * boxes); each answer box is a clickable HTML button laid over it. Below
 * the canvas, a strip holds the question, feedback and the submit/continue
 * button. Answer rules come from usePuzzleInteraction.
 */

"use client";

import type { Puzzle } from "@/lib/types/puzzle";
import type { Pacing } from "@/lib/story/pacing";
import { usePuzzleInteraction, type PuzzleInteractionCallbacks } from "@/components/story/use-puzzle-interaction";
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
      className="w-full h-full flex flex-col gap-3 min-h-0"
    >
      <div className="flex-1 min-h-0 flex items-center" style={{ containerType: "size" }}>
        <StageCanvas
          scene={{ kind: "decision", props: { label: "", count: choices.length, seed } }}
          sceneKey={`puzzle:${puzzle.puzzle_id}`}
          pacing={pacing}
        >
          <div data-testid="puzzle-choices" role="radiogroup" aria-label="Answer choices" className="absolute inset-0">
            {choices.map((choice, i) => {
              const box = boxes[i];
              const selected = p.selectedChoiceId === choice.choice_id;
              const lockedIn = p.isCorrect && selected;
              const wrong = selected && p.interactionState === "incorrect";
              const border = lockedIn ? "#6fcf97" : wrong ? "var(--danger)" : selected ? "var(--accent-gold)" : "transparent";
              return (
                <button
                  key={choice.choice_id}
                  type="button"
                  data-testid={`choice-${choice.choice_id}`}
                  aria-pressed={selected}
                  disabled={p.isCorrect}
                  onClick={() => p.select(choice.choice_id)}
                  className="absolute rounded-xl p-[1.2%] text-left overflow-y-auto transition-colors focus-visible:outline focus-visible:outline-2"
                  style={{
                    left: `${box.x}%`,
                    top: `${box.y}%`,
                    width: `${box.w}%`,
                    height: `${box.h}%`,
                    border: `2px solid ${border}`,
                    backgroundColor: selected ? "rgba(246, 200, 78, 0.12)" : "rgba(34, 34, 34, 0.5)",
                    color: lockedIn ? "#6fcf97" : wrong ? "var(--danger)" : "var(--foreground)",
                    opacity: p.isCorrect && !selected ? 0.4 : 1,
                    cursor: p.isCorrect ? "default" : "pointer",
                    fontSize: "clamp(10px, 1.25vw, 15px)",
                    lineHeight: 1.35,
                  }}
                >
                  <span className="block mb-1 font-mono text-[0.85em]" style={{ color: "var(--accent-gold-dim)" }}>
                    {String.fromCharCode(65 + i)}
                  </span>
                  {choice.text}
                </button>
              );
            })}
          </div>
        </StageCanvas>
      </div>

      <div
        className="lore-glass lore-glass-panel rounded-panel px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
      >
        <div className="flex-1 min-w-0" aria-live="polite">
          <p className="text-sm font-medium" style={{ color: "var(--foreground)" }} data-testid="puzzle-question">
            {puzzle.question}
          </p>
          {p.lastResult && p.lastResult.outcome !== "empty" && p.lastResult.outcome !== "unknown_choice" && (
            <div data-testid="puzzle-feedback" role="status" className="mt-1 text-xs leading-5">
              <span style={{ color: p.lastResult.outcome === "correct" ? "#6fcf97" : "var(--danger)" }}>
                {p.lastResult.outcome === "correct" ? "Correct. " : "Not quite. "}
              </span>
              <span style={{ color: "var(--foreground-muted)" }}>{p.lastResult.feedback}</span>
              {p.lastResult.outcome === "correct" && (
                <span data-testid="puzzle-explanation" className="block mt-1" style={{ color: "var(--accent-gold-dim)" }}>
                  {p.lastResult.explanation}
                </span>
              )}
            </div>
          )}
          {p.lastResult && (p.lastResult.outcome === "empty" || p.lastResult.outcome === "unknown_choice") && (
            <p data-testid="puzzle-empty-error" role="alert" className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
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
            className="lore-pill lore-pill-lg lore-pill-primary flex-shrink-0"
          >
            {p.isSubmitting ? "Submitting…" : p.selectedBranches ? "Confirm choice →" : "Submit Answer"}
          </button>
        ) : (
          <button
            type="button"
            data-testid="puzzle-continue"
            onClick={onComplete}
            className="lore-pill lore-pill-lg lore-pill-primary flex-shrink-0"
          >
            Continue →
          </button>
        )}
      </div>
    </div>
  );
}
