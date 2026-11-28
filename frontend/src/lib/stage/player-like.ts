/**
 * player-like.ts: the part of a player that the Stage reads and drives (design 7.6, D-16,
 * Requirement 30.3).
 *
 * `useCanvasPlayback` and `CanvasPane` used to name Remotion's `PlayerRef`, but they only listen
 * to four events and call `play`, `pause` and `seekTo`. An animation runs in a sandboxed iframe
 * and has no `PlayerRef`, so the Stage is typed against this smaller structural type instead. The
 * Remotion `PlayerRef` still fits it (checked by `tsc`, see `tests/animation/sandbox-player-ref
 * .test.ts`), and so does the `SandboxPlayerRef` adaptor. That keeps one PlayerBar and one
 * progress/clock path for both kinds of scene.
 *
 * The event payload follows Remotion: `frameupdate` carries `{ frame }` and the other three carry
 * no `detail` (`undefined`). It is declared per event name because one shared `{ detail: { frame } }`
 * type does not accept `PlayerRef`: its `play`, `pause` and `ended` listeners receive no frame, and
 * `tsc` rejects the assignment (a listener parameter is checked strictly even when the enclosing
 * method is not). Methods use method syntax like Remotion's own class, so the generic
 * `addEventListener<Q>` lines up; do not rewrite them as property arrows.
 *
 * Type-only module: no imports, nothing at run time.
 */

/** The four events the Stage listens to. */
export type PlayerEventName = "frameupdate" | "play" | "pause" | "ended";

/** `detail` of each event, as Remotion's player emits it. */
export interface PlayerEventDetail {
  frameupdate: { frame: number };
  play: undefined;
  pause: undefined;
  ended: undefined;
}

/** A listener for event `Q`; with no argument it accepts any of the four. */
export type PlayerEventListener<Q extends PlayerEventName = PlayerEventName> = (e: {
  detail: PlayerEventDetail[Q];
}) => void;

export interface PlayerLike {
  addEventListener<Q extends PlayerEventName>(name: Q, cb: PlayerEventListener<Q>): void;
  removeEventListener<Q extends PlayerEventName>(name: Q, cb: PlayerEventListener<Q>): void;
  play(): void;
  pause(): void;
  seekTo(frame: number): void;
}
