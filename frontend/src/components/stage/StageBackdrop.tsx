/**
 * StageBackdrop — grid and jack-o'-lanterns behind the Stage board.
 *
 * Why: DESIGN-SYSTEM §4.1 puts `.lore-grid-bg` plus `PUMPKINS_STAGE_DESKTOP`
 * behind the 1440x900 desktop board. The phone board gets the grid plus
 * `PUMPKINS_STAGE_PHONE` (§4.2). Decorative, so aria-hidden.
 */

"use client";

import {
  PumpkinField,
  PUMPKINS_STAGE_DESKTOP,
  PUMPKINS_STAGE_PHONE,
} from "@/components/ascii/PumpkinField";
import type { StageLayout } from "@/lib/stage/board-scale";

export function StageBackdrop({ layout }: { layout: StageLayout }) {
  return (
    <div
      data-testid="stage-backdrop"
      aria-hidden="true"
      className="lore-grid-bg"
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    >
      <PumpkinField items={layout === "desktop" ? PUMPKINS_STAGE_DESKTOP : PUMPKINS_STAGE_PHONE} />
    </div>
  );
}
