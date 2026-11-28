// Bad fixture: Main pushes into a module-level array, so the output depends on how often it ran, not on the
// frame alone (ESLINT_LORE_NO_MODULE_STATE).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

const seen: number[] = [];

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  seen.push(frame);
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame} after ${seen.length} renders`,
  );
}
