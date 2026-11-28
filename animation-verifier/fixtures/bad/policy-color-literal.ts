// Bad fixture: a hex colour instead of var(--color-<token>) from the Kit palette (POLICY_COLOR_LITERAL).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "#1a1a2e", color: "var(--color-cream)" } },
    `Frame ${frame}`,
  );
}
