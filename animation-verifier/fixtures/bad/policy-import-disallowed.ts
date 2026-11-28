// Bad fixture: import from a module that is not react or remotion (POLICY_IMPORT_DISALLOWED).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { gsap } from "gsap";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame} ${typeof gsap}`,
  );
}
