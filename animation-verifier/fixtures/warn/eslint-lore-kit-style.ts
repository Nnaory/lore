// Warn fixture: a rounded corner is outside the Kit style, which only warns, the file still passes
// (ESLINT_LORE_KIT_STYLE, ok true).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    createElement("div", { style: { borderRadius: 8, padding: 24 } }, `Frame ${frame}`),
  );
}
