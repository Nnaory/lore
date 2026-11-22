/**
 * PumpkinBackdrop — the ASCII Halloween night behind every page.
 *
 * Rendered once by the root layout, which Next.js keeps mounted while the
 * player moves between pages, so the engine and its canvas live as long as the
 * tab: nothing restarts on navigation, and what happens inside a page (opening
 * a panel, say) cannot touch the background.
 *
 * Pages must not paint a background of their own, or they hide it.
 *
 * Clicking the open sky (anywhere that is not a control or a glass panel)
 * startles the pumpkins near the click.
 */

"use client";

import { useEffect, useRef } from "react";
import { AsciiFieldEngine } from "@/lib/ascii-field/engine";
import { HALLOWEEN_NIGHT, pumpkins, type Pumpkin } from "@/lib/ascii-field/pumpkins";

/** What a click must NOT land on to count as a click on the sky. */
const NOT_SKY = "a, button, input, textarea, select, label, summary, [role='button']";

function isSky(target: EventTarget | null) {
  return target instanceof Element && !target.closest(NOT_SKY);
}

function startEngine(canvas: HTMLCanvasElement): AsciiFieldEngine<Pumpkin> | null {
  try {
    return new AsciiFieldEngine(canvas, pumpkins, HALLOWEEN_NIGHT, { startleOn: isSky });
  } catch {
    return null; // no 2D canvas (tests, very old browsers): the plain dark backdrop stays
  }
}

export function PumpkinBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = startEngine(canvas);
    return () => engine?.destroy();
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" data-testid="pumpkin-field" className="lore-ascii-field" />;
}
