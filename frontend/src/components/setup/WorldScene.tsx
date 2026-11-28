/**
 * WorldScene: Hazel at her cauldron, the picture of the "Building your world" screen
 *
 * Why: while the story is built the player watches Hazel stir. Everything is ASCII from the
 * generators in `lib/ascii` (`renderCharacter("hazel")`, `cauldron`, `pumpkin`) drawn with
 * `AsciiArt`; nothing is pasted or hand-drawn. The cauldron moves (steam, bubbles, ladle, fire)
 * by a frame counter, and the concept names found so far are tossed into it one by one
 * (`tossAt`). With reduced motion the frame never advances and no word is tossed, so the scene
 * is a still picture. Decorative: the figures carry labels, the words are `aria-hidden`.
 *
 * Cell sizes are fixed per layout (desktop 8/6 px, phone 6/4.5 px for Hazel and the pot),
 * chosen from the canvas reference of the screen; the container only places them.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { AsciiArt } from "@/components/ascii/AsciiArt";
import { cauldron, pumpkin, renderCharacter, type Expression } from "@/lib/ascii";
import { tossAt } from "@/lib/generation/world-scene";
import { motionAllowed } from "@/lib/story/pacing";
import { useStageLayout } from "@/lib/stage/use-board-metrics";

const FRAME_MS = 260;

const SIZES = {
  desktop: { hazel: 8, pot: 6, pumpkinBig: 5, pumpkinSmall: 4 },
  phone: { hazel: 6, pot: 4.5, pumpkinBig: 3.5, pumpkinSmall: 2.6 },
} as const;

type WorldSceneProps = {
  expression: Expression;
  /** Concept names to toss into the pot, in the order they were found. */
  words: string[];
};

const MAX_WORD_CHARS = 20;

export function WorldScene({ expression, words }: WorldSceneProps) {
  const layout = useStageLayout();
  const size = SIZES[layout];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    // Read in the effect: matchMedia is not there on the server.
    if (!motionAllowed()) return;
    const id = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const hazel = useMemo(() => renderCharacter("hazel", expression), [expression]);
  const pot = cauldron(frame);
  const bigPumpkin = useMemo(() => pumpkin(14, 3), []);
  const smallPumpkin = useMemo(() => pumpkin(10, 11), []);

  const toss = motionAllowed() ? tossAt(frame, words.length) : null;
  const word = toss ? words[toss.word] : undefined;

  return (
    <div data-testid="world-scene" className="relative h-full min-h-[300px] w-full overflow-hidden">
      <div aria-hidden="true" className="absolute left-0 top-6">
        <AsciiArt layers={bigPumpkin} fontPx={size.pumpkinBig} />
      </div>
      <div aria-hidden="true" className="absolute right-[18%] top-[18%]">
        <AsciiArt layers={smallPumpkin} fontPx={size.pumpkinSmall} />
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-end justify-center gap-[5%] px-2">
        <figure data-testid="world-hazel" data-expression={expression} className="m-0 shrink-0">
          <AsciiArt layers={hazel} fontPx={size.hazel} label={`Hazel, ${expression}`} />
        </figure>
        <figure data-testid="world-cauldron" data-frame={frame % 8} className="m-0 shrink-0 pb-1">
          <AsciiArt layers={pot} fontPx={size.pot} label="A bubbling cauldron" />
        </figure>
      </div>

      {toss && word && (
        <span
          aria-hidden="true"
          data-testid="world-toss"
          className="pointer-events-none absolute whitespace-nowrap font-mono text-[12px] font-bold text-candle md:text-[13px]"
          style={{ left: `${8 + 52 * toss.x}%`, top: `${8 + 56 * toss.y}%`, opacity: 1 - toss.x * 0.35 }}
        >
          ( {word.length > MAX_WORD_CHARS ? `${word.slice(0, MAX_WORD_CHARS - 1)}…` : word} )
        </span>
      )}
    </div>
  );
}
