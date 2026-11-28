// Bad fixture: @ts-ignore hides a type error instead of fixing it, suppression comments are not allowed
// (TSC_SUPPRESSION_DIRECTIVE).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  // @ts-ignore
  const label: string = frame;
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${label}`,
  );
}
