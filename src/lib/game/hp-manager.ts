/**
 * HP Manager
 *
 * Pure, deterministic HP logic for a single story run.
 * The game engine is the sole authority for HP changes.
 * No component may compute HP independently.
 *
 * Rules (from DOCS.md §9):
 *   - Initial HP per story: 5.
 *   - Incorrect answer: HP - 1.
 *   - Correct answer: HP unchanged.
 *   - HP minimum: 0 (cannot go negative).
 *   - HP maximum: MAX_HP (cannot exceed initial value).
 *   - HP = 0 means the story has failed.
 */

/** The maximum (and initial) HP value for every story. */
export const MAX_HP = 5;

/** The HP value that triggers story failure. */
export const FAILURE_HP = 0;

/**
 * Deducts exactly 1 HP from the current value.
 * HP is clamped to a minimum of 0 — it cannot go negative.
 *
 * @returns The new HP value after deduction.
 */
export function deductHp(currentHp: number): number {
  return Math.max(FAILURE_HP, currentHp - 1);
}

/**
 * Returns true if the given HP value represents a story failure.
 * Failure occurs when HP reaches 0.
 */
export function isStoryFailed(hp: number): boolean {
  return hp <= FAILURE_HP;
}

/**
 * Returns the initial HP for a new (or retried) story run.
 */
export function initialHp(): number {
  return MAX_HP;
}

/**
 * Validates that an HP value is within the legal range [0, MAX_HP].
 * Returns a clamped value if it is outside the range.
 *
 * Used when loading persisted state from external sources.
 */
export function clampHp(hp: number): number {
  return Math.min(MAX_HP, Math.max(FAILURE_HP, hp));
}
