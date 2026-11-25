/**
 * Typewriter pure functions. Property tests per design.md.
 * Feature: ui-redesign, Property 11: revealed count follows time and mode.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHAR_INTERVAL_MS,
  codePointLength,
  revealPrefix,
  revealedCount,
  initialTextMode,
} from "@/lib/dialogue/typewriter";

describe("revealedCount (Property 11)", () => {
  /** **Validates: Requirements 7.7, 7.9** */
  it("animate equals min(n, floor(t / 25))", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        (n, t) => {
          expect(revealedCount(t, n, "animate")).toBe(Math.min(n, Math.floor(t / 25)));
        },
      ),
    );
  });

  /** **Validates: Requirements 7.7, 7.9** */
  it("animate is monotonic non-decreasing in t", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        (n, a, b) => {
          const [t1, t2] = a <= b ? [a, b] : [b, a];
          expect(revealedCount(t1, n, "animate")).toBeLessThanOrEqual(
            revealedCount(t2, n, "animate"),
          );
        },
      ),
    );
  });

  /** **Validates: Requirements 7.7, 7.9** */
  it("fast always equals n", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        (n, t) => {
          expect(revealedCount(t, n, "fast")).toBe(n);
        },
      ),
    );
  });

  it("uses a 25 ms interval", () => {
    expect(CHAR_INTERVAL_MS).toBe(25);
    expect(revealedCount(24, 10, "animate")).toBe(0);
    expect(revealedCount(25, 10, "animate")).toBe(1);
  });
});

/** Feature: ui-redesign, Property 12: text prefix is safe and complete. */
const textArb = fc
  .array(fc.oneof(fc.string({ maxLength: 2 }), fc.constantFrom("😀", "👨‍👩‍👧", "𝒳", "é", "\n")), {
    maxLength: 40,
  })
  .map((parts) => parts.join(""));
const countArb = fc.integer({ min: 0, max: 100 });

describe("revealPrefix (Property 12)", () => {
  /** **Validates: Requirements 7.8** */
  it("is a prefix, within c code points, without splitting surrogate pairs", () => {
    fc.assert(
      fc.property(textArb, countArb, (text, c) => {
        const out = revealPrefix(text, c);
        expect(text.startsWith(out)).toBe(true);
        expect(codePointLength(out)).toBeLessThanOrEqual(c);
        expect(codePointLength(out)).toBe(Math.min(c, codePointLength(text)));
        // A lone high surrogate at the end that is not lone in the source means a split.
        const last = out.charCodeAt(out.length - 1);
        if (out.length > 0 && last >= 0xd800 && last <= 0xdbff) {
          expect(text.charCodeAt(out.length - 1)).toBe(last);
          expect(text.length).toBe(out.length);
        }
      }),
    );
  });

  /** **Validates: Requirements 7.8** */
  it("is monotonic in c", () => {
    fc.assert(
      fc.property(textArb, countArb, countArb, (text, a, b) => {
        const [c1, c2] = a <= b ? [a, b] : [b, a];
        expect(revealPrefix(text, c2).startsWith(revealPrefix(text, c1))).toBe(true);
      }),
    );
  });

  /** **Validates: Requirements 7.8** */
  it("equals the full text once c reaches the code point length", () => {
    fc.assert(
      fc.property(textArb, countArb, (text, extra) => {
        const n = codePointLength(text);
        expect(revealPrefix(text, n)).toBe(text);
        expect(revealPrefix(text, n + extra)).toBe(text);
      }),
    );
  });
});

/** Feature: ui-redesign, Property 13: initial text mode honours explicit choice and reduced motion. */
describe("initialTextMode (Property 13)", () => {
  /** **Validates: Requirements 3.7, 7.15** */
  it("returns an explicit stored value regardless of reduced motion", () => {
    fc.assert(
      fc.property(fc.constantFrom("fast", "animate"), fc.boolean(), (stored, reduced) => {
        expect(initialTextMode(stored, reduced)).toBe(stored);
      }),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 3.7, 7.15** */
  it("without a stored value, follows reduced motion", () => {
    fc.assert(
      fc.property(fc.boolean(), (reduced) => {
        expect(initialTextMode(null, reduced)).toBe(reduced ? "fast" : "animate");
      }),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 3.7, 7.15** */
  it("treats unrecognised stored strings as absent", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s !== "fast" && s !== "animate"),
        fc.boolean(),
        (stored, reduced) => {
          expect(initialTextMode(stored, reduced)).toBe(reduced ? "fast" : "animate");
        },
      ),
      { numRuns: 100 },
    );
  });
});
