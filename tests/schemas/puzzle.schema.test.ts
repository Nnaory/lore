/**
 * Tests — Puzzle Schema
 *
 * Verifies that:
 *   - Valid puzzle passes validation
 *   - Puzzle with only one choice is rejected
 *   - correct_choice_id that doesn't match any choice is rejected
 *   - Empty required fields are rejected
 */

import { describe, it, expect } from "vitest";
import { PuzzleSchema } from "@/lib/ai/schemas/puzzle.schema";
import { dummyStory } from "@/data/dummy-campaign";

const validPuzzle = dummyStory.puzzles[0];

describe("PuzzleSchema", () => {
  it("should accept the valid dummy puzzle", () => {
    const result = PuzzleSchema.safeParse(validPuzzle);
    expect(result.success).toBe(true);
  });

  it("should reject a puzzle with fewer than 2 choices", () => {
    const bad = {
      ...validPuzzle,
      choices: [validPuzzle.choices[0]],
      correct_choice_id: validPuzzle.choices[0].choice_id,
    };
    const result = PuzzleSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a puzzle where correct_choice_id does not match any choice", () => {
    const bad = {
      ...validPuzzle,
      correct_choice_id: "choice_NONEXISTENT",
    };
    const result = PuzzleSchema.safeParse(bad);
    expect(result.success).toBe(false);

    if (!result.success) {
      const paths = result.error.errors.map((e) => e.path.join("."));
      expect(paths).toContain("correct_choice_id");
    }
  });

  it("should reject a puzzle with an empty question", () => {
    const bad = { ...validPuzzle, question: "" };
    const result = PuzzleSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a puzzle with an empty explanation", () => {
    const bad = { ...validPuzzle, explanation: "" };
    const result = PuzzleSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("should reject a puzzle with no concept_ids", () => {
    const bad = { ...validPuzzle, concept_ids: [] };
    const result = PuzzleSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
