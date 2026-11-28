// Lesson: Newton's second law with its terms and a worked example (visual kind "formula").
// The expression slides in, each term fades in one by one, then the example is typed out.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 150 };

const INK = "var(--color-ink)";
const GOLD = "var(--color-gold)";
const CREAM = "var(--color-cream)";
const MUTED = "var(--color-muted)";

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const ramp = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], CLAMP);

const EXPRESSION = "F = m * a";
const EXAMPLE = "2 kg * 3 m/s^2 = 6 N";
const TERMS = [
  { symbol: "F", meaning: "net force in newtons" },
  { symbol: "m", meaning: "mass in kilograms" },
  { symbol: "a", meaning: "acceleration in m/s^2" },
];

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const enter = ramp(frame, 0, 20);
  const exampleStart = 30 + TERMS.length * 15;
  const typed = Math.floor(ramp(frame, exampleStart, exampleStart + 30) * EXAMPLE.length);

  const rows = TERMS.map((term, i) => {
    const appear = ramp(frame, 30 + i * 15, 42 + i * 15);
    return createElement(
      "div",
      { style: { display: "flex", alignItems: "baseline", gap: 28, opacity: appear } },
      createElement(
        "div",
        { style: { width: 120, textAlign: "right", color: GOLD, fontSize: 48, fontFamily: "var(--font-mono)" } },
        term.symbol,
      ),
      createElement(
        "div",
        { style: { color: MUTED, fontSize: 32, fontFamily: "var(--font-display)" } },
        term.meaning,
      ),
    );
  });

  return createElement(
    AbsoluteFill,
    { style: { background: INK } },
    createElement(
      AbsoluteFill,
      { style: { padding: "36px 80px" } },
      createElement(
        "div",
        { style: { color: GOLD, fontSize: 44, fontWeight: 600, fontFamily: "var(--font-display)" } },
        "Newton's second law",
      ),
    ),
    createElement(
      AbsoluteFill,
      { style: { alignItems: "center", justifyContent: "center", gap: 36 } },
      createElement(
        "div",
        {
          style: {
            color: CREAM,
            fontSize: 96,
            fontFamily: "var(--font-mono)",
            padding: "8px 40px",
            borderBottom: "2px solid var(--color-gold)",
            opacity: enter,
            transform: `translateY(${(1 - enter) * 24}px)`,
          },
        },
        EXPRESSION,
      ),
      createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, ...rows),
      createElement(
        "div",
        {
          style: {
            color: CREAM,
            fontSize: 36,
            fontFamily: "var(--font-mono)",
            padding: "12px 28px",
            border: "1px solid var(--color-gold)",
            opacity: ramp(frame, exampleStart, exampleStart + 6),
          },
        },
        EXAMPLE.slice(0, typed),
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
          opacity: ramp(frame, 120, 135),
        },
      },
      "Force grows with mass and with acceleration.",
    ),
  );
}
