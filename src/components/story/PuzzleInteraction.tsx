/**
 * PuzzleInteraction
 *
 * The full, interactive puzzle component. Replaces PuzzlePlaceholder from M2.
 *
 * Interaction states:
 *   "idle"      — Player has not yet submitted an answer.
 *   "incorrect" — Player submitted a wrong answer. Retry is available.
 *   "correct"   — Player submitted the correct answer. Continue is available.
 *
 * Rules enforced by this component:
 *   - Submission is blocked when no choice is selected.
 *   - Submission is blocked after a correct answer (puzzle already solved).
 *   - Submission is blocked when isFailed is true (story is over).
 *   - The selected choice cannot be changed after a correct answer.
 *   - The correct answer is never revealed before submission.
 *   - Correctness is determined by validateMultipleChoice, not by the component.
 *
 * Milestone 4 additions:
 *   - onIncorrect?: () => void — called ONCE per submission when the answer is
 *     incorrect. The parent (useStoryPlayer) uses this to deduct HP.
 *   - isFailed?: boolean — when true, all interaction is disabled. The parent
 *     (StoryViewer) will overlay the StoryFailure screen instead.
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
   * Used by the parent to deduct HP. Optional so existing tests
   * without this prop continue to pass.
   */
  onIncorrect?: () => void;
  /**
   * Called once per valid answer submission (correct or incorrect).
   * Used by the parent to record knowledge evidence and puzzle attempts.
   * @param correct  Whether this submission was correct.
   */
  onAnswerSubmitted?: (correct: boolean) => void;
  /**
   * When true, all input is disabled. Set by the parent when the story
   * has failed (HP = 0). Optional for backward compatibility.
   */
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
  // Guard: prevent double-submission while a result is being shown
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isCorrect = interactionState === "correct";
  // Also disable when story has already failed
  const canSubmit =
    selectedChoiceId !== null && !isCorrect && !isSubmitting && !isFailed;

  function handleSelect(choiceId: string) {
    // Selection locked after correct answer or failure
    if (isCorrect || isFailed) return;
    setSelectedChoiceId(choiceId);
    // If showing incorrect feedback, reset to idle on new selection
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
      // Notify parent of any valid submission for knowledge/attempt tracking.
      onAnswerSubmitted?.(true);
    } else if (result.outcome === "incorrect") {
      setInteractionState("incorrect");
      // Notify parent of valid submission for knowledge/attempt tracking.
      onAnswerSubmitted?.(false);
      // Notify parent of incorrect specifically for HP deduction.
      onIncorrect?.();
    }
    // empty / unknown_choice: no notification — not a valid puzzle attempt.
    setIsSubmitting(false);
  }

  return (
    <div
      data-testid="puzzle-interaction"
      className="rounded-lg p-5 my-2"
      style={{
        backgroundColor: "var(--background-panel)",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--accent)",
      }}
      role="region"
      aria-label={`Puzzle: ${puzzle.question}`}
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2 mb-4">
        <span
          className="text-xs font-semibold tracking-widest uppercase px-2 py-0.5 rounded"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--foreground)",
          }}
        >
          Puzzle
        </span>
      </div>

      {/* ── Narrative context ── */}
      <p
        className="text-sm leading-6 mb-4"
        style={{ color: "var(--foreground-muted)" }}
        data-testid="puzzle-narrative-context"
      >
        {puzzle.narrative_context}
      </p>

      {/* ── Question ── */}
      <p
        className="text-sm font-medium leading-6 mb-5"
        style={{ color: "var(--foreground)" }}
        data-testid="puzzle-question"
      >
        {puzzle.question}
      </p>

      {/* ── Choices ── */}
      <div
        className="flex flex-col gap-2 mb-5"
        role="radiogroup"
        aria-label="Answer choices"
        data-testid="puzzle-choices"
      >
        {puzzle.choices.map((choice) => {
          const isSelected = selectedChoiceId === choice.choice_id;
          const isLockedIn = isCorrect && isSelected;

          // Choice border/bg changes based on state
          let borderColor = "var(--border)";
          let bgColor = "var(--background-surface, var(--background-panel))";
          let textColor = "var(--foreground-muted)";

          if (isSelected && interactionState === "idle") {
            borderColor = "var(--accent-gold)";
            bgColor = "var(--background-panel)";
            textColor = "var(--foreground)";
          } else if (isSelected && interactionState === "incorrect") {
            borderColor = "#6a2d2d";
            bgColor = "#1a0a0a";
            textColor = "#eb5757";
          } else if (isLockedIn) {
            borderColor = "#2d6a4a";
            bgColor = "#0a1a10";
            textColor = "#6fcf97";
          }

          return (
            <button
              key={choice.choice_id}
              data-testid={`choice-${choice.choice_id}`}
              onClick={() => handleSelect(choice.choice_id)}
              disabled={isCorrect}
              aria-pressed={isSelected}
              className="text-left rounded px-4 py-3 text-sm leading-6 transition-opacity"
              style={{
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor,
                backgroundColor: bgColor,
                color: textColor,
                cursor: isCorrect ? "default" : "pointer",
                opacity: isCorrect && !isSelected ? 0.4 : 1,
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
          className="rounded p-3 mb-4 text-sm leading-6"
          role="status"
          aria-live="polite"
          style={{
            backgroundColor:
              lastResult.outcome === "correct" ? "#0a1a10" : "#1a0a0a",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor:
              lastResult.outcome === "correct" ? "#2d6a4a" : "#6a2d2d",
            color:
              lastResult.outcome === "correct" ? "#6fcf97" : "#eb5757",
          }}
        >
          <p className="font-medium mb-1">
            {lastResult.outcome === "correct" ? "Correct!" : "Incorrect"}
          </p>
          <p style={{ color: "var(--foreground-muted)" }}>
            {lastResult.feedback}
          </p>
          {lastResult.outcome === "correct" && (
            <p
              className="mt-2 text-xs"
              data-testid="puzzle-explanation"
              style={{ color: "var(--foreground-muted)" }}
            >
              {lastResult.explanation}
            </p>
          )}
        </div>
      )}

      {/* Empty/unknown choice error (inline, no panel) */}
      {lastResult &&
        (lastResult.outcome === "empty" ||
          lastResult.outcome === "unknown_choice") && (
          <p
            data-testid="puzzle-empty-error"
            className="text-xs mb-4"
            style={{ color: "#eb5757" }}
            role="alert"
          >
            {lastResult.feedback}
          </p>
        )}

      {/* ── Actions ── */}
      {!isCorrect ? (
        <button
          data-testid="puzzle-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-5 py-2 rounded text-sm font-medium transition-opacity"
          style={{
            backgroundColor: canSubmit ? "var(--accent)" : "var(--border)",
            color: canSubmit ? "var(--foreground)" : "var(--foreground-faint)",
            cursor: canSubmit ? "pointer" : "not-allowed",
            opacity: canSubmit ? 1 : 0.6,
          }}
          aria-disabled={!canSubmit}
        >
          Submit Answer
        </button>
      ) : (
        <button
          data-testid="puzzle-continue"
          onClick={onComplete}
          className="px-5 py-2 rounded text-sm font-medium transition-opacity hover:opacity-80 active:opacity-60"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--foreground)",
          }}
        >
          Continue →
        </button>
      )}
    </div>
  );
}
