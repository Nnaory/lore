// Bad fixture: event handler attributes (^on[A-Z]) are not allowed, the animation has no interaction
// (POLICY_FORBIDDEN_ATTRIBUTE).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    createElement("div", { onClick: () => undefined }, `Frame ${frame}`),
  );
}
