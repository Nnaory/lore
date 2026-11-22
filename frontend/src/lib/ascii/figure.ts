/**
 * Paper-doll characters on a 44 × 48 cell grid (cell aspect 0.6).
 *
 * A character is a recipe (`CharacterSpec`): one part per slot + a cloth colour.
 * An expression only swaps eyes, brows and mouth at fixed face anchors, so every part
 * combination supports every expression. Mirrors the design canvas exactly (golden-tested).
 */
import { CELL_ASPECT, CREAM, GOLD, INK, ORANGE, grid, layers, type Grid, type Layer } from './core';

export const FIGURE_COLS = 44;
export const FIGURE_ROWS = 48;

export const EXPRESSIONS = ['calm', 'smile', 'worried', 'surprised', 'angry'] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export type Outfit = 'robe' | 'coat' | 'armor' | 'dress' | 'cloak';
export type Prop = 'lantern' | 'book' | 'spear' | 'orb' | 'broom';
export type Hat = 'pointed' | 'witch' | 'helmet' | 'hood';
export type Hair = 'sides' | 'long' | 'buns';
export type Beard = 'long' | 'mustache';
/** Eye glyph key: 'o2' ember glow, 'g2' gold, 'k' ink (dark holes). */
export type EyeKey = 'o2' | 'g2' | 'k';

export interface CharacterSpec {
  /** Hex colour of the clothes (robe, coat, tunic, dress, cloak + hood). */
  cloth?: string;
  outfit?: Outfit;
  prop?: Prop;
  hat?: Hat;
  hair?: Hair;
  beard?: Beard;
  eyes?: EyeKey;
  /** 'void' = no visible face (hooded). */
  face?: 'void';
  faceR?: number;
  faceTall?: number;
  mouthY?: number;
  blush?: boolean;
  clasp?: boolean;
  browKey?: string;
}

type Painter = (x: number, y: number, c: number, r: number) => string | null | undefined | void;

export function figure(spec: CharacterSpec, expr: Expression = 'calm'): Layer[] {
  const C = FIGURE_COLS, R = FIGURE_ROWS, A = CELL_ASPECT, cx = 13.2;
  const g: Grid = grid(C, R);
  const put = (c: number, r: number, v: string) => { if (c >= 0 && c < C && r >= 0 && r < R) g[r][c] = v; };
  const each = (fn: Painter) => { for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const v = fn(c * A + A / 2, r + 0.5, c, r); if (v) g[r][c] = v; } };
  const ell = (x: number, y: number, ex: number, ey: number, rx: number, ry: number) => Math.hypot((x - ex) / rx, (y - ey) / ry);
  const faceY = 18.2, faceR = spec.faceR || 4.3;

  // ---- outfit ----
  if (spec.outfit === 'robe') each((x, y) => { if (y < 24) return; const hw = 8.4 + (y - 24) / 24 * 4.2, d = Math.abs(x - cx); if (d > hw) return; if (d > hw - 0.7) return 'u3'; return Math.abs(Math.sin((x - cx) * 1.15 + y * 0.06)) > 0.93 ? 'u2' : 'u1'; });
  if (spec.outfit === 'coat') {
    each((x, y) => { if (y < 23.5) return; const hw = Math.min(7.6, 5.4 + (y - 23.5) * 0.9) + Math.max(0, y - 34) * 0.12, d = Math.abs(x - cx); if (d > hw) return; if (d > hw - 0.7) return 'u3'; if (d < 0.5) return 'u3'; return (y > 38 && y < 39.2) ? 'u3' : 'u2'; });
    each((x, y) => { if (y < 22.6 || y > 25.6) return; const d = Math.abs(x - cx); if (d < 5.6 - (y - 22.6) * 0.3) return 'o4'; });
    each((x, y) => { if (x > cx - 5.2 && x < cx - 3.4 && y > 25 && y < 31) return 'o4'; });
    [28, 31, 34].forEach((r) => put(Math.floor(cx / A), r, 'g1'));
  }
  if (spec.outfit === 'armor') {
    each((x, y) => { if (y < 24) return; const hw = 9.6 - Math.max(0, y - 32) * 0.12 + Math.max(0, y - 40) * 0.5, d = Math.abs(x - cx); if (d > hw) return; if (d > hw - 0.7) return 'u4';
      if (y < 34 && d < 5.8) return (Math.round(y) % 3 === 0) ? 'c4' : 'c3'; if (y > 34 && y < 35.4) return 'g2'; return y > 35 ? ((Math.round(x / A) % 3 === 0) ? 'u2' : 'u1') : 'u2'; });
    ([-1, 1] as const).forEach((s) => each((x, y) => { const e = ell(x, y, cx + s * 8.2, 25.6, 2.9, 2.2); if (e < 1 && y < 27.2) return e > 0.7 ? 'c5' : 'c4'; }));
    each((x, y) => { if (ell(x, y, cx, 29, 1.2, 1.6) < 1) return 'g2'; });
  }
  if (spec.outfit === 'dress') {
    each((x, y) => { if (y < 23.6) return; const d = Math.abs(x - cx);
      const hw = y < 33 ? (y < 26 ? 6.6 : 6.6 - (y - 26) * 0.16) : 5.5 + (y - 33) * 0.32;
      if (d > hw) return; if (d > hw - 0.7) return 'u3';
      if (y > 45.5) return (Math.floor(x / A) + Math.floor(y)) % 2 ? 'u3' : 'u2';
      if (y < 33) { if (y > 26 && y < 32.5 && d < 1.4 && Math.abs((d * 1.6) - ((y - 26) % 2)) < 0.6) return 'g1'; return 'u2'; }
      return Math.abs(Math.sin((x - cx) * 1.3 + y * 0.05)) > 0.92 ? 'u2' : 'u1'; });
    each((x, y) => { if (y > 32.6 && y < 33.8 && Math.abs(x - cx) < 5.6) return 'o4'; });
  }
  if (spec.outfit === 'cloak') each((x, y) => { if (y < 21) return; const hw = 6 + (y - 21) * 0.27, d = Math.abs(x - cx); if (d > hw) return; if (d > hw - 0.7) return 'u2'; return Math.abs(Math.sin((x - cx) * 0.9 + y * 0.03)) > 0.9 ? 'u2' : 'u1'; });

  // ---- props held in front ----
  if (spec.prop === 'lantern') {
    each((x, y) => { const sx = 17.5, sy = 27, ex = 20.6, ey = 33; const t = Math.max(0, Math.min(1, ((x - sx) * (ex - sx) + (y - sy) * (ey - sy)) / ((ex - sx) ** 2 + (ey - sy) ** 2))); const d = Math.hypot(x - (sx + t * (ex - sx)), (y - (sy + t * (ey - sy))) / 1.6); if (d < 1.5) return d > 1.05 ? 'u3' : 'u2'; });
    each((x, y) => { if (ell(x, y, 20.8, 33.6, 1.1, 1.1) < 1) return 'c4'; });
    each((x, y) => { const lx = 21.2; if (y < 34 || y > 44.5) return; if (Math.abs(x - lx) < 0.4 && y < 35.5) return 'g1';
      const hw = 2.1 - (y < 36 ? (36 - y) * 0.9 : 0) - (y > 42 ? (y - 42) * 0.7 : 0), d = Math.abs(x - lx); if (y < 35 || y > 43 || d > hw) return; if (d > hw - 0.65 || y < 36 || y > 42) return 'g2';
      return ell(x, y, lx, 39.2, 0.9, 2.3) < 1 ? 'o2' : 'o1'; });
  }
  if (spec.prop === 'book') {
    each((x, y) => { if (x > cx - 3.3 && x < cx + 3.3 && y > 29.5 && y < 35.5) { if (x < cx - 2.6 || x > cx + 2.6 || y < 30.5 || y > 34.5) return 'g2'; return Math.abs(x - cx) < 0.35 ? 'g1' : (Math.round(y) % 2 ? 'c5' : 'c4'); } });
    ([-1, 1] as const).forEach((s) => each((x, y) => { if (ell(x, y, cx + s * 3.6, 32.4, 1, 1.2) < 1) return 'c4'; }));
  }
  if (spec.prop === 'spear') {
    each((x, y) => { const sx = 22.4; if (Math.abs(x - sx) < 0.35 && y > 6 && y < 48) return 'g3'; const hw = (y - 1) * 0.28; if (y > 1 && y < 6.4 && Math.abs(x - sx) < Math.min(hw, 1.1)) return 'c5'; if (y > 6 && y < 7 && Math.abs(x - sx) < 1.6) return 'g2'; });
    each((x, y) => { if (ell(x, y, 22.4, 30.4, 1.2, 1.3) < 1) return 'c4'; });
  }
  if (spec.prop === 'orb') {
    each((x, y, c, r) => { const e = ell(x, y, cx, 34, 1.9, 2.4); if (e < 1) return e < 0.55 ? 'o2' : 'o1'; if (e < 1.9 && !g[r][c] && (c * 5 + r * 3) % 7 === 0) return 'o3'; });
    ([-1, 1] as const).forEach((s) => each((x, y) => { if (ell(x, y, cx + s * 2.7, 37.6, 1.1, 1) < 1) return 'c3'; }));
  }

  if (spec.prop === 'broom') {
    each((x, y) => { const sx = 19.5, sy = 15, ex = 24.6, ey = 42.2; if (y < sy || y > ey) return; const t = (y - sy) / (ey - sy); if (Math.abs(x - (sx + t * (ex - sx))) < 0.42) return 'g4'; });
    each((x, y) => { if (y > 41.6 && y < 42.6 && Math.abs(x - 24.6) < 1.1) return 'o4'; });
    each((x, y) => { if (y < 42.6) return; const hw = 0.7 + (y - 42.6) * 0.32; if (Math.abs(x - 24.7) < hw) return (Math.floor(x / A) % 2) ? 'g5' : 'g1'; });
    each((x, y) => { if (ell(x, y, 21.8, 27.4, 1.1, 1.2) < 1) return 'c4'; });
  }

  // ---- beard (under the face) ----
  if (spec.beard === 'long') each((x, y) => { if (y < 20 || y > 36) return; const t = (y - 20) / 16, hw = 4.9 * (1 - t * t * 0.95), d = Math.abs(x - cx - Math.sin(y * 0.5) * 0.25); if (d > hw) return; return Math.abs(Math.sin((x - cx) * 3.1)) > 0.9 ? 'c4' : 'c5'; });

  // ---- face ----
  if (spec.face !== 'void') each((x, y) => { if (ell(x, y, cx, faceY, faceR, faceR * (spec.faceTall || 1)) < 1 && (spec.beard !== 'long' || y < 22.5)) return 'c4'; });
  if (spec.blush) ([-1, 1] as const).forEach((s) => { put(Math.floor((cx + s * 2.7) / A), 20, 'o3'); put(Math.floor((cx + s * 2.7) / A) + 1, 20, 'o3'); });
  if (spec.beard === 'mustache') each((x, y) => { if (y < 20.2 || y > 22) return; const d = Math.abs(x - cx); if (d < 2.6 && d > 0.15 && y < 21.6 - d * 0.25 + 0.6) return 'c5'; });

  // ---- hair / headwear ----
  if (spec.hair === 'sides') each((x, y) => { if (y < 14 || y > 23) return; const d = Math.abs(x - cx); if (d > 4.2 && d < 5.9) return 'c3'; });
  if (spec.hair === 'long') {
    each((x, y) => { if (y < 13.6 || y > 29.5) return; const d = Math.abs(x - cx), wave = Math.sin(y * 0.9 + (x > cx ? 1 : 0)) * 0.35;
      const outer = 6.1 + wave + Math.max(0, y - 22) * 0.06, inner = y < 23 ? 3.9 : 3.9;
      if (d < inner || d > outer) return; if (y > 23 && y < 30 && d < 6.4 && Math.abs(x - cx) < 5.4 && y < 25) return; return d > outer - 0.7 ? 'c3' : 'c2'; });
    each((x, y) => { if (y > 14.2 && y < 15.8 && ell(x, y, cx, faceY, faceR, faceR * (spec.faceTall || 1)) < 1) return (Math.floor(x / A) % 3 === 1) ? null : 'c2'; });
  }
  if (spec.hair === 'buns') {
    each((x, y) => { const e = ell(x, y, cx, 16.4, 4.9, 4.4); if (e < 1 && y < 15.6) return 'c2'; if (y >= 15.6 && y < 16.6 && e < 1) return (Math.floor(x / A) % 3 === 0) ? null : 'c2'; const d = Math.abs(x - cx); if (y > 15 && y < 25 && d > 4 && d < 5.6 - (y - 15) * 0.05) return 'c2'; });
    ([-1, 1] as const).forEach((s) => each((x, y) => { const e = ell(x, y, cx + s * 4.6, 11.6, 2.2, 2.2); if (e < 1) return e > 0.72 ? 'c3' : 'c2'; }));
    ([-1, 1] as const).forEach((s) => { put(Math.floor((cx + s * 3.3) / A), 13, 'o4'); put(Math.floor((cx + s * 3.3) / A) + s, 13, 'o4'); });
  }
  if (spec.hat === 'pointed') {
    each((x, y) => { if (y < 1 || y > 13) return; const t = (y - 1) / 12, tipx = cx + 3.4 * (1 - t) * (1 - t), hw = 0.35 + t * 5.6, d = Math.abs(x - tipx); if (d > hw) return; if (y > 10.6 && y < 12.4) return 'g2'; return d > hw - 0.8 ? 'c3' : 'c2'; });
    each((x, y) => { const e = ell(x, y, cx, 13.6, 10.2, 1.25); if (e < 1) return e > 0.72 ? 'c4' : 'c3'; });
    ([[14.6, 4], [11.8, 8], [15.6, 9]] as const).forEach(([x, y]) => put(Math.floor(x / A), y, 'g1'));
  }
  if (spec.hat === 'witch') {
    each((x, y) => { if (y < 0.5 || y > 13) return; const t = (y - 0.5) / 12.5, tipx = cx - 5.6 * (1 - t) * (1 - t) * (1 - t) + 0.6 * (1 - t), hw = 0.3 + t * 5.9, d = Math.abs(x - tipx); if (d > hw) return;
      if (y > 10.2 && y < 12.2) return (Math.abs(x - (cx + 2.4)) < 0.9) ? 'g2' : 'o4'; if (y > 5.5 && y < 8 && x > tipx + 0.6 && x < tipx + 2.6) return 'c1'; return d > hw - 0.8 ? 'c3' : 'c2'; });
    each((x, y) => { const e = ell(x, y, cx + 0.4, 13.4, 11.6, 1.35); if (e < 1) return e > 0.74 ? 'c4' : 'c3'; });
    put(Math.floor((cx - 5.2) / A), 1, 'g1');
  }
  if (spec.hat === 'helmet') {
    each((x, y) => { const e = ell(x, y, cx, 15.6, 5.5, 5.2); if (e < 1 && y < 15.6) { if (y > 14.4) return 'g2'; return (Math.abs(x - cx) < 0.5) ? 'c5' : (e > 0.8 ? 'c4' : 'c3'); } });
    each((x, y) => { if (Math.abs(x - cx) < 0.35 && y > 15.5 && y < 19.2) return 'c5'; });
    ([-1, 1] as const).forEach((s) => each((x, y) => { if (y > 15.5 && y < 21.5 && Math.abs(x - (cx + s * 4.7)) < 0.9) return 'c3'; }));
    each((x, y) => { const px = cx + (11 - y) * 1.1; if (y > 6 && y < 11.4 && Math.abs(x - px) < 1.2 + (y - 6) * 0.08) return 'o1'; if (y > 5 && y < 7 && x > cx + 4 && x < cx + 7.5) return 'o1'; });
  }
  if (spec.hat === 'hood') {
    each((x, y) => { const tip = y < 11 ? (11 - y) * 0.9 : 0; const e = ell(x - tip * 0.15, y, cx, 17.4, 6.6, 8.2); if (e >= 1 || y > 24) return; const inner = ell(x, y, cx, 19, 4, 4.8); if (inner < 1) return 'v'; return e > 0.84 ? 'u3' : 'u2'; });
    each((x, y) => { if (y > 7 && y < 11 && Math.abs(x - (cx + (11 - y) * 0.45)) < 0.9 - (11 - y) * 0.12 + 0.4) return 'u3'; });
  }

  // ---- expression ----
  const ek: string = spec.eyes || 'k', fk = 'k';
  const eyeY = 18, e1 = Math.floor((cx - 1.9) / A), e2 = Math.floor((cx + 1.9) / A), mc = Math.floor(cx / A), my = spec.mouthY || 22;
  const EYES: Record<Expression, number[][][]> = {
    calm: [[[0, 0], [1, 0]], [[0, 0], [1, 0]]],
    smile: [[[-1, 0], [0, -1], [1, -1], [2, 0]], [[-1, 0], [0, -1], [1, -1], [2, 0]]],
    worried: [[[0, 0], [1, 0], [1, -1]], [[0, 0], [1, 0], [0, -1]]],
    surprised: [[[0, -1], [1, -1], [0, 0], [1, 0]], [[0, -1], [1, -1], [0, 0], [1, 0]]],
    angry: [[[-1, -1], [0, 0], [1, 0]], [[0, 0], [1, 0], [2, -1]]]
  };
  const BROWS: Record<Expression, number[][][]> = {
    calm: [[[-1, -2], [0, -2], [1, -2], [2, -2]], [[-1, -2], [0, -2], [1, -2], [2, -2]]],
    smile: [[[-1, -2], [0, -3], [1, -3], [2, -2]], [[-1, -2], [0, -3], [1, -3], [2, -2]]],
    worried: [[[-1, -2], [0, -2], [1, -3], [2, -3]], [[-1, -3], [0, -3], [1, -2], [2, -2]]],
    surprised: [[[-1, -3], [0, -4], [1, -4], [2, -3]], [[-1, -3], [0, -4], [1, -4], [2, -3]]],
    angry: [[[-1, -3], [0, -3], [1, -2], [2, -2]], [[-1, -2], [0, -2], [1, -3], [2, -3]]]
  };
  const MOUTH: Record<Expression, number[][]> = {
    calm: [[-1, 0], [0, 0], [1, 0]],
    smile: [[-2, -1], [-1, 0], [0, 0], [1, 0], [2, -1]],
    worried: [[-2, 1], [-1, 0], [0, 0], [1, 0], [2, 1]],
    surprised: [[-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
    angry: [[-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-2, 1], [2, 1]]
  };
  const x: Expression = EYES[expr] ? expr : 'calm';
  EYES[x][0].forEach(([dc, dr]) => put(e1 + dc, eyeY + dr, ek)); EYES[x][1].forEach(([dc, dr]) => put(e2 + dc, eyeY + dr, ek));
  if (spec.face !== 'void') {
    BROWS[x][0].forEach(([dc, dr]) => put(e1 + dc, eyeY + dr, spec.browKey || fk)); BROWS[x][1].forEach(([dc, dr]) => put(e2 + dc - 1, eyeY + dr, spec.browKey || fk));
    MOUTH[x].forEach(([dc, dr]) => put(mc + dc, my + dr, fk));
  }
  if (spec.clasp) { put(mc - 5, 25, 'g2'); put(mc + 5, 25, 'g2'); }

  const cloth = spec.cloth || CREAM;
  return layers(g, {
    c1: { ch: '.', color: CREAM, op: 0.42 }, c2: { ch: ':', color: CREAM, op: 0.6 }, c3: { ch: '+', color: CREAM, op: 0.78 },
    c4: { ch: '#', color: CREAM, op: 0.92 }, c5: { ch: '@', color: CREAM, op: 1 }, k: { ch: '-', color: INK, op: 1 },
    u1: { ch: '.', color: cloth, op: 0.6 }, u2: { ch: ':', color: cloth, op: 0.8 }, u3: { ch: '+', color: cloth, op: 0.95 }, u4: { ch: '#', color: cloth, op: 1 },
    g1: { ch: '*', color: GOLD, op: 1 }, g2: { ch: '#', color: GOLD, op: 1 }, g3: { ch: '|', color: GOLD, op: 1 }, g4: { ch: '\\', color: GOLD, op: 1 }, g5: { ch: ';', color: GOLD, op: 0.85 },
    o1: { ch: '*', color: ORANGE, op: 0.9 }, o2: { ch: '@', color: ORANGE, op: 1 }, o3: { ch: '·', color: ORANGE, op: 0.75 }, o4: { ch: '=', color: ORANGE, op: 0.95 }
  }, INK);
}
export type CastId = 'eldric' | 'mira' | 'hazel' | 'varr' | 'nyx';

/** The five built-in characters. Order = how they appear on the Cast board. */
export const CAST: Record<CastId, CharacterSpec> = {
  eldric: { cloth: '#6F86D9', outfit: 'robe', prop: 'lantern', beard: 'long', hair: 'sides', hat: 'pointed', eyes: 'o2', clasp: true },
  mira: { cloth: '#7DA868', outfit: 'coat', prop: 'book', hair: 'buns', faceR: 4.0, faceTall: 1.12, eyes: 'k', mouthY: 21, blush: true },
  varr: { cloth: '#3FA79C', outfit: 'armor', prop: 'spear', beard: 'mustache', hat: 'helmet', faceR: 4.4, faceTall: 1.15, eyes: 'k', mouthY: 22 },
  hazel: { cloth: '#E0393E', outfit: 'dress', prop: 'broom', hair: 'long', hat: 'witch', faceR: 4.1, faceTall: 1.1, eyes: 'g2', mouthY: 21, blush: true },
  nyx: { cloth: '#9A6BD6', outfit: 'cloak', prop: 'orb', hat: 'hood', face: 'void', eyes: 'o2' }
};
