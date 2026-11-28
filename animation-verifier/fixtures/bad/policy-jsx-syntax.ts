// Bad fixture: JSX syntax. Main_File must build every element with createElement (POLICY_JSX_SYNTAX).
import type { ReactElement } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export const meta = { width: 1280, height: 720, fps: 30, durationInFrames: 60 };

export default function Main(): ReactElement {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: "var(--color-ink)", color: "var(--color-cream)" }}>
      Frame {frame}
    </AbsoluteFill>
  );
}
