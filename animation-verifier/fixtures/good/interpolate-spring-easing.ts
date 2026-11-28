// Lesson: one growth curve (visual kind "plot") that exercises interpolate with Easing, and spring.
// The line is revealed with an eased interpolate, the head dot bounces with spring when it
// arrives, and the series label slides in with an ease-out.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 150 };

const INK = "var(--color-ink)";
const SMOKE = "var(--color-smoke)";
const GOLD = "var(--color-gold)";
const CREAM = "var(--color-cream)";
const MUTED = "var(--color-muted)";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

/** Plot box: x 0..10 over 200..1000 px, y 0..30 over 560..200 px. */
const px = (x: number, y: number) => ({ x: 200 + x * 80, y: 560 - y * 12 });

const POINTS = [
  [0, 2],
  [2, 3],
  [4, 6],
  [6, 12],
  [8, 22],
  [10, 30],
].map((q) => px(q[0], q[1]));

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

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Eased reveal of the line, from frame 15 to frame 90.
  const grow = interpolate(frame, [15, 90], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const headX = POINTS[0].x + grow * (POINTS[POINTS.length - 1].x - POINTS[0].x);
  const headY = interpolate(
    headX,
    POINTS.map((q) => q.x),
    POINTS.map((q) => q.y),
    CLAMP,
  );
  const visible = [...POINTS.filter((q) => q.x < headX), { x: headX, y: headY }];
  const d = visible.map((q, i) => `${i === 0 ? "M" : "L"} ${q.x} ${q.y}`).join(" ");

  // The head dot bounces once the line has arrived.
  const bounce = spring({ frame: frame - 85, fps, config: { damping: 10, stiffness: 120 } });
  const slide = interpolate(frame, [85, 110], [30, 0], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const end = POINTS[POINTS.length - 1];

  const axes = interpolate(frame, [0, 15], [0, 1], { ...CLAMP, easing: Easing.bezier(0.4, 0, 0.2, 1) });
  const grid = createElement(
    "g",
    { opacity: axes },
    ...[0, 2, 4, 6, 8, 10].map((x) => rule(px(x, 0).x, px(x, 0).y, px(x, 30).x, px(x, 30).y, SMOKE, 1)),
    ...[0, 10, 20, 30].map((y) => rule(px(0, y).x, px(0, y).y, px(10, y).x, px(10, y).y, SMOKE, 1)),
    rule(px(0, 0).x, px(0, 0).y, px(10, 0).x, px(10, 0).y, MUTED, 2),
    rule(px(0, 0).x, px(0, 0).y, px(0, 30).x, px(0, 30).y, MUTED, 2),
    label("day", px(10, 0).x, px(10, 0).y + 52, MUTED, "end", 1),
    label("height (cm)", px(0, 30).x, px(0, 30).y - 24, MUTED, "start", 1),
  );

  const drawing = createElement(
    "svg",
    { width: 1280, height: 720, viewBox: "0 0 1280 720", style: { display: "block" } },
    grid,
    createElement("path", { d, fill: "none", stroke: GOLD, strokeWidth: 5, strokeLinejoin: "round" }),
    ...POINTS.map((q) =>
      createElement("circle", { cx: q.x, cy: q.y, r: 6, fill: GOLD, opacity: headX >= q.x ? 1 : 0 }),
    ),
    createElement("circle", { cx: headX, cy: headY, r: 6 + 8 * bounce, fill: CREAM }),
    label("seedling", end.x + 18 + slide, end.y + 8, GOLD, "start", ramp(frame, 85, 100)),
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
        "Seedling growth",
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
          opacity: interpolate(frame, [110, 130], [0, 1], { ...CLAMP, easing: Easing.out(Easing.quad) }),
        },
      },
      "Growth starts slowly, then speeds up.",
    ),
  );
}
