/**
 * KeyHints — the keyboard cheat line inside the desktop Stage (DESIGN-SYSTEM §4.1).
 *
 * Why: SPACE, F and L work anywhere on the Stage (useStageShortcuts). The
 * canvas also listed `/ ask`; that input is disabled, so the hint is dropped
 * (recorded as a deviation). Desktop only, centered at y 806 in the stage.
 */

import { STAGE_BOXES } from "@/lib/stage/stage-boxes";

const HINTS = [
  ["SPACE", "next line"],
  ["F", "fast/animate"],
  ["L", "log chat"],
] as const;

export function KeyHints() {
  const box = STAGE_BOXES.desktop.keyHints;
  return (
    <p
      data-testid="key-hints"
      className="font-mono text-muted"
      style={{
        position: "absolute",
        left: 0,
        top: box.y,
        width: box.width,
        margin: 0,
        textAlign: "center",
        fontSize: 12,
        zIndex: 15,
      }}
    >
      <span className="bg-ink px-3 py-1">
        {HINTS.map(([key, label], i) => (
          <span key={key}>
            {i > 0 && " · "}
            <span className="text-cream">{key}</span> {label}
          </span>
        ))}
      </span>
    </p>
  );
}
