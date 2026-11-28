// Lesson: adding two vectors tip to tail (visual kind "vectors").
// Every label is real text on the last frame, colours are Kit tokens only,
// and the output depends only on useCurrentFrame().
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 120 };

const INK = "var(--color-ink)";
const SMOKE = "var(--color-smoke)";
const GOLD = "var(--color-gold)";
const EMBER = "var(--color-ember)";
const CREAM = "var(--color-cream)";
const MUTED = "var(--color-muted)";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 before `from`, 1 after `to`, linear in between. */
const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

/** Plane to pixels: origin at (200, 590), 150 px per x unit, 90 px per y unit. */
const px = (x: number, y: number) => ({ x: 200 + x * 150, y: 590 - y * 90 });

type Arrow = {
  from: [number, number];
  to: [number, number];
  label: string;
  tone: string;
  start: number;
  labelAt: [number, number];
  anchor: "start" | "middle" | "end";
};

const ARROWS: Arrow[] = [
  { from: [0, 0], to: [3, 1], label: "A", tone: GOLD, start: 15, labelAt: [425, 580], anchor: "middle" },
  { from: [3, 1], to: [5, 4], label: "B", tone: EMBER, start: 40, labelAt: [836, 396], anchor: "start" },
  { from: [0, 0], to: [5, 4], label: "A + B", tone: CREAM, start: 65, labelAt: [540, 384], anchor: "end" },
];

function label(
  content: string,
  x: number,
  y: number,
  paint: string,
  anchor: "start" | "middle" | "end",
  opacity: number,
): ReactElement {
  return createElement(
    "text",
    { x, y, fill: paint, fontSize: 28, textAnchor: anchor, opacity, fontFamily: "var(--font-mono)" },
    content,
  );
}

function rule(x1: number, y1: number, x2: number, y2: number, paint: string, width: number): ReactElement {
  return createElement("line", { x1, y1, x2, y2, stroke: paint, strokeWidth: width });
}

/** A shaft that grows from tail to tip, with an arrow head riding on its end. */
function arrow(a: Arrow, frame: number): ReactElement | null {
  const p = ramp(frame, a.start, a.start + 25);
  if (p <= 0) return null;
  const tail = px(a.from[0], a.from[1]);
  const tip = px(a.to[0], a.to[1]);
  const x = tail.x + (tip.x - tail.x) * p;
  const y = tail.y + (tip.y - tail.y) * p;
  const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
  const wing = (turn: number): string =>
    `${x - 24 * Math.cos(angle + turn)},${y - 24 * Math.sin(angle + turn)}`;
  return createElement(
    "g",
    null,
    createElement("line", { x1: tail.x, y1: tail.y, x2: x, y2: y, stroke: a.tone, strokeWidth: 5 }),
    createElement("polygon", { points: `${x},${y} ${wing(0.4)} ${wing(-0.4)}`, fill: a.tone }),
  );
}

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const xs = [0, 1, 2, 3, 4, 5, 6];
  const ys = [0, 1, 2, 3, 4, 5];
  const tip = px(5, 4);
  const pointOpacity = ramp(frame, 90, 100);

  const plane = createElement(
    "g",
    { opacity: ramp(frame, 0, 15) },
    ...xs.map((x) => rule(px(x, 0).x, px(x, 0).y, px(x, 5).x, px(x, 5).y, SMOKE, 1)),
    ...ys.map((y) => rule(px(0, y).x, px(0, y).y, px(6, y).x, px(6, y).y, SMOKE, 1)),
    rule(px(0, 0).x, px(0, 0).y, px(6, 0).x, px(6, 0).y, MUTED, 2),
    rule(px(0, 0).x, px(0, 0).y, px(0, 5).x, px(0, 5).y, MUTED, 2),
  );

  const drawing = createElement(
    "svg",
    { width: 1280, height: 720, viewBox: "0 0 1280 720", style: { display: "block" } },
    plane,
    ...ARROWS.map((a) => arrow(a, frame)),
    ...ARROWS.map((a) =>
      label(a.label, a.labelAt[0], a.labelAt[1], a.tone, a.anchor, ramp(frame, a.start + 12, a.start + 22)),
    ),
    createElement("circle", { cx: tip.x, cy: tip.y, r: 9, fill: CREAM, opacity: pointOpacity }),
    label("target", tip.x + 18, tip.y - 12, CREAM, "start", pointOpacity),
  );

  return createElement(
    AbsoluteFill,
    { style: { background: INK } },
    createElement(AbsoluteFill, null, drawing),
    createElement(
      AbsoluteFill,
      { style: { padding: "36px 80px" } },
      createElement(
        "div",
        { style: { color: GOLD, fontSize: 44, fontWeight: 600, fontFamily: "var(--font-display)" } },
        "Adding vectors",
      ),
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
          opacity: ramp(frame, 95, 110),
        },
      },
      "Place B at the tip of A. The sum runs from the first tail to the last tip.",
    ),
  );
}
