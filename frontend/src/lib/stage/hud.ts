/**
 * hud.ts — presentation of the HP indicator in the Stage HUD.
 *
 * Why: the HUD draws five squares and an `n/5` label. This only turns an HP
 * number into squares; it does not decide HP changes or failure (those live in
 * lib/game). The count is a display constant, not a game rule.
 */

/** Number of squares drawn in the HUD. */
export const HUD_HP_SQUARES = 5;

export type HpSquares =
  | {
      ok: true;
      /** Clamped integer HP shown. */
      value: number;
      total: number;
      /** true = filled (ember), false = empty (smoke). */
      squares: readonly boolean[];
      /** e.g. `4/5`. */
      label: string;
    }
  | { ok: false; reason: "invalid_hp" };

export function hpSquares(hp: number): HpSquares {
  if (typeof hp !== "number" || !Number.isFinite(hp)) {
    return { ok: false, reason: "invalid_hp" };
  }
  const value = Math.min(HUD_HP_SQUARES, Math.max(0, Math.floor(hp)));
  const squares = Array.from({ length: HUD_HP_SQUARES }, (_, i) => i < value);
  return { ok: true, value, total: HUD_HP_SQUARES, squares, label: `${value}/${HUD_HP_SQUARES}` };
}
