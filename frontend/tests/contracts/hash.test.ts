/**
 * Tests — stableHash / seededShuffle
 */

import { describe, it, expect } from "vitest";
import { seededShuffle, stableHash } from "@/lib/contracts/hash";

describe("stableHash", () => {
  it("is deterministic and differs for different input", () => {
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
  });
});

describe("seededShuffle", () => {
  it("is deterministic and keeps every item", () => {
    const items = ["A", "B", "C", "D"];
    expect(seededShuffle(items, "seed")).toEqual(seededShuffle(items, "seed"));
    expect([...seededShuffle(items, "seed")].sort()).toEqual(items);
    expect(items).toEqual(["A", "B", "C", "D"]); // input untouched
  });

  it("does not correlate near-identical seeds (regression: correct answer always first)", () => {
    const firstPositions = [1, 2, 3, 4, 5].map(
      (c) => seededShuffle(["A", "B", "C"], `puzzle_story_01_c0${c}`).indexOf("A")
    );
    expect(new Set(firstPositions).size).toBeGreaterThan(1);
  });

  it("spreads the first item roughly evenly across positions", () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 600; i++) counts[seededShuffle(["A", "B", "C"], `puzzle_${i}`).indexOf("A")]++;
    for (const n of counts) expect(n).toBeGreaterThan(150); // expected ~200 each
  });
});
