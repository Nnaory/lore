/**
 * pure-functions-total.test.ts — Property 19: new pure functions never throw (task 18.5).
 *
 * Feature: ui-redesign, Property 19: Fungsi murni baru tidak pernah melempar.
 * Covers `computeBoardScale`, `selectLayout`, `hpSquares`, `revealedCount`,
 * `revealPrefix`, `chapterSquares`, `lengthForChapters`, and `validateHomeFile`
 * against arbitrary inputs (`NaN`, `Infinity`, negatives, 0, empty/long strings).
 *
 * **Validates: Requirements 13.3**
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BOARD_SIZE, computeBoardScale, selectLayout, type StageLayout } from "@/lib/stage/board-scale";
import { hpSquares } from "@/lib/stage/hud";
import { revealedCount, revealPrefix, type TextMode } from "@/lib/dialogue/typewriter";
import { chapterSquares, lengthForChapters } from "@/lib/prep/chapter-choices";
import { validateHomeFile } from "@/lib/home/file-check";
import type { StoryLength } from "@/lib/setup/create-form";

const wildNumberArb = fc.oneof(
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(0),
  fc.constant(-0),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ noNaN: false }),
);

const wildStringArb = fc.oneof(
  fc.constant(""),
  fc.string({ maxLength: 50 }),
  fc.string({ unit: "binary", maxLength: 50 }),
  fc.string({ minLength: 500, maxLength: 2000 }),
);

const layoutArb = fc.constantFrom<StageLayout>("desktop", "phone");
const modeArb = fc.constantFrom<TextMode>("fast", "animate");
const storyLengthArb = fc.oneof(
  fc.constantFrom<StoryLength>("short", "medium"),
  wildStringArb as unknown as fc.Arbitrary<StoryLength>,
);

describe("Feature: ui-redesign, Property 19: Fungsi murni baru tidak pernah melempar", () => {
  it("computeBoardScale never throws and returns ok:true with scale > 0 iff dimensions are positive and finite", () => {
    fc.assert(
      fc.property(wildNumberArb, wildNumberArb, layoutArb, (width, height, layout) => {
        const res = computeBoardScale({ width, height }, layout);
        const board = BOARD_SIZE[layout];
        const expectedScale = Math.min(width / board.width, height / board.height);
        const valid =
          typeof width === "number" &&
          Number.isFinite(width) &&
          width > 0 &&
          typeof height === "number" &&
          Number.isFinite(height) &&
          height > 0 &&
          Number.isFinite(expectedScale) &&
          expectedScale > 0;
        if (valid) {
          expect(res).toEqual({ ok: true, scale: expectedScale });
        } else {
          expect(res).toEqual({ ok: false, reason: "invalid_viewport" });
        }
      }),
      { numRuns: 150 },
    );
  });

  it("selectLayout, hpSquares, revealedCount, revealPrefix, chapterSquares, lengthForChapters, and validateHomeFile never throw", () => {
    fc.assert(
      fc.property(
        wildNumberArb,
        wildNumberArb,
        wildStringArb,
        wildStringArb,
        modeArb,
        storyLengthArb,
        (n1, n2, s1, s2, mode, len) => {
          expect(() => selectLayout(n1)).not.toThrow();
          expect(() => hpSquares(n1)).not.toThrow();
          expect(() => revealedCount(n1, n2, mode)).not.toThrow();
          expect(() => revealPrefix(s1, n1)).not.toThrow();
          expect(() => chapterSquares(len)).not.toThrow();
          expect(() => lengthForChapters(n1)).not.toThrow();
          expect(() => validateHomeFile({ name: s1, size: n1, type: s2 })).not.toThrow();
        },
      ),
      { numRuns: 150 },
    );
  });
});
