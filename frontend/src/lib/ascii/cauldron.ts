/**
 * Hazel's cauldron: an animated ASCII pot used on the "Building your world" screen.
 *
 * Why it lives here: AGENTS.md says every drawing goes through a generator in `lib/ascii`, so the
 * pot is built from the same grid/layers primitives and palette as the characters and pumpkins.
 * `cauldron(frame)` is a pure function of the frame number: steam drifts up, bubbles pop on the
 * surface, the ladle sways and the fire flickers. The same frame always gives the same layers
 * (seeded by `rng`), so server and client render the same pixels and a test can pin a frame.
 * It is not part of the canvas golden fixture (the canvas never had a cauldron); the existing
 * generators and their numbers are untouched.
 */
import { CANDLE, CREAM, GOLD, ORANGE, SMOKE, grid, layers, rng, type Grid, type Layer } from './core';

export const CAULDRON_COLS = 64;
export const CAULDRON_ROWS = 34;
/** The motion repeats after this many frames. */
export const CAULDRON_FRAMES = 8;

const CX = 30;
const RIM_ROW = 14;
const SURFACE_ROW = 15;
const BODY_TOP = 16;
const BODY_BOTTOM = 28;
const FIRE_TOP = 29;

/** Half width of the pot at a body row: wide at the shoulder, rounding in towards the base. */
function halfWidth(r: number): number {
  const t = (r - BODY_TOP) / (BODY_BOTTOM - BODY_TOP);
  return Math.round(26 - 11 * t * t);
}

const cache = new Map<number, Layer[]>();

export function cauldron(frame: number): Layer[] {
  const f = ((Math.floor(frame) % CAULDRON_FRAMES) + CAULDRON_FRAMES) % CAULDRON_FRAMES;
  const hit = cache.get(f);
  if (hit) return hit;

  const g: Grid = grid(CAULDRON_COLS, CAULDRON_ROWS);
  const put = (r: number, c: number, key: string) => {
    if (r >= 0 && r < CAULDRON_ROWS && c >= 0 && c < CAULDRON_COLS) g[r][c] = key;
  };

  // Body, with a lit left edge.
  for (let r = BODY_TOP; r <= BODY_BOTTOM; r++) {
    const hw = halfWidth(r);
    for (let c = CX - hw; c <= CX + hw; c++) put(r, c, 'b');
    put(r, CX - hw, 'e');
    put(r, CX - hw + 1, 'e');
    put(r, CX + hw, 'd');
  }
  // Two handles on the shoulders.
  for (let k = 0; k < 3; k++) {
    put(BODY_TOP + 1 + k, CX - halfWidth(BODY_TOP) - 2 - (k === 1 ? 1 : 0), 'e');
    put(BODY_TOP + 1 + k, CX + halfWidth(BODY_TOP) + 2 + (k === 1 ? 1 : 0), 'd');
  }
  // Short legs over the fire.
  for (const side of [-1, 1]) {
    const c = CX + side * (halfWidth(BODY_BOTTOM) - 3);
    put(BODY_BOTTOM + 1, c, 'b');
    put(BODY_BOTTOM + 1, c + 1, 'b');
  }

  // Rim and the liquid surface.
  const rimHalf = halfWidth(BODY_TOP) + 3;
  for (let c = CX - rimHalf; c <= CX + rimHalf; c++) {
    put(RIM_ROW, c, 'r');
    put(SURFACE_ROW, c, c % 3 === (f >> 1) % 3 ? 'm' : 'l');
  }
  const rnd = rng(7 + (f >> 1) * 13);
  for (let i = 0; i < 5; i++) {
    const c = CX - rimHalf + 3 + Math.floor(rnd() * (rimHalf * 2 - 5));
    put(SURFACE_ROW, c, i % 2 === 0 ? 'o' : 'O');
  }

  // Steam: three wisps that drift up and sway.
  for (let w = 0; w < 3; w++) {
    const base = CX - 12 + w * 12;
    for (let r = 0; r < RIM_ROW - 1; r++) {
      const age = (RIM_ROW - 2 - r + f * 2 + w * 3) % 12;
      if (age > 7) continue;
      const sway = Math.round(Math.sin((r + f + w * 2) * 0.7) * 2);
      put(r, base + sway, age < 4 ? 's' : 't');
      if (age < 3) put(r, base + sway + 1, 't');
    }
  }

  // Ladle: the handle leans up and to the right and dips a little with the stirring.
  const dip = [0, 1, 2, 1, 0, -1, -2, -1][f];
  for (let i = 0; i < 12; i++) put(RIM_ROW - 1 - i, CX + 4 + i + dip, 'k');
  for (let i = 0; i < 12; i += 3) put(RIM_ROW - 1 - i, CX + 5 + i + dip, 'k');
  put(SURFACE_ROW, CX + 3 + dip, 'k');
  put(SURFACE_ROW, CX + 2 + dip, 'k');

  // Fire.
  const fire = rng(31 + f * 5);
  const fireHalf = halfWidth(BODY_BOTTOM) + 1;
  for (let r = FIRE_TOP; r < CAULDRON_ROWS; r++) {
    for (let c = CX - fireHalf; c <= CX + fireHalf; c++) {
      const v = fire();
      const density = r === FIRE_TOP ? 0.45 : r === FIRE_TOP + 1 ? 0.7 : 0.9;
      if (v > density) continue;
      put(r, c, v < 0.3 ? 'f1' : v < 0.6 ? 'f2' : 'f3');
    }
  }

  const out = layers(g, {
    b: { ch: '█', color: SMOKE, op: 1 },
    e: { ch: '▒', color: CREAM, op: 0.22 },
    d: { ch: '▓', color: CANDLE, op: 0.08 },
    r: { ch: '=', color: CREAM, op: 0.7 },
    l: { ch: '~', color: GOLD, op: 0.85 },
    m: { ch: '≈', color: CANDLE, op: 0.9 },
    o: { ch: 'o', color: GOLD, op: 1 },
    O: { ch: 'O', color: ORANGE, op: 0.9 },
    s: { ch: '~', color: CREAM, op: 0.4 },
    t: { ch: '~', color: CREAM, op: 0.2 },
    k: { ch: '#', color: GOLD, op: 1 },
    f1: { ch: '^', color: ORANGE, op: 0.9 },
    f2: { ch: '*', color: GOLD, op: 0.9 },
    f3: { ch: '^', color: GOLD, op: 0.5 },
  });
  cache.set(f, out);
  return out;
}
