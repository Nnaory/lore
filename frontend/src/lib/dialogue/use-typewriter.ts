/**
 * use-typewriter.ts — thin React hook over `typewriter.ts`.
 *
 * Why: the Stage dialog reveals one character per 25 ms in `animate` mode and
 * shows everything at once in `fast` mode. This hook only keeps the elapsed
 * time in state; counting and slicing come from the pure functions. State is
 * tagged with the text it belongs to, so a new line starts from zero without
 * a synchronous setState in an effect. `skip()` shows the full line at once.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CHAR_INTERVAL_MS,
  codePointLength,
  revealPrefix,
  revealedCount,
  type TextMode,
} from "./typewriter";

interface Progress {
  readonly text: string;
  readonly elapsedMs: number;
}

export interface TypewriterState {
  /** The visible part of the text. */
  readonly visible: string;
  /** Number of visible code points. */
  readonly count: number;
  /** True when the whole text is visible. */
  readonly done: boolean;
  /** Show the full line immediately. */
  readonly skip: () => void;
}

export function useTypewriter(text: string, mode: TextMode): TypewriterState {
  const [progress, setProgress] = useState<Progress>({ text, elapsedMs: 0 });
  const length = codePointLength(text);
  const elapsedMs = progress.text === text ? progress.elapsedMs : 0;
  const count = revealedCount(elapsedMs, length, mode);
  const done = count >= length;

  useEffect(() => {
    if (mode !== "animate" || done) return;
    const startedAt = Date.now() - elapsedMs;
    const id = setInterval(() => {
      setProgress({ text, elapsedMs: Date.now() - startedAt });
    }, CHAR_INTERVAL_MS);
    return () => clearInterval(id);
    // elapsedMs is read only to resume; restarting on each tick is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mode, done]);

  const skip = useCallback(() => {
    setProgress({ text, elapsedMs: Number.POSITIVE_INFINITY });
  }, [text]);

  return { visible: revealPrefix(text, count), count, done, skip };
}
