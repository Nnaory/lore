/**
 * Tests: canvas-timeline.ts (task 27.2), design 7.6, Requirements 30.8, 30.14, 31.3, 31.14.
 *
 * The rule that `StageCanvas` (which kind it reports) and `CanvasPane` (which length and markers the
 * PlayerBar gets) share: the animation counts as shown only in `playing` and `paused`, and a status
 * report from another scene is never believed.
 */
import { describe, expect, it } from "vitest";
import type { AnimationStatus } from "@/lib/animation/scene-status";
import {
  iframeShown,
  pauseKeyframes,
  sceneKeyframes,
  shouldRemountOnReveal,
  statusForScene,
  type CanvasAnimationStatus,
} from "@/lib/stage/canvas-timeline";

const ALL: CanvasAnimationStatus[] = [
  "off",
  "loading",
  "playing",
  "paused",
  "failed:urls",
  "failed:fetch",
  "failed:integrity",
  "failed:load",
  "failed:runtime",
  "failed:timeout",
];

describe("iframeShown", () => {
  it.each(ALL)("%s", (status) => {
    expect(iframeShown(status)).toBe(status === "playing" || status === "paused");
  });
});

describe("shouldRemountOnReveal", () => {
  it.each(ALL)("%s", (status) => {
    // A scene that failed (or is not an animation) is left as it is; every other one starts afresh.
    expect(shouldRemountOnReveal(status)).toBe(status === "loading" || status === "playing" || status === "paused");
  });
});

describe("statusForScene", () => {
  const reported = { key: "puzzle:p1", value: "playing" } satisfies { key: string; value: AnimationStatus };

  it("believes a report that carries the key of the current scene", () => {
    expect(statusForScene(reported, "puzzle:p1")).toBe("playing");
  });

  it("starts at loading when nothing was reported yet", () => {
    expect(statusForScene(null, "puzzle:p1")).toBe("loading");
  });

  it("does not believe a report that belongs to another scene", () => {
    expect(statusForScene(reported, "puzzle:p2")).toBe("loading");
    expect(statusForScene({ key: "puzzle:p1", value: "failed:fetch" }, "puzzle:p1:other")).toBe("loading");
  });
});

describe("pauseKeyframes", () => {
  it("puts one marker at pause_at_frame / duration * 100", () => {
    expect(pauseKeyframes(200, 50)).toEqual([25]);
    expect(pauseKeyframes(210, 150)).toEqual([(150 / 210) * 100]);
  });

  it("has no marker for a lesson (no pause_at_frame)", () => {
    expect(pauseKeyframes(210, undefined)).toEqual([]);
  });

  it("makes no marker from numbers that cannot make one", () => {
    expect(pauseKeyframes(0, 10)).toEqual([]);
    expect(pauseKeyframes(-5, 10)).toEqual([]);
    expect(pauseKeyframes(Number.NaN, 10)).toEqual([]);
    expect(pauseKeyframes(200, Number.NaN)).toEqual([]);
    expect(pauseKeyframes(200, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe("sceneKeyframes", () => {
  it("is what the CanvasPane always drew: [100] for puzzle and decision, nothing for the rest", () => {
    expect(sceneKeyframes("puzzle")).toEqual([100]);
    expect(sceneKeyframes("decision")).toEqual([100]);
    for (const kind of ["lesson", "visual", "ambient", "animation"]) expect(sceneKeyframes(kind)).toEqual([]);
  });
});
