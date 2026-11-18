/**
 * What a sampled point is made of. Shape samplers write an Ink; the renderer
 * turns it into a cell: a block of colour with a glyph on top, or a bare glyph.
 * Adapted from ascii-animals (MIT, see ./LICENSE).
 */

export type RGB = [number, number, number];

/** Ordinary skin: a block of colour with a sparse (bright) to dense (dark) glyph. */
export const INK_SCALE = 0;
/** Dark grooves, stalks, patches: a block with a lighter, dense glyph. */
export const INK_DARK = 1;
/** Light without substance: a bare glyph, no block. */
export const INK_GLOW = 5;

export interface Ink {
  r: number;
  g: number;
  b: number;
  kind: number;
  /** Glyphs to use instead of the kind's own set; null for the default. */
  glyphs: string | null;
  /**
   * Body-anchored coordinates (fractions of span) that seed the glyph
   * texture, so it rides along with the creature. The renderer presets them
   * to the sample's (u, v).
   */
  au: number;
  av: number;
}

/** Fill in an Ink. Returns true, so a sampler can `return ink(...)` on a hit. */
export function ink(out: Ink, r: number, g: number, b: number, kind = INK_SCALE, glyphs: string | null = null): true {
  out.r = r;
  out.g = g;
  out.b = b;
  out.kind = kind;
  out.glyphs = glyphs;
  return true;
}
