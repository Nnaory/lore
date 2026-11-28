// Bad fixture: Main throws from frame 11 on, the render step reports the failing frames (RENDER_EXCEPTION).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  if (frame > 10) throw new Error("late failure");
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame}`,
  );
}
