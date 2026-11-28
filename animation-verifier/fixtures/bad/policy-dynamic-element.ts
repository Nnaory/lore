// Bad fixture: the createElement type is computed at runtime, so the verifier cannot tell which element is
// built (POLICY_DYNAMIC_ELEMENT). A string literal, a const holding a string literal, Fragment or an allowed
// component is required instead.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const tag = frame > 10 ? "div" : "span";
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    createElement(tag, null, `Frame ${frame}`),
  );
}
