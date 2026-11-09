/**
 * Zod Schemas — Puzzle
 *
 * Validates puzzle data produced by AI (Layer 3/4).
 * Includes a cross-field refinement ensuring correct_choice_id
 * references one of the provided choices.
 */

import { z } from "zod";

export const PuzzleChoiceSchema = z.object({
  choice_id: z.string().min(1, "choice_id must not be empty"),
  text: z.string().min(1, "choice text must not be empty"),
});

export const PuzzleSchema = z
  .object({
    puzzle_id: z.string().min(1, "puzzle_id must not be empty"),
    concept_ids: z
      .array(z.string())
      .min(1, "puzzle must reference at least one concept"),
    narrative_context: z.string().min(1, "narrative_context must not be empty"),
    question: z.string().min(1, "question must not be empty"),
    choices: z
      .array(PuzzleChoiceSchema)
      .min(2, "puzzle must have at least two choices"),
    correct_choice_id: z
      .string()
      .min(1, "correct_choice_id must not be empty"),
    explanation: z.string().min(1, "explanation must not be empty"),
    incorrect_feedback: z.string().min(1, "incorrect_feedback must not be empty"),
    correct_feedback: z.string().min(1, "correct_feedback must not be empty"),
    retry_allowed: z.boolean(),
  })
  .refine(
    (data) =>
      data.choices.some((c) => c.choice_id === data.correct_choice_id),
    {
      message:
        "correct_choice_id must match one of the choice_id values in choices",
      path: ["correct_choice_id"],
    }
  );

export type PuzzleChoiceFromSchema = z.infer<typeof PuzzleChoiceSchema>;
export type PuzzleFromSchema = z.infer<typeof PuzzleSchema>;
