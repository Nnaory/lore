/**
 * use-canvas-playback.ts — thin hook that reads a Remotion player for the PlayerBar.
 *
 * Why: the PlayerBar needs a progress fill, a `m:ss` clock and a playing flag.
 * The hook holds the `PlayerRef` (pass `playerRef` as the Player `ref`),
 * listens to `frameupdate`, `play`, `pause` and `ended`, and converts frames
 * with `progressPercent` / `formatClock`. No game rules here.
 */

"use client";

import type { PlayerRef } from "@remotion/player";
import { useEffect, useState } from "react";
import { formatClock, progressPercent } from "./playback";

export interface CanvasPlayback {
  /** Callback ref: pass to `<Player ref={playerRef} />`. */
  readonly playerRef: (player: PlayerRef | null) => void;
  /** 0..100 */
  readonly progress: number;
  /** `m:ss` of the current position. */
  readonly time: string;
  readonly playing: boolean;
  readonly ended: boolean;
}

export function useCanvasPlayback(totalFrames: number, fps: number): CanvasPlayback {
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    const onPlay = () => {
      setPlaying(true);
      setEnded(false);
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setEnded(true);
    };
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onEnded);
    };
  }, [player]);

  const pct = progressPercent(frame, totalFrames);
  const clock = formatClock(fps > 0 ? frame / fps : 0);

  return {
    playerRef: setPlayer,
    progress: pct.ok ? pct.percent : 0,
    time: clock.ok ? clock.text : "0:00",
    playing,
    ended,
  };
}
