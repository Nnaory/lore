/**
 * Typewriter dialog: pure functions for the character reveal and the initial
 * text mode. React state lives in the thin `use-typewriter` hook, not here.
 *
 * Why: the Stage reveals dialog one character per 25 ms in `animate` mode and
 * shows it all at once in `fast` mode. Counts are in Unicode code points so a
 * surrogate pair (emoji, rare CJK) is never cut in half. None of these
 * functions throw; invalid numbers are clamped.
 */

export type TextMode = "fast" | "animate";

export const CHAR_INTERVAL_MS = 25;

/** Number of code points in `text`. */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * How many characters (code points) are visible after `elapsedMs`.
 * `fast` shows everything immediately. Result is an integer in [0, length].
 */
export function revealedCount(elapsedMs: number, length: number, mode: TextMode): number {
  const total = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0;
  if (mode === "fast") return total;
  if (!Number.isFinite(elapsedMs)) return elapsedMs === Infinity ? total : 0;
  const n = Math.floor(Math.max(0, elapsedMs) / CHAR_INTERVAL_MS);
  return Math.min(total, n);
}

/**
 * The first `count` code points of `text`. Never splits a surrogate pair.
 * `count` is clamped to [0, code point length].
 */
export function revealPrefix(text: string, count: number): string {
  if (typeof text !== "string" || !Number.isFinite(count)) {
    return typeof text === "string" && count === Infinity ? text : "";
  }
  const n = Math.floor(count);
  if (n <= 0) return "";
  if (n >= text.length) return text;
  let out = "";
  let i = 0;
  for (const ch of text) {
    if (i >= n) break;
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Initial text mode. An explicit stored choice ("fast" or "animate") wins;
 * otherwise `fast` when the user prefers reduced motion, else `animate`.
 */
export function initialTextMode(stored: string | null, reducedMotion: boolean): TextMode {
  if (stored === "fast" || stored === "animate") return stored;
  return reducedMotion ? "fast" : "animate";
}

export { codePointLength };
