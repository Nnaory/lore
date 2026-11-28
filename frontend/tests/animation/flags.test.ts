/**
 * Tests — animation build flag
 *
 * Only the exact string "on" turns lesson animations on (design 7.9, Requirement 36.1).
 * `readAnimationsFlag` reads `process.env.NEXT_PUBLIC_ANIMATIONS` at call time, so these cases
 * stub the variable and read it again.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { animationsEnabled, readAnimationsFlag } from "@/lib/animation/flags";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("animationsEnabled", () => {
  it('is true only for the exact value "on"', () => {
    expect(animationsEnabled("on")).toBe(true);
  });

  it.each(["ON", "On", "true", "1", "", "off", " on", "on "])("reads %j as off", (raw) => {
    expect(animationsEnabled(raw)).toBe(false);
  });

  it("reads an unset value as off", () => {
    expect(animationsEnabled(undefined)).toBe(false);
  });
});

describe("readAnimationsFlag", () => {
  it('is true when NEXT_PUBLIC_ANIMATIONS is "on"', () => {
    vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", "on");
    expect(readAnimationsFlag()).toBe(true);
  });

  it.each(["off", "ON", "true", "1", ""])("is false when NEXT_PUBLIC_ANIMATIONS is %j", (raw) => {
    vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", raw);
    expect(readAnimationsFlag()).toBe(false);
  });

  it("is false when NEXT_PUBLIC_ANIMATIONS is not set", () => {
    vi.stubEnv("NEXT_PUBLIC_ANIMATIONS", undefined as unknown as string);
    expect(readAnimationsFlag()).toBe(false);
  });
});
