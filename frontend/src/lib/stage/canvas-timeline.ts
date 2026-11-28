/**
 * canvas-timeline.ts: which scene the PlayerBar follows, and what it draws, while the Stage canvas
 * holds an animation scene (design 7.6, Requirements 30.7, 30.8, 30.14, 31.3, 31.14).
 *
 * Why it exists. An `animation` scene is two scenes in one: the sandboxed animation, and the
 * Fallback_Scene (the JSON visual the Stage would draw without a reference). `StageCanvas` has to
 * say which one is on screen (`data-canvas-kind`), and `CanvasPane` has to give the PlayerBar the
 * matching length and pause marker. Both read the same rule, so it lives here once, without React,
 * and the two components only forward their status to it. Nothing here touches HP, score or
 * `isCorrect`.
 *
 * The rule: the animation is "shown" only while its status is `playing` or `paused` (the iframe is
 * on screen, `AnimationScene` reports those two only then). In every other status (`loading`,
 * `failed:<phase>`, or no report yet) the Fallback_Scene is what the player sees, so the bar keeps
 * the Fallback_Scene's length and markers and does not jump when the animation arrives or fails.
 *
 * Pure: type-only imports, no clock, no DOM.
 */

import type { AnimationStatus } from "@/lib/animation/scene-status";

/** `data-animation-status` of a canvas: `off` for every scene that is not an animation. */
export type CanvasAnimationStatus = AnimationStatus | "off";

/** True while the animation's iframe is on screen (and so the Fallback_Scene is not). */
export function iframeShown(status: CanvasAnimationStatus): boolean {
  return status === "playing" || status === "paused";
}

/**
 * Status of the current animation scene, from the last one reported.
 *
 * `reported` carries the key of the scene that reported it. A report that belongs to another
 * scene (the previous one, before the new `AnimationScene` has mounted and said `loading`) is not
 * believed: the new scene starts at `loading` (Requirement 31.10), so a stale `paused` can never
 * make the bar follow an iframe that does not exist yet.
 */
export function statusForScene(
  reported: { readonly key: string; readonly value: AnimationStatus } | null,
  key: string,
): AnimationStatus {
  return reported !== null && reported.key === key ? reported.value : "loading";
}

/**
 * Whether an animation scene must be mounted afresh when its page is shown again after `<Activity>`
 * hid it (`useOnReveal`). Hiding disposes the sandbox controller but leaves the iframe running, and
 * a new controller never gets the `ready` it waits for, so any scene that has not failed would end
 * in `failed:timeout` 8 s later. A new mount loads again (the verified bundle comes from the
 * loader's cache) and brings the iframe up cleanly. A scene that already failed shows the
 * Fallback_Scene and has no iframe: it stays as it is and does not try again by itself
 * (Requirement 31.6). A scene that is not an animation has nothing to remount.
 */
export function shouldRemountOnReveal(status: CanvasAnimationStatus): boolean {
  return status === "loading" || status === "playing" || status === "paused";
}

/**
 * Pause marker of the PlayerBar for a shown animation: `[pause_at_frame / duration * 100]`, or `[]`
 * for a lesson (no `pause_at_frame`) and for numbers that cannot make a marker.
 */
export function pauseKeyframes(durationInFrames: number, pauseAtFrame: number | undefined): number[] {
  if (pauseAtFrame === undefined) return [];
  if (!Number.isFinite(pauseAtFrame) || !Number.isFinite(durationInFrames) || durationInFrames <= 0) return [];
  return [(pauseAtFrame / durationInFrames) * 100];
}

/**
 * Pause marker of a Remotion scene: a puzzle beat (`puzzle`, `decision`) has one at the end of the
 * bar, every other kind has none. This is what `CanvasPane` always drew before animations existed.
 */
export function sceneKeyframes(kind: string): number[] {
  return kind === "puzzle" || kind === "decision" ? [100] : [];
}
