// Bad fixture: constructor access is a classic sandbox escape, even when the key is built from pieces
// (POLICY_FORBIDDEN_PROPERTY).
import { createElement } from "react";
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  const reach = (useCurrentFrame as unknown as Record<string, unknown>)["con" + "structor"];
  return createElement(
    AbsoluteFill,
    { style: { background: "var(--color-ink)", color: "var(--color-cream)" } },
    `Frame ${frame} ${typeof reach}`,
  );
}
