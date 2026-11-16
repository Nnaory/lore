/**
 * usePuzzleInteraction — the rules of answering one puzzle
 *
 * Shared by the classic PuzzleInteraction card and the stage canvas puzzle,
 * so both behave identically:
 *   - submission blocked with no choice, after a correct answer, or when failed
 *   - the selected choice locks after a correct answer
 *   - correctness comes only from validateMultipleChoice (the game engine)
 *   - a wrong choice with a bad branch hands off to onBadBranch instead of
 *     showing inline feedback
 */

"use client";

import { useState } from "react";
import type { Puzzle } from "@/lib/types/puzzle";
import { validateMultipleChoice, type ValidationResult } from "@/lib/game/answer-validator";

export type PuzzleInteractionState = "idle" | "incorrect" | "correct";

export type PuzzleInteractionCallbacks = {
  /** Called exactly once per incorrect submission that has no bad-branch scene. */
  onIncorrect?: () => void;
  /** Called for an incorrect choice that has a bad-branch scene. */
  onBadBranch?: (choiceId: string) => void;
  /** Called once per valid submission (correct or incorrect). */
  onAnswerSubmitted?: (correct: boolean) => void;
  isFailed?: boolean;
  badBranchChoiceIds?: Set<string>;
};

export function usePuzzleInteraction(puzzle: Puzzle, callbacks: PuzzleInteractionCallbacks) {
  const { onIncorrect, onBadBranch, onAnswerSubmitted, isFailed = false, badBranchChoiceIds } = callbacks;
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [interactionState, setInteractionState] = useState<PuzzleInteractionState>("idle");
  const [lastResult, setLastResult] = useState<ValidationResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isCorrect = interactionState === "correct";
  const canSubmit = selectedChoiceId !== null && !isCorrect && !isSubmitting && !isFailed;
  const selectedBranches = selectedChoiceId !== null && (badBranchChoiceIds?.has(selectedChoiceId) ?? false);

  function select(choiceId: string) {
    if (isCorrect || isFailed) return;
    setSelectedChoiceId(choiceId);
    if (interactionState === "incorrect") {
      setInteractionState("idle");
      setLastResult(null);
    }
  }

  function submit() {
    if (!canSubmit) return;

    setIsSubmitting(true);
    const result = validateMultipleChoice(puzzle, selectedChoiceId);
    setLastResult(result);

    if (result.outcome === "correct") {
      setInteractionState("correct");
      onAnswerSubmitted?.(true);
    } else if (result.outcome === "incorrect") {
      onAnswerSubmitted?.(false);
      if (selectedChoiceId && badBranchChoiceIds?.has(selectedChoiceId) && onBadBranch) {
        setIsSubmitting(false);
        onBadBranch(selectedChoiceId);
        return;
      }
      setInteractionState("incorrect");
      onIncorrect?.();
    }
    setIsSubmitting(false);
  }

  return {
    selectedChoiceId,
    interactionState,
    lastResult,
    isSubmitting,
    isCorrect,
    canSubmit,
    /** True when the selected (wrong) choice leads to a bad branch. */
    selectedBranches,
    select,
    submit,
  };
}
