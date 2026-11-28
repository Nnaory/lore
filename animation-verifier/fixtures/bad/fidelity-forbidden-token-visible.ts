// Bad fixture: a puzzle that pauses at frame 30, but the answer "forty-two" is on screen from frame 0, so the
// player can read it before answering (FIDELITY_FORBIDDEN_TOKEN_VISIBLE). The question is shown as required.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60, pauseAtFrame: 30 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    createElement("div", null, "Which number completes the sequence?"),
    createElement("div", null, "The answer is forty-two"),
    createElement("div", null, `Frame ${frame}`),
  );
}
