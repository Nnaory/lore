// Lesson: two lines on one plot (visual kind "plot"). Lines grow with a dash offset,
// the legend sits beside each line end, and all colours are Kit tokens.
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

const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

/** Plot box: x 0..4 over 200..1000 px, y 0..20 over 560..160 px. */
const px = (x: number, y: number) => ({ x: 200 + x * 200, y: 560 - y * 20 });

type Series = { label: string; points: [number, number][]; tone: string; start: number };

const SERIES: Series[] = [
  { label: "walking", points: [[0, 0], [1, 2], [2, 4], [3, 6], [4, 8]], tone: GOLD, start: 15 },
  { label: "cycling", points: [[0, 0], [1, 5], [2, 10], [3, 15], [4, 20]], tone: EMBER, start: 40 },
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
    { x, y, fill: paint, fontSize: 26, textAnchor: anchor, opacity, fontFamily: "var(--font-mono)" },
    content,
  );
}

function rule(x1: number, y1: number, x2: number, y2: number, paint: string, width: number): ReactElement {
  return createElement("line", { x1, y1, x2, y2, stroke: paint, strokeWidth: width });
}

function curve(s: Series, frame: number): ReactElement {
  const pts = s.points.map((q) => px(q[0], q[1]));
  const d = pts.map((q, i) => `${i === 0 ? "M" : "L"} ${q.x} ${q.y}`).join(" ");
  const total = pts.reduce(
    (sum, q, i) => (i === 0 ? 0 : sum + Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y)),
    0,
  );
  const p = ramp(frame, s.start, s.start + 45);
  return createElement(
    "g",
    null,
    createElement("path", {
      d,
      fill: "none",
      stroke: s.tone,
      strokeWidth: 5,
      strokeLinejoin: "round",
      strokeDasharray: total,
      strokeDashoffset: total * (1 - p),
    }),
    ...pts.map((q, i) =>
      createElement("circle", { cx: q.x, cy: q.y, r: 7, fill: s.tone, opacity: p >= i / (pts.length - 1) ? 1 : 0 }),
    ),
  );
}

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const axes = ramp(frame, 0, 15);

  const grid = createElement(
    "g",
    { opacity: axes },
    ...[0, 1, 2, 3, 4].map((x) => rule(px(x, 0).x, px(x, 0).y, px(x, 20).x, px(x, 20).y, SMOKE, 1)),
    ...[0, 5, 10, 15, 20].map((y) => rule(px(0, y).x, px(0, y).y, px(4, y).x, px(4, y).y, SMOKE, 1)),
    rule(px(0, 0).x, px(0, 0).y, px(4, 0).x, px(4, 0).y, MUTED, 2),
    rule(px(0, 0).x, px(0, 0).y, px(0, 20).x, px(0, 20).y, MUTED, 2),
    label("time (s)", px(4, 0).x, px(4, 0).y + 52, MUTED, "end", 1),
    label("distance (m)", px(0, 20).x, px(0, 20).y - 22, MUTED, "start", 1),
  );

  const drawing = createElement(
    "svg",
    { width: 1280, height: 720, viewBox: "0 0 1280 720", style: { display: "block" } },
    grid,
    ...SERIES.map((s) => curve(s, frame)),
    ...SERIES.map((s) => {
      const end = px(s.points[s.points.length - 1][0], s.points[s.points.length - 1][1]);
      return label(s.label, end.x + 18, end.y + 8, s.tone, "start", ramp(frame, s.start + 35, s.start + 50));
    }),
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
        "Distance over time",
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
      "Steeper line means higher speed.",
    ),
  );
}
