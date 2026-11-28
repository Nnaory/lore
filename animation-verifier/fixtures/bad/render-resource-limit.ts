// Bad fixture: Main keeps allocating 8 MB arrays until the Worker heap is gone (RENDER_RESOURCE_LIMIT).
// The Worker is killed, the verifier process survives.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const keep: number[][] = [];
  while (frame >= 0) {
    keep.push(new Array<number>(1_000_000).fill(frame + 0.5));
  }
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame} kept ${keep.length}`,
  );
}
