/**
 * use-canvas-playback.ts — thin hook that reads a player for the PlayerBar.
 *
 * Why: the PlayerBar needs a progress fill, a `m:ss` clock and a playing flag.
 * The hook holds the player (pass `playerRef` as the Remotion Player `ref`, or hand
 * it a `SandboxPlayerRef`), listens to `frameupdate`, `play`, `pause` and `ended`, and
 * converts frames with `progressPercent` / `formatClock`. No game rules here.
 *
 * The player is typed as the structural `PlayerLike` (it only uses those four events),
 * so a Remotion `PlayerRef` and the sandbox adaptor both fit (design 7.6, D-16).
 */

"use client";

import { useEffect, useState } from "react";
import { formatClock, progressPercent } from "./playback";
import type { PlayerLike } from "./player-like";

export interface CanvasPlayback {
  /** Callback ref: pass to `<Player ref={playerRef} />`, or call it with a `PlayerLike`. */
  readonly playerRef: (player: PlayerLike | null) => void;
  /** 0..100 */
  readonly progress: number;
  /** `m:ss` of the current position. */
  readonly time: string;
  readonly playing: boolean;
  readonly ended: boolean;
}

export function useCanvasPlayback(totalFrames: number, fps: number): CanvasPlayback {
  const [player, setPlayer] = useState<PlayerLike | null>(null);
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
