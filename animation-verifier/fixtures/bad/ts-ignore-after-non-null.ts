// Bad fixture: a suppression directive comment that follows a non-null assertion and a division on the same
// line. A naive scanner reads the slash after the assertion as the start of a regular expression and misses
// the comment; the directive must still be seen (TSC_SUPPRESSION_DIRECTIVE).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const a: number | undefined = frame + 2;
  const half = a! / 2; // @ts-ignore
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame} half ${half}`,
  );
}
