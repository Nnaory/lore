/**
 * Procedural scenes ("option A"): the story agent sends a small recipe, the client draws it.
 * Same recipe + seed → identical scene everywhere (golden-tested against the design canvas).
 */
import { CREAM, GOLD, ORANGE, SMOKE, grid, layers, rng, type Grid, type Layer } from './core';

export interface SceneParams {
  seed: number;
  cols: number;
  rows: number;
  /** Row where the skyline meets the ground. */
  horizon: number;
  /** Column of the dying-beacon tower. */
  beaconCol: number;
  /** Column of the gate arch. */
  gateCol: number;
  /** [col, row, radius] of the moon, or omit for none. */
  moon?: [number, number, number];
}

export function scene(rec: SceneParams): Layer[] {
  const { cols: C, rows: R } = rec, g: Grid = grid(C, R), rnd = rng(rec.seed);
  for (let i = 0; i < C * R * 0.012; i++) { const c = Math.floor(rnd() * C), r = Math.floor(rnd() * rec.horizon * 0.9); g[r][c] = rnd() > 0.85 ? 's2' : 's1'; }
  if (rec.moon) { const [mc, mr, rad] = rec.moon; for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const d = Math.hypot((c - mc) * 0.6, r - mr); if (d < rad) g[r][c] = d > rad - 0.9 ? 'm2' : 'm1'; } }
  // skyline of towers
  let c = 0;
  while (c < C) { const w = 3 + Math.floor(rnd() * 7), h = Math.floor(rec.horizon * (0.12 + rnd() * 0.3)); const top = rec.horizon - h; const spire = rnd() > 0.7;
    for (let x = c; x < Math.min(C, c + w); x++) for (let y = top; y < R; y++) g[y][x] = 'b';
    if (spire) { const mid = c + Math.floor(w / 2); for (let y = top - 4; y < top; y++) if (y >= 0 && mid < C) g[y][mid] = 'b'; }
    for (let x = c + 1; x < Math.min(C, c + w - 1); x += 2) for (let y = top + 2; y < rec.horizon + 4; y += 3) if (rnd() > 0.82 && y < R) g[y][x] = 'w';
    c += w + (rnd() > 0.6 ? 1 : 0); }
  // the dying beacon tower
  const bc = rec.beaconCol, btop = Math.floor(rec.horizon * 0.18);
  for (let y = btop; y < R; y++) { const hw = y < btop + 4 ? 1 : 2 + Math.floor((y - btop) / 18); for (let x = bc - hw; x <= bc + hw; x++) if (x >= 0 && x < C) g[y][x] = 't'; }
  for (let y = btop - 3; y < btop; y++) for (let x = bc - 2; x <= bc + 2; x++) if (Math.abs(x - bc) <= 2 - (btop - y - 1)) g[y][x] = 'f';
  for (let r = btop - 8; r < btop + 5; r++) for (let x = bc - 10; x <= bc + 10; x++) { if (r < 0 || x < 0 || x >= C) continue; const d = Math.hypot((x - bc) * 0.6, r - (btop - 2)); if (!g[r][x] && d < 6 && d > 2.2 && rnd() > 0.55) g[r][x] = 'gl'; }
  // gate arch
  const gc = rec.gateCol, gw = 9, gtop = rec.horizon - 6;
  for (let y = gtop; y < R; y++) for (let x = gc - gw; x <= gc + gw; x++) { if (x < 0 || x >= C) continue; const arch = Math.hypot((x - gc) * 0.6, (y - (gtop + 6))) < 3.6 || (Math.abs(x - gc) < 6 && y > gtop + 6);
    g[y][x] = arch ? null : 't'; }
  // mist bands
  for (let r = rec.horizon; r < R; r++) for (let x = 0; x < C; x++) if (rnd() > 0.6 && (r % 3 === 0)) g[r][x] = 'mi';
  return layers(g, {
    s1: { ch: '.', color: CREAM, op: 0.28 }, s2: { ch: '+', color: GOLD, op: 0.6 }, m1: { ch: '░', color: CREAM, op: 0.16 }, m2: { ch: '▒', color: CREAM, op: 0.3 },
    b: { ch: '▓', color: SMOKE, op: 1 }, w: { ch: '▪', color: GOLD, op: 0.55 }, t: { ch: '█', color: SMOKE, op: 1 },
    f: { ch: '▲', color: ORANGE, op: 0.75 }, gl: { ch: '·', color: ORANGE, op: 0.45 }, mi: { ch: '~', color: SMOKE, op: 1 }
  });
}


/** Layout presets used by the Stage screens. Biome → params lives in recipes.ts. */
export const SCENE_LAYOUTS = {
  stageDesktop: { cols: 167, rows: 57, horizon: 30, beaconCol: 55, gateCol: 55, moon: [12, 4, 2.6] as [number, number, number] },
  stagePhone: { cols: 82, rows: 99, horizon: 52, beaconCol: 60, gateCol: 60, moon: [70, 36, 2.2] as [number, number, number] },
} as const;
