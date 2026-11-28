// Warn fixture: a puzzle whose companion lists "Option A" as both required and forbidden. The verifier drops
// the forbidden copy and warns (FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED, ok true). The other forbidden token,
// "forty-two", is revealed only after the pause at frame 30, so it never shows on or before that frame.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60, pauseAtFrame: 30 };

const PAUSE = 30;

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    createElement("div", null, "Which number completes the sequence?"),
    createElement("div", null, "Option A"),
    frame > PAUSE ? createElement("div", null, "The answer is forty-two") : null,
  );
}
