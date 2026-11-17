/**
 * Draws a Flock as a grid of ASCII cells:
 *   1. a faint cell grid on the night background
 *   2. a trail field that creatures shed into, diffusing and fading as dots
 *   3. the creatures, through a Pen: silhouettes rasterised cell by cell with
 *      supersampled edges (solid cells become a block of colour with a glyph,
 *      partial cells a light edge glyph) and single-glyph dots. Far creatures
 *      fade into the background.
 *
 * Adapted from ascii-animals (MIT, see ./LICENSE): dark only, with the
 * palette passed in; the hue knob, line glyphs and the ink kinds the
 * pumpkins don't use are left out.
 */
import type { Creature, Flock, Tuning } from "./flock";
import { INK_DARK, INK_GLOW, type Ink, type RGB } from "./ink";
import { clamp, hash3 } from "./math";

const ALPHA_LEVELS = 6;

export interface FieldPalette {
  background: RGB;
  /** Grid line colour and opacity at tuning.grid = 1. */
  grid: [number, number, number, number];
  /** Opacity of the densest trail. */
  trailAlpha: number;
}

// Sparse glyphs on bright skin, dense glyphs in shadow.
const SCALE_RAMP = ".:;+=*%#";
const DARK_GLYPHS = "#%@";
const GLOW_RAMP = ".:+*";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";
/** Glints: white, candlelight and candy corn. */
const SPARKLES: RGB[] = [
  [255, 255, 255],
  [255, 238, 204],
  [255, 214, 140],
];

/** Cell is empty. */
const CELL_NONE = 0;
/** A block of colour with a glyph on top. */
const CELL_SOLID = 1;
/** A bare glyph: soft edges, glows, dots. */
const CELL_SOFT = 2;

// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];

/** Where and how big something is drawn: a creature, or one part of it. */
export interface Pose {
  x: number;
  y: number;
  heading: number;
  /** px per unit of body coordinates. */
  span: number;
  depth: number;
  /** Seeds the glyph texture. */
  id: number;
}

/**
 * Classifies one point in body coordinates (fractions of span: u forward along
 * the heading, v across to the right) and its screen position (px, py).
 * On a hit, write pen.ink and return true.
 */
export type Sampler = (u: number, v: number, px: number, py: number) => boolean;

export interface ShapeOptions {
  /** Brightness multiplier. */
  light?: number;
  /** Overrides how far this fades into the background (default: by depth). */
  fog?: number;
}

/** Faint cell grid, snapped to device pixels. */
function paintGrid(g: CanvasRenderingContext2D, W: number, H: number, cw: number, ch: number, dpr: number, stroke: string) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = stroke;
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= Math.ceil(W / cw); c++) {
    const x = Math.round(c * cw * dpr) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, H * dpr);
  }
  for (let r = 0; r <= Math.ceil(H / ch); r++) {
    const y = Math.round(r * ch * dpr) + 0.5;
    g.moveTo(0, y);
    g.lineTo(W * dpr, y);
  }
  g.stroke();
}

const rgb = (r: number, g: number, b: number) =>
  `rgb(${clamp(Math.round(r), 0, 255)},${clamp(Math.round(g), 0, 255)},${clamp(Math.round(b), 0, 255)})`;

const pack = (r: number, g: number, b: number) =>
  (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255);

/** What species draw with. One per renderer, reused every frame. */
export class Pen {
  /** The sampler's output; preset to defaults before every sample. */
  readonly ink: Ink = { r: 0, g: 0, b: 0, kind: 0, glyphs: null, au: 0, av: 0 };
  t = 0;

  constructor(private readonly r: AsciiRenderer) {}

  /** Body coordinates → screen px. */
  toWorld(p: Pose, u: number, v: number, out: { x: number; y: number }) {
    const c = Math.cos(p.heading);
    const s = Math.sin(p.heading);
    out.x = p.x + (u * c - v * s) * p.span;
    out.y = p.y + (u * s + v * c) * p.span;
    return out;
  }

  /** Default fade for something at this depth. */
  fogFor(depth: number) {
    return (1 - depth) * this.r.tuning.fog;
  }

  /** Rasterise a silhouette within `reach` (fraction of span) of the pose. */
  shape(p: Pose, reach: number, sample: Sampler, opts: ShapeOptions = {}) {
    this.r.shape(p, reach, sample, opts);
  }

  /** A single glyph at (x, y) px, faded by depth (or by `fog` if given). Soft dots never cover solid cells. */
  dot(x: number, y: number, glyph: string, color: RGB, depth: number, fog = this.fogFor(depth)) {
    this.r.dot(x, y, glyph, color, fog);
  }

  /** Leave something in the trail at (x, y), scaled by the trail knob. */
  shed(x: number, y: number, amount: number) {
    this.r.shed(x, y, amount);
  }
}

export class AsciiRenderer {
  cw = 12;
  ch = 18;
  cols = 0;
  rows = 0;
  readonly pen = new Pen(this);

  private readonly ctx: CanvasRenderingContext2D;
  private readonly bg: HTMLCanvasElement;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private fontFamily = "ui-monospace, Menlo, monospace";

  private energy = new Float32Array(0);
  private energyTmp = new Float32Array(0);
  private readonly trailStyles: string[] = [];

  private cellFlag = new Uint8Array(0);
  /** Block colour, packed 0xRRGGBB. */
  private cellFill = new Uint32Array(0);
  /** Glyph colour, packed 0xRRGGBB. */
  private cellColor = new Uint32Array(0);
  private cellGlyph = new Uint16Array(0);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly tuning: Tuning,
    private readonly palette: FieldPalette,
    trail: RGB,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.bg = document.createElement("canvas");
    const [r, g, b] = trail;
    for (let l = 0; l < ALPHA_LEVELS; l++) {
      this.trailStyles.push(`rgba(${r},${g},${b},${((palette.trailAlpha * (l + 1)) / ALPHA_LEVELS).toFixed(3)})`);
    }
  }

  setFontFamily(family: string) {
    if (family) this.fontFamily = family;
  }

  /** Blend a colour toward the background by f (0 → colour, 1 → background), packed 0xRRGGBB. */
  private fade(r: number, g: number, b: number, f: number) {
    const [br, bg, bb] = this.palette.background;
    return pack(r + (br - r) * f, g + (bg - g) * f, b + (bb - b) * f);
  }

  /**
   * Returns false, touching nothing, when the size is already right: assigning
   * canvas.width clears the bitmap even to the same value, so a resize that
   * changes nothing would still blank the canvas.
   */
  resize(width: number, height: number, dpr: number) {
    if (width === this.width && height === this.height && dpr === this.dpr) return false;
    const prevCols = this.cols;
    const prevRows = this.rows;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = clamp(Math.round(width / 124 / this.tuning.detail), 5, 24);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;

    const n = this.cols * this.rows;
    if (this.cols !== prevCols || this.rows !== prevRows) {
      this.energy = new Float32Array(n);
      this.energyTmp = new Float32Array(n);
      this.cellFlag = new Uint8Array(n);
      this.cellFill = new Uint32Array(n);
      this.cellColor = new Uint32Array(n);
      this.cellGlyph = new Uint16Array(n);
    }
    this.paintBackground();
    return true;
  }

  private paintBackground() {
    const g = this.bg.getContext("2d");
    if (!g) return;
    const { width: W, height: H, dpr, cw, ch } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = rgb(...this.palette.background);
    g.fillRect(0, 0, W, H);
    const [gr, gg, gb, ga] = this.palette.grid;
    paintGrid(g, W, H, cw, ch, dpr, `rgba(${gr},${gg},${gb},${(ga * this.tuning.grid).toFixed(3)})`);
  }

  /** Draw one frame. With dt 0 the current frame is redrawn without moving the trail on. */
  render<C extends Creature>(flock: Flock<C>, dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    this.pen.t = flock.time;

    for (const e of flock.events) this.stamp(e.x, e.y, e.radius, e.amount);
    flock.events.length = 0;
    if (dt > 0) this.diffuse(dt);

    this.cellFlag.fill(CELL_NONE);
    const species = flock.species;
    if (species.drawAll) species.drawAll(flock, this.pen);
    else if (species.draw) for (const c of flock.creatures) species.draw(c, this.pen, flock);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.drawTrail(flock.time);

    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.drawCells();
  }

  // ── trail ───────────────────────────────────────────────────────────

  cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  shed(x: number, y: number, amount: number) {
    const i = this.cellIndex(x, y);
    if (i >= 0) this.energy[i] = Math.min(1.6, this.energy[i] + amount * this.tuning.trail);
  }

  private stamp(x: number, y: number, radius: number, amount: number) {
    const field = this.energy;
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
      }
    }
  }

  /** Blur + decay so the trail drifts outward and fades. */
  private diffuse(dt: number) {
    const { cols, rows, energy, energyTmp: tmp } = this;
    const decay = Math.exp(-dt * this.tuning.trailFade);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const l = c > 0 ? energy[i - 1] : energy[i];
        const rt = c < cols - 1 ? energy[i + 1] : energy[i];
        const u = r > 0 ? energy[i - cols] : energy[i];
        const d = r < rows - 1 ? energy[i + cols] : energy[i];
        tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
      }
    }
    this.energy = tmp;
    this.energyTmp = energy;
  }

  private drawTrail(t: number) {
    const { ctx, cols, cw, ch, energy, cellFlag } = this;
    const small = Math.max(2, Math.round(cw * 0.19));
    for (let level = 0; level < ALPHA_LEVELS; level++) {
      ctx.fillStyle = this.trailStyles[level];
      for (let i = 0; i < energy.length; i++) {
        const e = energy[i];
        if (e < 0.12 || cellFlag[i] === CELL_SOLID) continue;
        const col = i % cols;
        const row = (i / cols) | 0;
        // Each grain twinkles on its own clock.
        const twinkle = 0.75 + 0.25 * Math.sin(t * 5 + hash3(col, row, 3) * 40);
        if (clamp(Math.floor(e * twinkle * 4 * ALPHA_LEVELS) - 1, 0, ALPHA_LEVELS - 1) !== level) continue;
        const size = e > 0.6 ? small + 1 : small;
        ctx.fillRect(Math.round(col * cw + cw * 0.5 - size / 2), Math.round(row * ch + ch * 0.6 - size / 2), size, size);
      }
    }
  }

  // ── drawing into cells ──────────────────────────────────────────────

  /** Run the sampler for one point, with the ink preset to its defaults. */
  private probe(sample: Sampler, p: Pose, hc: number, hs: number, px: number, py: number) {
    const ink = this.pen.ink;
    const dx = px - p.x;
    const dy = py - p.y;
    const u = (dx * hc + dy * hs) / p.span;
    const v = (dy * hc - dx * hs) / p.span;
    ink.glyphs = null;
    ink.au = u;
    ink.av = v;
    return sample(u, v, px, py);
  }

  /**
   * Supersample every cell within reach of the pose. Fully covered cells
   * become solid (or glyph-only, for glows); partial cells become soft edge
   * glyphs, which never cover anything solid.
   */
  shape(p: Pose, reach: number, sample: Sampler, { light = 1, fog = (1 - p.depth) * this.tuning.fog }: ShapeOptions) {
    const { cellFlag, cellFill, cellColor, cellGlyph, cw, ch, cols, rows } = this;
    const ink = this.pen.ink;
    const t = this.pen.t;
    const { sparkle } = this.tuning;
    const S = p.span;
    const hc = Math.cos(p.heading);
    const hs = Math.sin(p.heading);
    const R = reach * S;
    const c0 = Math.max(0, Math.floor((p.x - R) / cw));
    const c1 = Math.min(cols - 1, Math.floor((p.x + R) / cw));
    const r0 = Math.max(0, Math.floor((p.y - R) / ch));
    const r1 = Math.min(rows - 1, Math.floor((p.y + R) / ch));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = c * cw;
        const y = r * ch;
        const center = this.probe(sample, p, hc, hs, x + cw / 2, y + ch / 2);
        let hits = center ? 1 : 0;
        let ir = ink.r;
        let ig = ink.g;
        let ib = ink.b;
        const kind = ink.kind;
        const glyphs = ink.glyphs;
        const au = ink.au;
        const av = ink.av;
        for (let k = 0; k < SUBSAMPLES.length; k += 2) {
          if (this.probe(sample, p, hc, hs, x + SUBSAMPLES[k] * cw, y + SUBSAMPLES[k + 1] * ch)) {
            if (hits === 0) {
              ir = ink.r;
              ig = ink.g;
              ib = ink.b;
            }
            hits++;
          }
        }
        if (hits === 0) continue;
        const coverage = hits / 5;
        const i = r * cols + c;
        const solid = center && coverage >= 0.6;
        if (!solid && cellFlag[i] === CELL_SOLID) continue;

        const k = light * (1 + (hash3(c, r, Math.floor(t * 6)) - 0.5) * 0.06);
        ir *= k;
        ig *= k;
        ib *= k;
        // Body-anchored key so each glyph rides along with the creature.
        const key = (hash3(Math.round((au * S) / (cw * 0.9)), Math.round((av * S) / (cw * 0.9)), p.id) * 4294967295) >>> 0;

        if (!solid) {
          // Soft, anti-aliased silhouette: just a glyph that fades into the background.
          const set = coverage >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
          cellFlag[i] = CELL_SOFT;
          cellColor[i] = this.fade(ir, ig, ib, Math.min(1, fog + 0.55 - 0.45 * coverage));
          cellGlyph[i] = set.charCodeAt((key >>> 8) % set.length);
          continue;
        }

        if (kind === INK_GLOW) {
          if (cellFlag[i] === CELL_SOLID) continue;
          const lum = (0.3 * ir + 0.59 * ig + 0.11 * ib) / 255;
          const set = glyphs ?? GLOW_RAMP;
          cellFlag[i] = CELL_SOFT;
          cellColor[i] = this.fade(ir, ig, ib, fog);
          cellGlyph[i] = set.charCodeAt(glyphs ? (key >>> 8) % set.length : clamp(Math.floor(lum * set.length), 0, set.length - 1));
          continue;
        }

        cellFlag[i] = CELL_SOLID;
        const roll = hash3(key, Math.floor(t * 2.4 + (key % 997) / 97), 7);
        const fill = this.fade(ir, ig, ib, fog);
        cellFill[i] = fill;
        const fr = fill >>> 16;
        const fg = (fill >>> 8) & 255;
        const fb = fill & 255;
        if (kind === INK_DARK) {
          const set = glyphs ?? DARK_GLYPHS;
          cellGlyph[i] = set.charCodeAt((key >>> 8) % set.length);
          cellColor[i] = pack(fr * 1.7 + 34, fg * 1.7 + 30, fb * 1.7 + 30);
          continue;
        }
        // Plain skin: sparse glyphs on bright skin, dense in shadow, now and then a glint.
        if (glyphs) {
          cellGlyph[i] = glyphs.charCodeAt((key >>> 8) % glyphs.length);
        } else {
          const lum = (0.3 * fr + 0.59 * fg + 0.11 * fb) / 255;
          const jitter = ((key >>> 4) % 3) - 1;
          cellGlyph[i] = SCALE_RAMP.charCodeAt(clamp(Math.floor((1 - lum) * (SCALE_RAMP.length - 0.01)) + jitter, 0, SCALE_RAMP.length - 1));
        }
        cellColor[i] = roll < sparkle / 3 ? pack(...SPARKLES[key % SPARKLES.length]) : pack(fr * 0.42, fg * 0.42, fb * 0.42);
      }
    }
  }

  dot(x: number, y: number, glyph: string, color: RGB, fog: number) {
    const i = this.cellIndex(x, y);
    if (i < 0 || this.cellFlag[i] === CELL_SOLID) return;
    this.cellFlag[i] = CELL_SOFT;
    this.cellColor[i] = this.fade(color[0], color[1], color[2], fog);
    this.cellGlyph[i] = glyph.charCodeAt(0);
  }

  private drawCells() {
    const { ctx, cols, rows, cw, ch, cellFlag, cellFill, cellColor, cellGlyph } = this;
    const n = cols * rows;
    for (let i = 0; i < n; i++) {
      const flag = cellFlag[i];
      if (!flag) continue;
      const x = (i % cols) * cw;
      const y = ((i / cols) | 0) * ch;
      if (flag === CELL_SOLID) {
        const f = cellFill[i];
        ctx.fillStyle = rgb(f >>> 16, (f >>> 8) & 255, f & 255);
        ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      }
      const g = cellColor[i];
      ctx.fillStyle = rgb(g >>> 16, (g >>> 8) & 255, g & 255);
      ctx.fillText(String.fromCharCode(cellGlyph[i]), x + cw / 2, y + ch / 2 + 1);
    }
  }
}
