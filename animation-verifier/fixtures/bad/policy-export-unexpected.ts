// Bad fixture: only `meta` and the default export may be exported, `palette` is an extra export
// (POLICY_EXPORT_UNEXPECTED).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export const palette = ["var(--color-ink)", "var(--color-cream)"];

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: palette[0], color: palette[1] } },
    `Frame ${frame}`,
  );
}
