/**
 * Story pacing — "animate" (typewriter text, full canvas animations) or
 * "fast" (text and canvas shown complete at once).
 *
 * Animation also requires a browser that can report motion preferences and
 * a player who has not asked for reduced motion; otherwise text is shown
 * at once regardless of the toggle.
 */

export type Pacing = "animate" | "fast";

const KEY = "lore:pacing";

export function loadPacing(): Pacing {
  try {
    return window.localStorage.getItem(KEY) === "fast" ? "fast" : "animate";
  } catch {
    return "animate";
  }
}

/** The raw stored value, or null when the player never chose (see `initialTextMode`). */
export function loadStoredPacing(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function savePacing(pacing: Pacing): void {
  try {
    window.localStorage.setItem(KEY, pacing);
  } catch {
    // preference is optional
  }
}

/** True when text may be animated (motion allowed and detectable). */
export function motionAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
