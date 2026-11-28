// Bad fixture: a render counter that lives in a module-level object and is bumped through a parameter, so
// the same frame renders differently the second time (RENDER_NONDETERMINISTIC). ESLINT_LORE_NO_MODULE_STATE
// does not see the mutation, only the double render pass does.
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

const COUNTER = { renders: 0 };

function tick(counter: { renders: number }): number {
  counter.renders += 1;
  return counter.renders;
}

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const renders = tick(COUNTER);
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame} render ${renders}`,
  );
}
