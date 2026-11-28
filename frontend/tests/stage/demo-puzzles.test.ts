/**
 * demo-puzzles.test.ts — the demo story's puzzles.
 *
 * Why: the demo's correct answers once ended with a check mark, which gave the answer away as
 * soon as the chips showed their whole text. The first demo puzzle also carries a picture of its
 * problem (the AI-designed `visual`), so the demo shows that path of the Stage.
 */
import { describe, expect, it } from "vitest";
import { dummyStory, dummyStory2 } from "@/data/dummy-campaign";
import { PuzzleSchema } from "@/lib/contracts/schemas/puzzle.schema";

const puzzles = [dummyStory, dummyStory2].flatMap((story) => story.puzzles);

describe("demo puzzles", () => {
  it("have at least one puzzle to check", () => {
    expect(puzzles.length).toBeGreaterThan(0);
  });

  it("do not mark the correct answer in its text", () => {
    for (const puzzle of puzzles) {
      for (const choice of puzzle.choices) expect(choice.text).not.toMatch(/[✓✔☑]/);
    }
  });

  it("validate against the puzzle schema, and the first one keeps its picture", () => {
    for (const puzzle of puzzles) expect(PuzzleSchema.safeParse(puzzle).success).toBe(true);
    const parsed = PuzzleSchema.safeParse(dummyStory.puzzles[0]);
    expect(parsed.success && parsed.data.visual?.kind).toBe("vectors");
  });

  it("keep the picture from showing an answer (no combination of both crystals is drawn)", () => {
    const visual = dummyStory.puzzles[0].visual;
    expect(visual?.kind).toBe("vectors");
    if (visual?.kind !== "vectors") return;
    const tips = visual.vectors.map((v) => v.to.join(","));
    // The three arrows are the two crystals and the target; no scaled copy such as (4, 2) is drawn.
    expect(tips.sort()).toEqual(["1,2", "2,1", "5,4"]);
  });
});
