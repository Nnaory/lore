// Bad fixture: Main never calls useCurrentFrame() from remotion, so nothing can animate
// (ESLINT_LORE_USES_FRAME).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    "A frozen title",
  );
}
