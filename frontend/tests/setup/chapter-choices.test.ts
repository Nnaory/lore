/**
 * chapter-choices.test.ts - property test for the five CHAPTERS boxes.
 *
 * Why: the Prep screen draws boxes 1..5 but StoryLength only has short/medium,
 * so the mapping must stay a strict round trip and never select two boxes.
 * The design says `null` for unsupported counts; the code follows the repo's
 * result-union convention, so "null" is `{ ok: false, reason }`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chapterSquares, lengthForChapters } from "@/lib/prep/chapter-choices";
import type { StoryLength } from "@/lib/setup/create-form";

const RUNS = { numRuns: 100 };
const lengthArb = fc.constantFrom<StoryLength>("short", "medium");

describe("Feature: ui-redesign, Property 16: Kotak CHAPTERS tepat satu terpilih dan bolak-balik dengan panjang cerita", () => {
  // **Validates: Requirements 9.6**
  it("returns 5 boxes numbered 1..5 with exactly one selected, and it is enabled", () => {
    fc.assert(
      fc.property(lengthArb, (length) => {
        const r = chapterSquares(length);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.squares.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
        const selected = r.squares.filter((s) => s.selected);
        expect(selected).toHaveLength(1);
        expect(selected[0].enabled).toBe(true);
      }),
      RUNS,
    );
  });

  it("round-trips: lengthForChapters(selected.n) returns the original length", () => {
    fc.assert(
      fc.property(lengthArb, (length) => {
        const r = chapterSquares(length);
        if (!r.ok) throw new Error("chapterSquares failed");
        const selected = r.squares.find((s) => s.selected)!;
        expect(lengthForChapters(selected.n)).toEqual({ ok: true, length });
      }),
      RUNS,
    );
  });

  it("rejects every n that is not 3 or 5", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.double({ noNaN: false }), fc.constantFrom(1, 2, 4, 0, -1)),
        (n) => {
          fc.pre(n !== 3 && n !== 5);
          expect(lengthForChapters(n)).toEqual({
            ok: false,
            reason: "unsupported_chapter_count",
          });
        },
      ),
      RUNS,
    );
  });

  it("enables only boxes 3 and 5", () => {
    fc.assert(
      fc.property(lengthArb, (length) => {
        const r = chapterSquares(length);
        if (!r.ok) throw new Error("chapterSquares failed");
        expect(r.squares.filter((s) => s.enabled).map((s) => s.n)).toEqual([3, 5]);
      }),
      RUNS,
    );
  });

  it("returns ok:false instead of throwing for an invalid length", () => {
    expect(chapterSquares("long" as StoryLength)).toEqual({ ok: false, reason: "invalid_length" });
  });
});
