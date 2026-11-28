// Lesson: a truth table whose rows appear one by one (visual kind "table").
// Uses the common alias `createElement as h`; the highlighted row is shown inverted (cream on ink).
import { createElement as h } from "react";
import type { CSSProperties, ReactElement } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 120 };

const INK = "var(--color-ink)";
const GOLD = "var(--color-gold)";
const CREAM = "var(--color-cream)";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

const HEADERS = ["A", "B", "A AND B"];
const ROWS = [
  ["0", "0", "0"],
  ["0", "1", "0"],
  ["1", "0", "0"],
  ["1", "1", "1"],
];
const HIGHLIGHT = 3;

const CELL: CSSProperties = {
  padding: "14px 24px",
  textAlign: "center",
  fontSize: 44,
  fontFamily: "var(--font-mono)",
};

export default function Main(): ReactElement {
  const frame = useCurrentFrame();

  const head = h(
    "thead",
    null,
    h(
      "tr",
      { style: { opacity: ramp(frame, 5, 17) } },
      ...HEADERS.map((title) =>
        h("th", { style: { ...CELL, color: GOLD, borderBottom: "2px solid var(--color-gold)" } }, title),
      ),
    ),
  );

  const body = h(
    "tbody",
    null,
    ...ROWS.map((row, r) => {
      const hot = r === HIGHLIGHT;
      const style: CSSProperties = {
        opacity: ramp(frame, 20 + r * 10, 32 + r * 10),
        background: hot ? CREAM : INK,
        color: hot ? INK : CREAM,
        borderBottom: "1px solid var(--color-smoke)",
      };
      return h("tr", { style }, ...row.map((value) => h("td", { style: CELL }, value)));
    }),
  );

  return h(
    AbsoluteFill,
    { style: { background: INK } },
    h(
      AbsoluteFill,
      { style: { padding: "36px 80px" } },
      h(
        "div",
        { style: { color: GOLD, fontSize: 44, fontWeight: 600, fontFamily: "var(--font-display)" } },
        "AND gate truth table",
      ),
    ),
    h(
      AbsoluteFill,
      { style: { alignItems: "center", justifyContent: "center" } },
      h("table", { style: { width: 800, borderCollapse: "collapse" } }, head, body),
    ),
    h(
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
          opacity: ramp(frame, 80, 95),
        },
      },
      "The output is 1 only when both inputs are 1.",
    ),
  );
}
