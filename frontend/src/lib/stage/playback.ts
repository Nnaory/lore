/**
 * playback.ts — display math for the CanvasFrame player bar.
 *
 * Why: the bar shows a progress fill, a `m:ss` clock and a snake_case label.
 * These are pure so the Remotion hook only forwards frame numbers.
 * No HP or game rules.
 */

export type PlaybackFailure = { ok: false; reason: "invalid_input" };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Percentage 0..100 of `frame` within `totalFrames`, clamped. */
export function progressPercent(
  frame: number,
  totalFrames: number,
): { ok: true; percent: number } | PlaybackFailure {
  if (!isFiniteNumber(frame) || !isFiniteNumber(totalFrames) || totalFrames <= 0) {
    return { ok: false, reason: "invalid_input" };
  }
  const percent = Math.min(100, Math.max(0, (frame / totalFrames) * 100));
  return { ok: true, percent };
}

/** `m:ss` for a number of seconds (floored, negatives become 0:00). */
export function formatClock(seconds: number): { ok: true; text: string } | PlaybackFailure {
  if (!isFiniteNumber(seconds)) return { ok: false, reason: "invalid_input" };
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return { ok: true, text: `${m}:${String(s).padStart(2, "0")}` };
}

export const CANVAS_LABEL_MAX = 24;
const CANVAS_LABEL_FALLBACK = "scene";

/**
 * snake_case label matching `^[a-z0-9_]{1,24}$`. Diacritics are stripped,
 * other characters become `_`. Empty results fall back to `scene`.
 */
export function canvasLabel(source: string): { ok: true; label: string } | PlaybackFailure {
  if (typeof source !== "string") return { ok: false, reason: "invalid_input" };
  const label = source
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, CANVAS_LABEL_MAX)
    .replace(/_+$/, "");
  return { ok: true, label: label.length > 0 ? label : CANVAS_LABEL_FALLBACK };
}
