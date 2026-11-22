/**
 * StageScene — the ASCII scene drawn behind everything on the Stage panel.
 *
 * Why: DESIGN-SYSTEM §4.1/§4.2 paint the stage with `renderScene` at opacity
 * 0.85 (167x57 cells at 12 px on desktop, 82x99 cells at 8 px on phone, the
 * phone one starting under the HUD and clipped by the board). Per OQ-12 this
 * scene is also what a beat without a lesson, visual or puzzle shows (the old
 * "ambient" canvas). Decorative, so the art is aria-hidden; the wrapper keeps
 * `data-testid="stage-scene"` for tests. The seed comes from the story id so
 * the same story always draws the same sky.
 */

"use client";

import { useMemo } from "react";
import { AsciiArt } from "@/components/ascii/AsciiArt";
import { renderScene } from "@/lib/ascii";
import type { StageLayout } from "@/lib/stage/board-scale";
import { STAGE_BOXES } from "@/lib/stage/stage-boxes";
import { useBoardPixelRatio } from "./ScaledBoard";

const SCENE_LAYOUT = { desktop: "stageDesktop", phone: "stagePhone" } as const;

export function StageScene({ layout, seed }: { layout: StageLayout; seed: number }) {
  const box = STAGE_BOXES[layout].scene;
  const pixelRatio = useBoardPixelRatio();
  // Recipe seeds are 1..9999.
  const recipeSeed = Math.min(9999, Math.max(1, Math.floor(seed) || 1));
  const layers = useMemo(
    () => renderScene({ biome: "city_gate", seed: recipeSeed }, SCENE_LAYOUT[layout]),
    [recipeSeed, layout],
  );
  return (
    <div
      data-testid="stage-scene"
      aria-hidden="true"
      style={{ position: "absolute", left: box.x, top: box.y, opacity: 0.85, pointerEvents: "none" }}
    >
      <AsciiArt layers={layers} fontPx={box.fontPx} pixelRatio={pixelRatio} />
    </div>
  );
}
