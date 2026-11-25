/**
 * Jack-o'-lanterns: small background pumpkins + the big "mouth" pumpkin of Home option A.
 */
import { CANDLE, GOLD, ORANGE, grid, layers, rng, type Grid, type Layer } from './core';

export interface MouthOptions {
  /** Mouth top, as a fraction of the vertical radius below centre (can be negative). */
  top: number;
  /** Mouth height in rows (teeth included). */
  rows: number;
  /** Mouth width as a fraction of the pumpkin width. */
  w: number;
  /** Tooth width in cells. */
  tooth: number;
  /** Tooth depth in rows. */
  teeth: number;
}

export interface JackMouth {
  C: number;
  R: number;
  /** Mouth hole in cells: columns [c0, c1), rows [r0, r1). Place the input exactly here. */
  mouth: { c0: number; c1: number; r0: number; r1: number };
  layers: Layer[];
}

/** Background pumpkin. `w` = body width in cells. */
export function pumpkin(w: number, seed: number): Layer[] {
  const rnd = rng(seed), R = Math.round(w * 0.42) + 3, C = w + 6, g: Grid = grid(C, R), cx = C / 2, cy = R / 2 + 1.2, rx = w / 2, ry = (R - 4) / 2;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const dx = (c + 0.5 - cx) / rx, dy = (r + 0.5 - cy) / ry, d = Math.hypot(dx, dy);
    if (d < 1) { const rib = Math.abs(Math.sin(dx * Math.PI * 2.2)); g[r][c] = rib < 0.18 ? 'pr' : 'pb'; }
    else if (d < 1.35 && (c + r) % 2 === 0 && rnd() > 0.35) g[r][c] = 'h'; }
  // stem
  for (let r = 0; r < Math.max(2, Math.round(cy - ry)); r++) { const c = Math.floor(cx + (r === 0 ? 1 : 0)); g[r][c] = 'st'; }
  // face: triangle eyes + zigzag mouth
  const eyeR = Math.round(cy - ry * 0.25), ew = Math.max(2, Math.round(w * 0.09));
  ([-1, 1] as const).forEach((s) => { const ec = Math.round(cx + s * w * 0.2); for (let i = 0; i < Math.max(2, Math.round(ew / 1.5)); i++) for (let k = -ew + i; k <= ew - i; k++) { const rr = eyeR - Math.max(2, Math.round(ew / 1.5)) + 1 + i; if (g[rr]) g[rr][ec + k] = 'f'; } });
  const mr = Math.round(cy + ry * 0.35), mw = Math.round(w * 0.3);
  for (let k = -mw; k <= mw; k++) { const c = Math.round(cx + k); g[mr][c] = 'f'; if (Math.abs(k) % 4 < 2 && Math.abs(k) < mw - 1) { if (g[mr + 1]) g[mr + 1][c] = 'f'; } else if (g[mr - 1] && Math.abs(k) < mw) g[mr - 1][c] = 'f'; }
  return layers(g, {
    pb: { ch: '▓', color: ORANGE, op: 0.92 }, pr: { ch: '▒', color: ORANGE, op: 0.5 }, f: { ch: '█', color: CANDLE, op: 1 }, st: { ch: '▌', color: GOLD, op: 0.8 }, h: { ch: '·', color: ORANGE, op: 0.35 }
  });
}

/** Big pumpkin whose mouth is a rectangular hole; an <input> sits behind the hole. */
export function jackMouth(w: number, o: MouthOptions): JackMouth {
  const C = w + 4, R = Math.round(w * 0.42) + 4, g: Grid = grid(C, R), cx = C / 2, cy = R / 2 + 1.5, rx = w / 2, ry = (R - 5) / 2;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const dx = (c + 0.5 - cx) / rx, dy = (r + 0.5 - cy) / ry, d = Math.hypot(dx, dy);
    if (d < 1) g[r][c] = (Math.abs(Math.sin(dx * Math.PI * 2.2)) < 0.13 || d > 0.965) ? 'pr' : 'pb'; }
  const top = Math.round(cy - ry);
  for (let r = 0; r < top + 1; r++) for (let k = 0; k < 3; k++) { const c = Math.round(cx + k - 1 + (top - r) * 0.35); if (g[r] && c < C) g[r][c] = 'st'; }
  const eh = Math.round(ry * 0.3), er0 = Math.round(cy - ry * 0.7), ew = w * 0.085;
  ([-1, 1] as const).forEach((s) => { const ec = cx + s * w * 0.19; for (let i = 0; i <= eh; i++) { const hw = (i / eh) * ew; for (let c = Math.round(ec - hw / 0.6 * 0.6); c <= Math.round(ec + hw); c++) if (Math.abs(c + 0.5 - ec) <= hw) g[er0 + i][c] = 'eg'; } });
  const nh = Math.max(2, Math.round(eh * 0.35)), nr0 = Math.round(cy - ry * 0.3);
  for (let i = 0; i <= nh; i++) for (let c = 0; c < C; c++) if (Math.abs(c + 0.5 - cx) <= i * 0.9) g[nr0 + i][c] = 'eg';
  const mr0 = Math.round(cy + ry * o.top), mr1 = mr0 + o.rows, mc0 = Math.round(cx - w * o.w / 2), mc1 = Math.round(cx + w * o.w / 2);
  for (let r = mr0; r < mr1; r++) for (let c = mc0; c < mc1; c++) g[r][c] = null;
  for (let c = mc0; c < mc1; c++) { g[mr0 - 1][c] = 'pr'; g[mr1][c] = 'pr'; }
  const tw = o.tooth, gap = o.tooth * 2;
  for (let c = mc0 + gap; c + tw < mc1 - 2; c += tw + gap) for (let k = 0; k < tw; k++) for (let i = 0; i < o.teeth; i++) { if (k >= i && k < tw - i) g[mr0 + i][c + k] = 'pb'; }
  for (let c = mc0 + Math.round(gap * 1.5) + tw; c + tw < mc1 - 2; c += tw + gap) for (let k = 0; k < tw; k++) for (let i = 0; i < o.teeth; i++) { if (k >= i && k < tw - i) g[mr1 - 1 - i][c + k] = 'pb'; }
  return { C: C, R: R, mouth: { c0: mc0, c1: mc1, r0: mr0, r1: mr1 }, layers: layers(g, {
    pb: { ch: '▓', color: ORANGE, op: 0.95 }, pr: { ch: '▒', color: ORANGE, op: 0.55 }, eg: { ch: '█', color: CANDLE, op: 1 }, st: { ch: '▌', color: GOLD, op: 0.85 } }) };
}

export const MOUTH_PRESETS = {
  desktop: { w: 130, fontPx: 9, opts: { top: 0.02, rows: 11, w: 0.64, tooth: 6, teeth: 2 } },
  phone: { w: 112, fontPx: 5, opts: { top: -0.06, rows: 14, w: 0.76, tooth: 5, teeth: 2 } },
} as const;
