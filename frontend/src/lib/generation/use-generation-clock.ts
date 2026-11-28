/**
 * useGenerationClock: the timer of the "Building your world" screen
 *
 * Counts whole seconds while the run is working and holds still while it waits for the player
 * or has failed, so the clock shows time spent building, not time spent deciding. It keeps two
 * numbers: the total, and the seconds of the current stage (reset when the stage changes).
 * Plain interval, no refs read during render; the stage change is detected inside the tick.
 */

"use client";

import { useEffect, useState } from "react";
import type { GenerationStage } from "./generation";

type Clock = { stage: GenerationStage; total: number; stageSeconds: number };

export function useGenerationClock(stage: GenerationStage, running: boolean): { total: number; stageSeconds: number } {
  const [clock, setClock] = useState<Clock>({ stage, total: 0, stageSeconds: 0 });

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setClock((c) =>
        c.stage === stage
          ? { stage, total: c.total + 1, stageSeconds: c.stageSeconds + 1 }
          : { stage, total: c.total + 1, stageSeconds: 1 }
      );
    }, 1000);
    return () => clearInterval(id);
  }, [stage, running]);

  return { total: clock.total, stageSeconds: clock.stage === stage ? clock.stageSeconds : 0 };
}
