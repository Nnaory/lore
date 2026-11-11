/**
 * PuzzleInteraction
 *
 * Full interactive puzzle component with new minimalist gold theme.
 * Interaction states: "idle" | "incorrect" | "correct"
 * Rules:
 *   - Submission blocked when no choice selected
 *   - Submission blocked after correct answer
 *   - Submission blocked when isFailed
 *   - Selected choice locked after correct answer
 *   - Correct answer never revealed before submission
 */

"use client";

import { useState } from "react";
import type { Puzzle } from "@/lib/types/puzzle";
import { validateMultipleChoice } from "@/lib/game/answer-validator";
import type { ValidationResult } from "@/lib/game/answer-validator";

type PuzzleInteractionState = "idle" | "incorrect" | "correct";

type PuzzleInteractionProps = {
  puzzle: Puzzle;
  /** Called when the player solves the puzzle and clicks "Continue". */
  onComplete: () => void;
  /**
   * Called exactly once per incorrect submission.
   * Used by the parent to deduct HP.
   */
  onIncorrect?: () => void;
  /**
   * Called once per valid answer submission (correct or incorrect).
   * Used by the parent to record knowledge evidence and puzzle attempts.
   * @param correct  Whether this submission was correct.
   */
  onAnswerSubmitted?: (correct: boolean) => void;
  /** When true, all input is disabled (story failed). */
  isFailed?: boolean;
};

export function PuzzleInteraction({
  puzzle,
  onComplete,
  onIncorrect,
  onAnswerSubmitted,
  isFailed = false,
}: PuzzleInteractionProps) {
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [interactionState, setInteractionState] =
    useState<PuzzleInteractionState>("idle");
  const [lastResult, setLastResult] = useState<ValidationResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isCorrect = interactionState === "correct";
  const canSubmit =
    selectedChoiceId !== null && !isCorrect && !isSubmitting && !isFailed;

  function handleSelect(choiceId: string) {
    if (isCorrect || isFailed) return;
    setSelectedChoiceId(choiceId);
    if (interactionState === "incorrect") {
      setInteractionState("idle");
      setLastResult(null);
    }
  }

  function handleSubmit() {
    if (!canSubmit) return;

    setIsSubmitting(true);
    const result = validateMultipleChoice(puzzle, selectedChoiceId);
    setLastResult(result);

    if (result.outcome === "correct") {
      setInteractionState("correct");
      onAnswerSubmitted?.(true);
    } else if (result.outcome === "incorrect") {
      setInteractionState("incorrect");
      onAnswerSubmitted?.(false);
      onIncorrect?.();
    }
    setIsSubmitting(false);
  }

  return (
    <div
      data-testid="puzzle-interaction"
      className="w-full max-w-4xl mx-auto"
      style={{
        border: "1px solid var(--border)",
        borderRadius: "0.5rem",
        overflow: "hidden",
        backgroundColor: "var(--background-panel)",
      }}
      role="region"
      aria-label={`Puzzle: ${puzzle.question}`}
    >
      {/* ── Header ── */}
      <div
        className="px-4 py-3 border-b flex items-center gap-2"
        style={{ borderBottomColor: "var(--border-dim)" }}
      >
        <span
          className="text-xs font-semibold tracking-widest uppercase px-2 py-0.5 rounded"
          style={{
            backgroundColor: "var(--accent-gold)",
            color: "var(--background)",
          }}
        >
          Puzzle
        </span>
      </div>

      {/* ── Narrative context ── */}
      <div className="px-4 py-3 border-b" style={{ borderBottomColor: "var(--border-dim)" }}>
        <p
          className="text-sm leading-6"
          style={{ color: "var(--foreground-muted)" }}
          data-testid="puzzle-narrative-context"
        >
          {puzzle.narrative_context}
        </p>
      </div>

      {/* ── Question ── */}
      <div className="px-4 py-3 border-b" style={{ borderBottomColor: "var(--border-dim)" }}>
        <p
          className="text-sm font-medium leading-6"
          style={{ color: "var(--foreground)" }}
          data-testid="puzzle-question"
        >
          {puzzle.question}
        </p>
      </div>

      {/* ── Choices ── */}
      <div className="px-4 py-3" data-testid="puzzle-choices" role="radiogroup" aria-label="Answer choices">
        {puzzle.choices.map((choice) => {
          const isSelected = selectedChoiceId === choice.choice_id;
          const isLockedIn = isCorrect && isSelected;

          const _borderColor = "transparent";
          let bgColor = "transparent";
          let textColor = "var(--foreground-muted)";
          let leftBorderColor = "transparent";

          if (isSelected && interactionState === "idle") {
            bgColor = "rgba(232, 197, 71, 0.08)";
            textColor = "var(--foreground)";
            leftBorderColor = "var(--accent-gold)";
          } else if (isSelected && interactionState === "incorrect") {
            bgColor = "rgba(216, 74, 58, 0.1)";
            textColor = "var(--danger)";
            leftBorderColor = "var(--danger)";
          } else if (isLockedIn) {
            bgColor = "rgba(111, 207, 151, 0.1)";
            textColor = "#6fcf97";
            leftBorderColor = "#6fcf97";
          }

          return (
            <button
              key={choice.choice_id}
              data-testid={`choice-${choice.choice_id}`}
              onClick={() => handleSelect(choice.choice_id)}
              disabled={isCorrect}
              aria-pressed={isSelected}
              className="w-full text-left py-3 px-3 transition-all relative"
              style={{
                backgroundColor: bgColor,
                color: textColor,
                borderLeft: `3px solid ${leftBorderColor}`,
                cursor: isCorrect ? "default" : "pointer",
                opacity: isCorrect && !isSelected ? 0.5 : 1,
              }}
            >
              {choice.text}
            </button>
          );
        })}
      </div>

      {/* ── Feedback ── */}
      {lastResult && lastResult.outcome !== "empty" && (
        <div
          data-testid="puzzle-feedback"
          className="px-4 py-3 border-t"
          style={{
            borderTopColor: "var(--border-dim)",
            backgroundColor:
              lastResult.outcome === "correct"
                ? "rgba(111, 207, 151, 0.08)"
                : "rgba(216, 74, 58, 0.08)",
          }}
          role="status"
          aria-live="polite"
        >
          <p className="font-medium mb-1" style={{ color: "var(--foreground)" }}>
            {lastResult.outcome === "correct" ? "Correct" : "Incorrect"}
          </p>
          <p style={{ color: "var(--foreground-muted)" }}>
            {lastResult.feedback}
          </p>
          {lastResult.outcome === "correct" && (
            <p
              className="mt-2 text-sm"
              data-testid="puzzle-explanation"
              style={{ color: "var(--accent-gold-dim)" }}
            >
              {lastResult.explanation}
            </p>
          )}
        </div>
      )}

      {/* Empty/unknown choice error */}
      {lastResult &&
        (lastResult.outcome === "empty" ||
          lastResult.outcome === "unknown_choice") && (
          <div
            data-testid="puzzle-empty-error"
            className="px-4 py-3 border-t"
            style={{ borderTopColor: "var(--border-dim)" }}
            role="alert"
          >
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              {lastResult.feedback}
            </p>
          </div>
        )}

      {/* ── Actions ── */}
      <div className="px-4 py-3 border-t" style={{ borderTopColor: "var(--border-dim)" }}>
        {!isCorrect ? (
          <button
            data-testid="puzzle-submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full px-5 py-2.5 rounded text-sm font-medium transition-all"
            style={{
              backgroundColor: canSubmit ? "var(--accent-gold)" : "var(--border-dim)",
              color: canSubmit ? "var(--background)" : "var(--foreground-faint)",
              cursor: canSubmit ? "pointer" : "not-allowed",
              opacity: canSubmit ? 1 : 0.5,
            }}
            aria-disabled={!canSubmit}
          >
            {isSubmitting ? "Submitting…" : "Submit Answer"}
          </button>
        ) : (
          <button
            data-testid="puzzle-continue"
            onClick={onComplete}
            className="w-full px-5 py-2.5 rounded text-sm font-medium transition-all"
            style={{
              backgroundColor: "var(--accent-gold)",
              color: "var(--background)",
            }}
          >
            Continue →
          </button>
        )}
      </div>
    </div>
  );
}