/**
 * Property 2 (ui-redesign): a child's position and size relative to the design
 * board do not depend on the viewport. Own file so parallel test tasks don't collide.
 *
 * Feature: ui-redesign, Property 2: Posisi relatif elemen invarian terhadap viewport
 * **Validates: Requirements 7.1**
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BOARD_SIZE,
  computeBoardScale,
  designRectToViewport,
  viewportRectToDesign,
  type Rect,
  type StageLayout,
} from "@/lib/stage/board-scale";

const layoutArb = fc.constantFrom<StageLayout>("desktop", "phone");
const viewportArb = fc.record({
  width: fc.integer({ min: 320, max: 3840 }),
  height: fc.integer({ min: 240, max: 2160 }),
});

/** A rect fully inside the design board of the given layout. */
function rectArb(layout: StageLayout): fc.Arbitrary<Rect> {
  const { width: W, height: H } = BOARD_SIZE[layout];
  return fc
    .record({
      x: fc.integer({ min: 0, max: W - 1 }),
      y: fc.integer({ min: 0, max: H - 1 }),
    })
    .chain(({ x, y }) =>
      fc.record({
        x: fc.constant(x),
        y: fc.constant(y),
        width: fc.integer({ min: 1, max: W - x }),
        height: fc.integer({ min: 1, max: H - y }),
      }),
    );
}

const caseArb = layoutArb.chain((layout) =>
  fc.record({ layout: fc.constant(layout), viewport: viewportArb, rect: rectArb(layout) }),
);

describe("Property 2: relative element position is viewport-invariant", () => {
  it("round-trips and keeps normalized geometry equal to the design's", () => {
    fc.assert(
      fc.property(caseArb, ({ layout, viewport, rect }) => {
        const s = computeBoardScale(viewport, layout);
        expect(s.ok).toBe(true);
        if (!s.ok) return;
        const { scale } = s;
        const { width: W, height: H } = BOARD_SIZE[layout];

        const mapped = designRectToViewport(rect, viewport, layout, scale);
        expect(mapped.ok).toBe(true);
        if (!mapped.ok) return;

        const back = viewportRectToDesign(mapped.rect, viewport, layout, scale);
        expect(back.ok).toBe(true);
        if (!back.ok) return;
        expect(back.rect.x).toBeCloseTo(rect.x, 6);
        expect(back.rect.y).toBeCloseTo(rect.y, 6);
        expect(back.rect.width).toBeCloseTo(rect.width, 6);
        expect(back.rect.height).toBeCloseTo(rect.height, 6);

        // Normalize against the scaled board box (left offset = centered, top = 0).
        const boardW = W * scale;
        const boardH = H * scale;
        const left = (viewport.width - boardW) / 2;
        expect((mapped.rect.x - left) / boardW).toBeCloseTo(rect.x / W, 9);
        expect(mapped.rect.y / boardH).toBeCloseTo(rect.y / H, 9);
        expect(mapped.rect.width / boardW).toBeCloseTo(rect.width / W, 9);
        expect(mapped.rect.height / boardH).toBeCloseTo(rect.height / H, 9);
      }),
      { numRuns: 200 },
    );
  });

  it("normalized geometry is identical across two different viewports", () => {
    const rect: Rect = { x: 100, y: 50, width: 400, height: 300 };
    const norm = (vp: { width: number; height: number }) => {
      const s = computeBoardScale(vp, "desktop");
      if (!s.ok) throw new Error("scale");
      const m = designRectToViewport(rect, vp, "desktop", s.scale);
      if (!m.ok) throw new Error("map");
      const bw = 1440 * s.scale;
      const bh = 900 * s.scale;
      return [(m.rect.x - (vp.width - bw) / 2) / bw, m.rect.y / bh, m.rect.width / bw, m.rect.height / bh];
    };
    const a = norm({ width: 1440, height: 900 });
    const b = norm({ width: 2560, height: 1000 });
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  });

  it("rejects an invalid scale or rect without throwing", () => {
    const vp = { width: 1440, height: 900 };
    expect(designRectToViewport({ x: 0, y: 0, width: 1, height: 1 }, vp, "desktop", 0)).toEqual({
      ok: false,
      reason: "invalid_scale",
    });
    expect(designRectToViewport({ x: NaN, y: 0, width: 1, height: 1 }, vp, "desktop", 1)).toEqual({
      ok: false,
      reason: "invalid_rect",
    });
  });
});
