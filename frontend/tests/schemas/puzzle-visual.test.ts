/**
 * puzzle-visual.test.ts — the optional `visual` of a puzzle.
 *
 * Why: the AI may draw the problem of a puzzle. The field must survive validation (Zod strips
 * unknown keys, so a schema without it would silently remove the picture), a bad drawing spec
 * must be dropped without losing the puzzle, and projects saved before the field existed must
 * stay valid.
 */
import { describe, expect, it } from "vitest";
import { PuzzleSchema } from "@/lib/contracts/schemas/puzzle.schema";
import { StoryBlueprintSchema } from "@/lib/contracts/schemas/story.schema";
import { linearStory } from "../fixtures/linear-story";

const base = linearStory.puzzles[0];
const visual = {
  kind: "vectors",
  vectors: [
    { from: [0, 0], to: [2, 1], label: "A" },
    { from: [0, 0], to: [5, 4], label: "?", tone: "muted" },
  ],
  caption: "Reach the dashed arrow.",
};

describe("PuzzleSchema visual", () => {
  it("keeps a valid visual", () => {
    const parsed = PuzzleSchema.safeParse({ ...base, visual });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.visual).toEqual(visual);
  });

  it("accepts a puzzle without a visual (projects saved before the field existed)", () => {
    const parsed = PuzzleSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.visual).toBeUndefined();
  });

  it("drops an invalid visual and keeps the puzzle", () => {
    for (const bad of [{ kind: "vectors", vectors: [] }, { kind: "hologram" }, "a picture", 42, null]) {
      const parsed = PuzzleSchema.safeParse({ ...base, visual: bad });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.visual).toBeUndefined();
    }
  });

  it("still rejects a puzzle whose correct choice does not exist", () => {
    const parsed = PuzzleSchema.safeParse({ ...base, correct_choice_id: "nope", visual });
    expect(parsed.success).toBe(false);
  });

  it("survives inside a whole story blueprint", () => {
    const story = { ...linearStory, puzzles: [{ ...base, visual }] };
    const parsed = StoryBlueprintSchema.safeParse(story);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.puzzles[0].visual).toEqual(visual);
  });
});
