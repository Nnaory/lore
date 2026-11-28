// Bad fixture: url() in a style string would fetch an external resource (POLICY_URL_LITERAL).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return createElement(
    AbsoluteFill,
    {
      style: {
        background: "var(--color-ink)",
        color: "var(--color-cream)",
        backgroundImage: "url(sprite.png)",
      },
    },
    `Frame ${frame}`,
  );
}
