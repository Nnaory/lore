/**
 * Tests — HP Manager
 *
 * Pure unit tests for the hp-manager module.
 * No React, no DOM.
 *
 * Tests:
 *   1. initialHp returns MAX_HP (5)
 *   2. deductHp decrements by exactly 1
 *   3. deductHp does not go below 0
 *   4. Multiple deductions are cumulative
 *   5. isStoryFailed returns true at 0
 *   6. isStoryFailed returns false above 0
 *   7. clampHp clamps values outside [0, MAX_HP]
 */

import { describe, it, expect } from "vitest";
import {
  MAX_HP,
  FAILURE_HP,
  initialHp,
  deductHp,
  isStoryFailed,
  clampHp,
} from "@/lib/game/hp-manager";

describe("hp-manager constants", () => {
  it("MAX_HP should be 5", () => {
    expect(MAX_HP).toBe(5);
  });

  it("FAILURE_HP should be 0", () => {
    expect(FAILURE_HP).toBe(0);
  });
});

describe("initialHp", () => {
  it("should return MAX_HP", () => {
    expect(initialHp()).toBe(MAX_HP);
  });

  it("should return 5", () => {
    expect(initialHp()).toBe(5);
  });
});

describe("deductHp", () => {
  it("should deduct exactly 1 from a full HP value", () => {
    expect(deductHp(5)).toBe(4);
  });

  it("should deduct exactly 1 from a mid-range value", () => {
    expect(deductHp(3)).toBe(2);
  });

  it("should deduct exactly 1 from 1 to reach 0", () => {
    expect(deductHp(1)).toBe(0);
  });

  it("should not go below 0 when already at 0", () => {
    expect(deductHp(0)).toBe(0);
  });

  it("should not go below 0 when called on a negative value", () => {
    // Defensive: clamp even if an invalid value somehow slips through
    expect(deductHp(-1)).toBe(0);
  });

  it("cumulative deductions should correctly reach 0 from MAX_HP", () => {
    let hp = initialHp(); // 5
    for (let i = 0; i < MAX_HP; i++) {
      hp = deductHp(hp);
    }
    expect(hp).toBe(0);
  });

  it("further deductions after reaching 0 remain at 0", () => {
    let hp = 0;
    hp = deductHp(hp);
    hp = deductHp(hp);
    expect(hp).toBe(0);
  });
});

describe("isStoryFailed", () => {
  it("should return true at HP 0", () => {
    expect(isStoryFailed(0)).toBe(true);
  });

  it("should return false at HP 1", () => {
    expect(isStoryFailed(1)).toBe(false);
  });

  it("should return false at HP 5", () => {
    expect(isStoryFailed(5)).toBe(false);
  });

  it("should return true for negative values (defensive)", () => {
    expect(isStoryFailed(-1)).toBe(true);
  });

  it("each HP value from 1–5 should not be failed", () => {
    for (let hp = 1; hp <= MAX_HP; hp++) {
      expect(isStoryFailed(hp), `HP ${hp} should not be failed`).toBe(false);
    }
  });
});

describe("clampHp", () => {
  it("should return the value unchanged when within range", () => {
    expect(clampHp(3)).toBe(3);
    expect(clampHp(0)).toBe(0);
    expect(clampHp(5)).toBe(5);
  });

  it("should clamp values above MAX_HP to MAX_HP", () => {
    expect(clampHp(6)).toBe(MAX_HP);
    expect(clampHp(100)).toBe(MAX_HP);
  });

  it("should clamp negative values to 0", () => {
    expect(clampHp(-1)).toBe(0);
    expect(clampHp(-100)).toBe(0);
  });
});
