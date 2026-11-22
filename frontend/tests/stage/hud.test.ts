/**
 * hud.test.ts — HP squares in the Stage HUD (hpSquares).
 *
 * Feature: ui-redesign, Property 10: HP squares follow clamped HP.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HUD_HP_SQUARES, hpSquares } from "@/lib/stage/hud";

describe("hpSquares", () => {
  it("Property 10: five squares, filled count = clamp(hp, 0, 5), filled on the left", () => {
    // **Validates: Requirements 7.6**
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (hp) => {
        const r = hpSquares(hp);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const expected = Math.min(Math.max(hp, 0), 5);
        expect(r.squares).toHaveLength(5);
        expect(r.squares.filter(Boolean)).toHaveLength(expected);
        expect(r.squares.slice(0, expected).every(Boolean)).toBe(true);
        expect(r.squares.slice(expected).some(Boolean)).toBe(false);
        expect(r.label).toBe(`${expected}/5`);
      }),
      { numRuns: 100 },
    );
  });

  it("example: hp 4 gives 4/5 with four filled squares", () => {
    const r = hpSquares(4);
    expect(r).toEqual({
      ok: true,
      value: 4,
      total: HUD_HP_SQUARES,
      squares: [true, true, true, true, false],
      label: "4/5",
    });
  });

  it("rejects non-finite hp", () => {
    expect(hpSquares(Number.NaN)).toEqual({ ok: false, reason: "invalid_hp" });
    expect(hpSquares(Infinity)).toEqual({ ok: false, reason: "invalid_hp" });
  });
});
