// Bad fixture: the static meta says 60 frames, but a module-level call stretches it to 90 before the bundle
// is evaluated, so the executed meta differs from the one the policy step read (RENDER_META_MISMATCH).
// Steps 1 to 5 cannot see this: the mutation goes through a function parameter.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

function stretch(target: { durationInFrames: number }): void {
  target.durationInFrames = 90;
}

stretch(meta);

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame}`,
  );
}
