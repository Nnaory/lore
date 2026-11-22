/**
 * PuzzleScope — holds `usePuzzleInteraction` above the layout switch.
 *
 * Why: the selected choice and the last result must survive a desktop <-> phone
 * switch. A hook cannot be called conditionally, so this component calls it
 * only when a puzzle is on screen and hands the interaction to a render
 * function; the Stage tree under it keeps the same element position in both
 * layouts, so React keeps the state. The caller keys it per puzzle scene.
 * Answer rules stay in `usePuzzleInteraction` / `validateMultipleChoice`.
 */

"use client";

import type { ReactNode } from "react";
import {
  usePuzzleInteraction,
  type PuzzleInteractionCallbacks,
} from "@/components/story/use-puzzle-interaction";
import type { Puzzle } from "@/lib/types/puzzle";
import type { PuzzleInteraction } from "./CanvasPane";

type Props = {
  puzzle: Puzzle | undefined;
  callbacks: PuzzleInteractionCallbacks;
  children: (interaction: PuzzleInteraction | null) => ReactNode;
};

function WithInteraction({
  puzzle,
  callbacks,
  children,
}: {
  puzzle: Puzzle;
  callbacks: PuzzleInteractionCallbacks;
  children: Props["children"];
}) {
  const interaction = usePuzzleInteraction(puzzle, callbacks);
  return <>{children(interaction)}</>;
}

export function PuzzleScope({ puzzle, callbacks, children }: Props) {
  if (!puzzle) return <>{children(null)}</>;
  return (
    <WithInteraction puzzle={puzzle} callbacks={callbacks}>
      {children}
    </WithInteraction>
  );
}
