// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Thumbnail } from "@remotion/player";
import { LessonVisualBoard } from "@/components/stage/visual-compositions";
import { lessonHeading, type LessonStep } from "@/components/stage/compositions";
import { visualDuration } from "@/components/stage/visual-layout";
import { CANVAS_FPS, CANVAS_HEIGHT, CANVAS_WIDTH } from "@/components/stage/canvas-layout";
import type { LessonVisual } from "@/lib/types/visual";

/** Render the last frame of a lesson visual (what "fast" pacing shows). */
function lastFrame(visual: LessonVisual, title = "Lesson title", step?: LessonStep) {
  const duration = visualDuration(visual);
  return render(
    <Thumbnail
      component={LessonVisualBoard as unknown as React.ComponentType<Record<string, unknown>>}
      inputProps={{ title, visual, seed: 1, step }}
      compositionWidth={CANVAS_WIDTH}
      compositionHeight={CANVAS_HEIGHT}
      durationInFrames={duration}
      fps={CANVAS_FPS}
      frameToDisplay={duration - 1}
    />
  );
}

const cases: Array<[string, LessonVisual, string[]]> = [
  [
    "vectors",
    {
      kind: "vectors",
      vectors: [
        { from: [0, 0], to: [4, 2], label: "2A" },
        { from: [4, 2], to: [5, 4], label: "B" },
      ],
      points: [{ at: [5, 4], label: "target" }],
      caption: "Tip to tail.",
    },
    ["2A", "B", "target", "Tip to tail."],
  ],
  [
    "plot",
    { kind: "plot", x_label: "time (s)", y_label: "speed", series: [{ label: "car", points: [[0, 0], [1, 3], [2, 6]] }] },
    ["time (s)", "speed", "car"],
  ],
  [
    "diagram",
    {
      kind: "diagram",
      layout: "cycle",
      nodes: [
        { id: "e", label: "Evaporation" },
        { id: "c", label: "Condensation", detail: "vapour → droplets" },
        { id: "p", label: "Precipitation" },
      ],
      edges: [
        { from: "e", to: "c", label: "rises" },
        { from: "c", to: "p" },
        { from: "p", to: "e" },
      ],
    },
    ["Evaporation", "Condensation", "vapour → droplets", "Precipitation", "rises"],
  ],
  [
    "table",
    { kind: "table", headers: ["A", "B", "A OR B"], rows: [["0", "0", "0"], ["0", "1", "1"]], highlight_rows: [1] },
    ["A OR B"],
  ],
  [
    "formula",
    { kind: "formula", expression: "F = m · a", terms: [{ symbol: "m", meaning: "mass in kg" }], example: "2 · 3 = 6 N" },
    ["F = m · a", "mass in kg", "2 · 3 = 6 N"],
  ],
];

describe("LessonVisualBoard", () => {
  it.each(cases)("draws a %s visual with every label on its last frame", (_kind, visual, labels) => {
    const { container } = lastFrame(visual, "Crystal Vectors");
    const text = container.textContent ?? "";
    expect(text).toContain("Crystal Vectors");
    for (const label of labels) expect(text).toContain(label);
  });
});

describe("lesson step heading", () => {
  it("numbers the steps of a multi-step lesson", () => {
    expect(lessonHeading()).toBe("Lesson");
    expect(lessonHeading({ index: 0, total: 1 })).toBe("Lesson");
    expect(lessonHeading({ index: 1, total: 4 })).toBe("Lesson · 2 / 4");
  });

  it("shows the step on the illustrated board", () => {
    const visual: LessonVisual = { kind: "vectors", vectors: [{ from: [0, 0], to: [1, 1] }] };
    const { container } = lastFrame(visual, "Penjumlahan Vektor", { index: 2, total: 3 });
    expect(container.textContent).toContain("Lesson · 3 / 3");
  });
});
