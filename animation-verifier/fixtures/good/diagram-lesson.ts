// Lesson: the water cycle as three boxes joined by arrows (visual kind "diagram", layout "cycle").
// Boxes fade in one after another, each arrow grows once both of its ends exist.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 120 };

const INK = "var(--color-ink)";
const GOLD = "var(--color-gold)";
const CREAM = "var(--color-cream)";
const MUTED = "var(--color-muted)";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

const BOX_W = 340;
const BOX_H = 110;

type Box = { label: string; detail: string; cx: number; cy: number; start: number };

const BOXES: Box[] = [
  { label: "Evaporation", detail: "Heat lifts water as vapour", cx: 260, cy: 520, start: 10 },
  { label: "Condensation", detail: "Vapour cools into droplets", cx: 640, cy: 230, start: 35 },
  { label: "Precipitation", detail: "Droplets fall as rain", cx: 1020, cy: 520, start: 60 },
];

type Link = {
  from: [number, number];
  to: [number, number];
  label: string;
  labelAt: [number, number];
  anchor: "start" | "middle" | "end";
  start: number;
};

const LINKS: Link[] = [
  { from: [350, 465], to: [500, 285], label: "rises", labelAt: [398, 380], anchor: "end", start: 25 },
  { from: [780, 285], to: [930, 465], label: "falls", labelAt: [880, 380], anchor: "start", start: 50 },
  { from: [850, 520], to: [430, 520], label: "flows back", labelAt: [640, 496], anchor: "middle", start: 75 },
];

function text(
  content: string,
  x: number,
  y: number,
  paint: string,
  size: number,
  anchor: "start" | "middle" | "end",
  opacity: number,
): ReactElement {
  return createElement(
    "text",
    { x, y, fill: paint, fontSize: size, textAnchor: anchor, opacity, fontFamily: "var(--font-mono)" },
    content,
  );
}

function box(b: Box, frame: number): ReactElement {
  const opacity = ramp(frame, b.start, b.start + 12);
  return createElement(
    "g",
    null,
    createElement("rect", {
      x: b.cx - BOX_W / 2,
      y: b.cy - BOX_H / 2,
      width: BOX_W,
      height: BOX_H,
      fill: INK,
      stroke: GOLD,
      strokeWidth: 2,
      opacity,
    }),
    text(b.label, b.cx, b.cy - 6, CREAM, 28, "middle", opacity),
    text(b.detail, b.cx, b.cy + 28, MUTED, 18, "middle", opacity),
  );
}

function link(l: Link, frame: number): ReactElement | null {
  const p = ramp(frame, l.start, l.start + 20);
  if (p <= 0) return null;
  const x = l.from[0] + (l.to[0] - l.from[0]) * p;
  const y = l.from[1] + (l.to[1] - l.from[1]) * p;
  const angle = Math.atan2(l.to[1] - l.from[1], l.to[0] - l.from[0]);
  const wing = (turn: number): string =>
    `${x - 22 * Math.cos(angle + turn)},${y - 22 * Math.sin(angle + turn)}`;
  return createElement(
    "g",
    null,
    createElement("line", { x1: l.from[0], y1: l.from[1], x2: x, y2: y, stroke: GOLD, strokeWidth: 4 }),
    createElement("polygon", { points: `${x},${y} ${wing(0.4)} ${wing(-0.4)}`, fill: GOLD }),
    text(l.label, l.labelAt[0], l.labelAt[1], GOLD, 24, l.anchor, ramp(frame, l.start + 10, l.start + 20)),
  );
}

export default function Main(): ReactElement {
  const frame = useCurrentFrame();

  const drawing = createElement(
    "svg",
    { width: 1280, height: 720, viewBox: "0 0 1280 720", style: { display: "block" } },
    ...LINKS.map((l) => link(l, frame)),
    ...BOXES.map((b) => box(b, frame)),
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
        "The water cycle",
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
      "Water keeps cycling between sea, sky and land.",
    ),
  );
}
