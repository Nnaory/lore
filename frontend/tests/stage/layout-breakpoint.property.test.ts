/**
 * layout-breakpoint.property.test.ts — Property 3: one phone/desktop breakpoint.
 *
 * Why: the Stage must switch layout at exactly one width (767 -> phone,
 * 768 -> desktop) and never flip back as the viewport grows.
 *
 * Feature: ui-redesign, Property 3: Satu titik pisah phone dan desktop
 * **Validates: Requirements 8.5**
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DESKTOP_MIN_WIDTH, selectLayout } from "@/lib/stage/board-scale";

function layoutOf(w: number): string {
  const r = selectLayout(w);
  if (!r.ok) throw new Error(`unexpected failure for ${w}`);
  return r.layout;
}

describe("Property 3: satu titik pisah phone dan desktop", () => {
  it("returns phone for w <= 767 and desktop for w >= 768", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (w) => {
        expect(layoutOf(w)).toBe(w <= 767 ? "phone" : "desktop");
      }),
      { numRuns: 200 },
    );
  });

  it("is monotonic: desktop at w1 implies desktop at any w2 >= w1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (a, b) => {
          const [w1, w2] = a <= b ? [a, b] : [b, a];
          if (layoutOf(w1) === "desktop") expect(layoutOf(w2)).toBe("desktop");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("boundary examples: 767 is phone, 768 is desktop", () => {
    expect(DESKTOP_MIN_WIDTH).toBe(768);
    expect(layoutOf(767)).toBe("phone");
    expect(layoutOf(768)).toBe("desktop");
    expect(layoutOf(0)).toBe("phone");
  });
});
