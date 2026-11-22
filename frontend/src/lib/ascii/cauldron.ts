/**
 * Hazel's cauldron for the Building World screen: 64 × 26 cells, 4 animation frames.
 * Play frames 0→1→2→3 at 4 fps (250 ms). Golden-tested against the design canvas.
 */
import { CANDLE, CREAM, GOLD, ORANGE, SMOKE, grid, layers, rng, type Grid, type Layer } from './core';

export const CAULDRON_FRAMES = 4;
export const CAULDRON_FRAME_MS = 250;

export function cauldron(frame: number): Layer[] {
  const C = 64, R = 26, A = 0.6, g: Grid = grid(C, R), cx = 19.2, f = ((frame % 4) + 4) % 4, rnd = rng(101 + f * 7);
  const each = (fn: (x: number, y: number, c: number, r: number) => string | null | undefined | void) => { for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const v = fn(c * A + A / 2, r + 0.5, c, r); if (v) g[r][c] = v; } };
  // steam
  each((x, y, c, r) => { if (y > 7.5) return; const drift = Math.sin((y + f * 1.4) * 0.9) * 1.6; const d = Math.abs(x - cx - drift); if (d < 5.5 - y * 0.45 && (c + r + f) % 3 === 0) return y < 3.5 ? 'sm1' : 'sm2'; });
  // pot body
  each((x, y) => { if (y < 9 || y > 20.5) return; const e = Math.hypot((x - cx) / 15.6, (y - 12.5) / 8.2); if (e >= 1) return; if (x < cx - 6 && y > 11 && y < 17.5 && e > 0.74 && e < 0.9) return 'hi'; return 'pot'; });
  // legs
  ([-1, 1] as const).forEach((s) => each((x, y) => { if (y > 19.5 && y < 23 && Math.abs(x - (cx + s * 8.5)) < 0.9) return 'pot'; }));
  // fire under the pot
  each((x, y) => { if (y < 21 || y > 25.5) return; const d = Math.abs(x - cx); const h = 25.6 - y; const lim = 6 - Math.abs(Math.sin(x * 2.1 + f * 1.7)) * 2.5; if (d < 7 && h < lim - d * 0.35 + 1.2) return rnd() > 0.5 ? 'fi1' : 'fi2'; });
  // rim (ellipse ring) + liquid surface
  each((x, y) => { const e = Math.hypot((x - cx) / 15.2, (y - 9.2) / 1.6); if (e < 1 && e > 0.72) return 'rim'; if (e <= 0.72) { const wv = Math.sin(x * 1.3 + f * 1.6); return wv > 0.55 ? 'liq2' : 'liq1'; } });
  // bubbles on the surface
  ([[cx - 6 + f * 2.4, 8.6], [cx + 4 - f * 1.5, 9.4], [cx + 9 - (f % 2) * 4, 8.9]] as const).forEach(([bx, by]) => { const c = Math.floor(bx / A), r = Math.floor(by); const cell = g[r] ? g[r][c] : null; if (cell && cell.indexOf('liq') === 0) g[r][c] = 'bub'; });
  // ladle: pivots in the brew, sweeps left/right
  const ang = [-0.55, -0.15, 0.25, -0.15][f];
  for (let t = 0; t < 1; t += 0.02) { const lx = cx + 3 + Math.sin(ang) * 10 * t + t * 6, ly = 9 - t * 8.6; const c = Math.floor(lx / A), r = Math.floor(ly); if (r >= 0 && r < R && c >= 0 && c < C) g[r][c] = 'lad'; }
  return layers(g, {
    sm1: { ch: '~', color: CREAM, op: 0.22 }, sm2: { ch: '~', color: CREAM, op: 0.4 },
    pot: { ch: '█', color: SMOKE, op: 1 }, hi: { ch: '▒', color: CREAM, op: 0.22 },
    fi1: { ch: '^', color: ORANGE, op: 1 }, fi2: { ch: '*', color: GOLD, op: 0.9 },
    rim: { ch: '=', color: CREAM, op: 0.85 }, liq1: { ch: '~', color: ORANGE, op: 0.8 }, liq2: { ch: '≈', color: CANDLE, op: 1 },
    bub: { ch: 'o', color: CANDLE, op: 1 }, lad: { ch: '#', color: GOLD, op: 1 }
  });
}
