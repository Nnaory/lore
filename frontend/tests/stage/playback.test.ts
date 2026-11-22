/**
 * playback.test.ts — examples for the CanvasFrame player bar math.
 */
import { describe, expect, it } from "vitest";
import { canvasLabel, formatClock, progressPercent } from "@/lib/stage/playback";

describe("progressPercent", () => {
  it("computes and clamps", () => {
    expect(progressPercent(30, 120)).toEqual({ ok: true, percent: 25 });
    expect(progressPercent(0, 120)).toEqual({ ok: true, percent: 0 });
    expect(progressPercent(500, 120)).toEqual({ ok: true, percent: 100 });
    expect(progressPercent(-5, 120)).toEqual({ ok: true, percent: 0 });
  });
  it("rejects invalid input", () => {
    for (const [f, t] of [
      [1, 0],
      [1, -3],
      [NaN, 10],
      [1, Infinity],
    ] as const) {
      expect(progressPercent(f, t)).toEqual({ ok: false, reason: "invalid_input" });
    }
  });
});

describe("formatClock", () => {
  it("formats m:ss", () => {
    expect(formatClock(0)).toEqual({ ok: true, text: "0:00" });
    expect(formatClock(5.9)).toEqual({ ok: true, text: "0:05" });
    expect(formatClock(65)).toEqual({ ok: true, text: "1:05" });
    expect(formatClock(600)).toEqual({ ok: true, text: "10:00" });
    expect(formatClock(-12)).toEqual({ ok: true, text: "0:00" });
  });
  it("rejects non-finite", () => {
    expect(formatClock(NaN)).toEqual({ ok: false, reason: "invalid_input" });
    expect(formatClock(Infinity)).toEqual({ ok: false, reason: "invalid_input" });
  });
});

describe("canvasLabel", () => {
  const shape = /^[a-z0-9_]{1,24}$/;
  it("always matches the label shape", () => {
    const inputs = [
      "The Last Beacon",
      "Café Ünïcode!",
      "  --  ",
      "",
      "a".repeat(100),
      "word ".repeat(20),
      "日本語",
      "x_y__z",
    ];
    for (const s of inputs) {
      const r = canvasLabel(s);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.label).toMatch(shape);
    }
  });
  it("converts specific examples", () => {
    expect(canvasLabel("The Last Beacon")).toEqual({ ok: true, label: "the_last_beacon" });
    expect(canvasLabel("Café")).toEqual({ ok: true, label: "cafe" });
    expect(canvasLabel("!!!")).toEqual({ ok: true, label: "scene" });
  });
  it("rejects non-strings", () => {
    expect(canvasLabel(5 as unknown as string)).toEqual({ ok: false, reason: "invalid_input" });
  });
});
