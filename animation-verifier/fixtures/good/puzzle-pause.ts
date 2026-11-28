// Puzzle: A + B = R with B unknown (visual kind "vectors", kind "puzzle", pauseAtFrame 90).
// Until frame 90 the picture only poses the problem; the answer text and the arrow for B
// appear after the pause, so the forbidden token never shows on or before frame 90.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 150, pauseAtFrame: 90 };

// Keep in sync with meta.pauseAtFrame (meta must stay a literal object).
const PAUSE = 90;

const INK = "var(--color-ink)";
const SMOKE = "var(--color-smoke)";
const GOLD = "var(--color-gold)";
const EMBER = "var(--color-ember)";
const CREAM = "var(--color-cream)";
const MUTED = "var(--color-muted)";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

/** Plane to pixels: origin at (200, 590), 150 px per x unit, 90 px per y unit. */
const px = (x: number, y: number) => ({ x: 200 + x * 150, y: 590 - y * 90 });

type Arrow = { from: [number, number]; to: [number, number]; tone: string; start: number };

const A: Arrow = { from: [0, 0], to: [1, 3], tone: GOLD, start: 10 };
const R: Arrow = { from: [0, 0], to: [5, 4], tone: CREAM, start: 35 };
const B: Arrow = { from: [1, 3], to: [5, 4], tone: EMBER, start: PAUSE + 5 };

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
    { x, y, fill: paint, fontSize: 30, textAnchor: anchor, opacity, fontFamily: "var(--font-mono)" },
    content,
  );
}

function rule(x1: number, y1: number, x2: number, y2: number, paint: string, width: number): ReactElement {
  return createElement("line", { x1, y1, x2, y2, stroke: paint, strokeWidth: width });
}

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
  const tip = px(5, 4);
  const posed = ramp(frame, 60, 75);

  const plane = createElement(
    "g",
    { opacity: ramp(frame, 0, 10) },
    ...[0, 1, 2, 3, 4, 5, 6].map((x) => rule(px(x, 0).x, px(x, 0).y, px(x, 5).x, px(x, 5).y, SMOKE, 1)),
    ...[0, 1, 2, 3, 4, 5].map((y) => rule(px(0, y).x, px(0, y).y, px(6, y).x, px(6, y).y, SMOKE, 1)),
    rule(px(0, 0).x, px(0, 0).y, px(6, 0).x, px(6, 0).y, MUTED, 2),
    rule(px(0, 0).x, px(0, 0).y, px(0, 5).x, px(0, 5).y, MUTED, 2),
  );

  const drawing = createElement(
    "svg",
    { width: 1280, height: 720, viewBox: "0 0 1280 720", style: { display: "block" } },
    plane,
    arrow(A, frame),
    arrow(R, frame),
    arrow(B, frame),
    label("A", 255, 455, A.tone, "end", ramp(frame, 22, 32)),
    label("R = A + B", 560, 390, R.tone, "end", ramp(frame, 47, 57)),
    label("B = ?", tip.x + 18, tip.y - 12, GOLD, "start", posed),
    frame > PAUSE ? label("(4, 1)", 650, 250, GOLD, "middle", ramp(frame, PAUSE + 25, PAUSE + 40)) : null,
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
        "What is B?",
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
          opacity: ramp(frame, 70, 85),
        },
      },
      "A + B must land on the tip of R.",
    ),
  );
}
