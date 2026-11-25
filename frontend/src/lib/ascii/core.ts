/**
 * LORE ASCII engine — core primitives.
 *
 * Everything visual in LORE (characters, scenes, pumpkins, the wordmark) is a grid of
 * cells. Each generator fills cells with a *key* (e.g. "c3", "u2", "o1"), then `layers()`
 * turns the grid into one text layer per key: same size, spaces everywhere except that
 * key's glyph. Renderers stack the layers with their colour + opacity.
 *
 * DO NOT change numbers in this folder without regenerating the golden fixture
 * (tests/fixtures/ascii-golden.json). The golden file is what the design canvas renders.
 */

export type Cell = string | null;
export type Grid = Cell[][];

/** One stacked text layer. `text` has `rows` lines of exactly `cols` characters. */
export interface Layer {
  color: string;
  op: number;
  text: string;
}

/** How one cell key is drawn. */
export interface GlyphStyle {
  ch: string;
  color: string;
  op: number;
}

export type GlyphSpec = Record<string, GlyphStyle>;

/** Black Cat Gold palette (see docs/DESIGN-SYSTEM.md §1). */
export const CREAM = '#F4EFE6';
export const GOLD = '#C9A227';
export const ORANGE = '#FF7A18';
export const INK = '#0F0F12';
export const SMOKE = '#2A2A2E';
/** Candle glow used only inside pumpkin faces and the mouth input. */
export const CANDLE = '#F2D27A';

/** Monospace cell aspect: JetBrains Mono advance width is 0.6em. */
export const CELL_ASPECT = 0.6;

/** Deterministic PRNG (mulberry32). Same seed → same scene, on server and client. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function grid(cols: number, rows: number): Grid {
  const g: Grid = [];
  for (let i = 0; i < rows; i++) g.push(new Array<Cell>(cols).fill(null));
  return g;
}

/**
 * Split a grid into stacked layers.
 * @param mask optional colour for a solid silhouette layer ('█' under every filled cell),
 *             used by characters so they read as opaque sprites over a scene.
 */
export function layers(g: Grid, spec: GlyphSpec, mask?: string): Layer[] {
  const out: Layer[] = [];
  if (mask) out.push({ color: mask, op: 1, text: g.map((row) => row.map((v) => (v ? '█' : ' ')).join('')).join('\n') });
  Object.keys(spec).forEach((k) => {
    const s = spec[k];
    let any = false;
    const text = g
      .map((row) =>
        row
          .map((v) => {
            if (v === k) {
              any = true;
              return s.ch;
            }
            return ' ';
          })
          .join(''),
      )
      .join('\n');
    if (any) out.push({ color: s.color, op: s.op, text });
  });
  return out;
}

/** Size of a layer stack in cells. */
export function layerSize(ls: Layer[]): { cols: number; rows: number } {
  if (!ls.length) return { cols: 0, rows: 0 };
  const lines = ls[0].text.split('\n');
  return { cols: lines[0].length, rows: lines.length };
}

/** Keep rows [from, to) of every layer — used for bust crops of characters. */
export function cropRows(ls: Layer[], from: number, to: number): Layer[] {
  return ls.map((l) => ({ color: l.color, op: l.op, text: l.text.split('\n').slice(from, to).join('\n') }));
}
