// Lesson: a three step flow (visual kind "diagram", layout "flow") built from Series and Sequence.
// Series spotlights one step at a time for 30 frames each; a Sequence from frame 90 then shows
// the whole flow. useCurrentFrame() inside a Sequence is relative to the start of that Sequence.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, Sequence, Series, interpolate, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 150 };

const INK = "var(--color-ink)";
const GOLD = "var(--color-gold)";
const CREAM = "var(--color-cream)";
const MUTED = "var(--color-muted)";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

const STEPS = [
  { label: "Read", detail: "Take in the material" },
  { label: "Practise", detail: "Answer small questions" },
  { label: "Recall", detail: "Test yourself later" },
];
const EDGES = ["next", "then"];

function Spotlight(props: { index: number; label: string; detail: string }): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    {
      style: {
        background: INK,
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        opacity: ramp(frame, 0, 8),
      },
    },
    createElement(
      "div",
      { style: { color: MUTED, fontSize: 28, fontFamily: "var(--font-mono)" } },
      `Step ${props.index + 1} of ${STEPS.length}`,
    ),
    createElement(
      "div",
      { style: { color: GOLD, fontSize: 96, fontWeight: 600, fontFamily: "var(--font-display)" } },
      props.label,
    ),
    createElement(
      "div",
      { style: { color: CREAM, fontSize: 36, fontFamily: "var(--font-display)" } },
      props.detail,
    ),
  );
}

function text(
  content: string,
  x: number,
  y: number,
  paint: string,
  size: number,
  opacity: number,
): ReactElement {
  return createElement(
    "text",
    { x, y, fill: paint, fontSize: size, textAnchor: "middle", opacity, fontFamily: "var(--font-mono)" },
    content,
  );
}

function Overview(): ReactElement {
  const frame = useCurrentFrame();
  const centers = [220, 640, 1060];

  const boxes = STEPS.map((step, i) => {
    const opacity = ramp(frame, i * 8, i * 8 + 10);
    return createElement(
      "g",
      null,
      createElement("rect", {
        x: centers[i] - 160,
        y: 270,
        width: 320,
        height: 120,
        fill: INK,
        stroke: GOLD,
        strokeWidth: 2,
        opacity,
      }),
      text(step.label, centers[i], 322, CREAM, 32, opacity),
      text(step.detail, centers[i], 360, MUTED, 18, opacity),
    );
  });

  const links = EDGES.map((name, i) => {
    const x1 = centers[i] + 160;
    const x2 = centers[i + 1] - 160;
    const p = ramp(frame, 20 + i * 8, 32 + i * 8);
    const x = x1 + (x2 - x1) * p;
    return createElement(
      "g",
      null,
      createElement("line", { x1, y1: 330, x2: x, y2: 330, stroke: GOLD, strokeWidth: 4, opacity: p > 0 ? 1 : 0 }),
      createElement("polygon", {
        points: `${x},330 ${x - 20},318 ${x - 20},342`,
        fill: GOLD,
        opacity: p > 0 ? 1 : 0,
      }),
      text(name, (x1 + x2) / 2, 300, GOLD, 24, ramp(frame, 30 + i * 8, 40 + i * 8)),
    );
  });

  return createElement(
    AbsoluteFill,
    { style: { background: INK } },
    createElement(
      "svg",
      { width: 1280, height: 720, viewBox: "0 0 1280 720", style: { display: "block" } },
      ...links,
      ...boxes,
    ),
    createElement(
      "div",
      {
        style: {
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 30,
          textAlign: "center",
          color: CREAM,
          fontSize: 26,
          fontFamily: "var(--font-display)",
          opacity: ramp(frame, 35, 50),
        },
      },
      "Read, practise, then recall: each step feeds the next.",
    ),
  );
}

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: INK } },
    createElement(
      Series,
      null,
      ...STEPS.map((step, i) =>
        createElement(
          Series.Sequence,
          { durationInFrames: 30 },
          createElement(Spotlight, { index: i, label: step.label, detail: step.detail }),
        ),
      ),
    ),
    createElement(Sequence, { from: 90, durationInFrames: 60 }, createElement(Overview, null)),
    createElement("div", {
      style: {
        position: "absolute",
        left: 0,
        bottom: 0,
        height: 6,
        width: `${(frame / 149) * 100}%`,
        background: GOLD,
      },
    }),
  );
}
