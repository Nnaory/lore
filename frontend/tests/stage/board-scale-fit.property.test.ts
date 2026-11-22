/**
 * Property 1 (ui-redesign): the board scale fits the viewport fully and touches
 * at least one edge. Kept in its own file so parallel test tasks don't collide.
 *
 * Feature: ui-redesign, Property 1: Skala papan memuat penuh dan menyentuh satu batas
 * **Validates: Requirements 7.1, 8.1**
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { BOARD_SIZE, computeBoardScale, type StageLayout } from "@/lib/stage/board-scale";

const EPS = 1e-9;

const layoutArb = fc.constantFrom<StageLayout>("desktop", "phone");
const viewportArb = fc.record({
  width: fc.integer({ min: 320, max: 3840 }),
  height: fc.integer({ min: 240, max: 2160 }),
});

describe("Property 1: board scale fits and touches one edge", () => {
  it("scale = min(w/W, h/H), board fits, at least one edge touches, aspect preserved", () => {
    fc.assert(
      fc.property(viewportArb, layoutArb, (viewport, layout) => {
        const result = computeBoardScale(viewport, layout);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { width: W, height: H } = BOARD_SIZE[layout];
        const { scale } = result;

        expect(scale).toBe(Math.min(viewport.width / W, viewport.height / H));
        expect(W * scale).toBeLessThanOrEqual(viewport.width + EPS);
        expect(H * scale).toBeLessThanOrEqual(viewport.height + EPS);

        const touchesWidth = Math.abs(W * scale - viewport.width) <= EPS;
        const touchesHeight = Math.abs(H * scale - viewport.height) <= EPS;
        expect(touchesWidth || touchesHeight).toBe(true);

        expect((W * scale) / (H * scale)).toBeCloseTo(W / H, 9);
      }),
      { numRuns: 200 },
    );
  });

  it("matches known examples", () => {
    expect(computeBoardScale({ width: 1440, height: 900 }, "desktop")).toEqual({ ok: true, scale: 1 });
    expect(computeBoardScale({ width: 390, height: 844 }, "phone")).toEqual({ ok: true, scale: 1 });
  });
});
