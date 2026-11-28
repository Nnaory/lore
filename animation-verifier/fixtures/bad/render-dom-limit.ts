// Bad fixture: 700 <span> elements, over the 600 element limit of one frame (RENDER_DOM_LIMIT).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

const DOTS = Array.from({ length: 700 }, (_, index) => index % 10);

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    createElement("div", null, `Frame ${frame}`),
    createElement("div", null, ...DOTS.map((digit) => createElement("span", null, String(digit)))),
  );
}
