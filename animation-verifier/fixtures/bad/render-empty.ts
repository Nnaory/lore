// Bad fixture: the last frame draws a shape but no text at all, so there is nothing to read
// (RENDER_EMPTY).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)" } },
    createElement(
      "svg",
      { width: 1280, height: 720, viewBox: "0 0 1280 720" },
      createElement("rect", { x: 100, y: 100, width: 100 + frame * 4, height: 300, fill: "var(--color-gold)" }),
    ),
  );
}
