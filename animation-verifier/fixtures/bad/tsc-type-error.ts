// Bad fixture: a number is assigned to a string, tsc reports TS2322 (TSC_2322).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const label: string = frame;
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${label}`,
  );
}
