/**
 * Image → ASCII art
 *
 * Turns RGBA pixels into a grid of characters for a dark background: each
 * character cell averages the luminance of the pixels it covers, and
 * brighter cells get denser characters (so the art, drawn in gold on the
 * dark stage, looks like the picture).
 *
 *   - Monospace cells are taller than they are wide, so the row count is
 *     scaled by `cellAspect` (glyph width ÷ line height) to keep proportions.
 *   - Transparent pixels are blended onto `background` before measuring.
 *   - Contrast is stretched so the darkest cell is blank and the brightest
 *     uses the densest character, whatever the photo's exposure.
 *
 * Pure function — no DOM, no canvas; see load-image.ts for reading files.
 */

/** RGBA pixels, row-major, 4 bytes per pixel (the shape of canvas ImageData). */
export type PixelSource = {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
};

/** Characters from empty to dense. */
export const DEFAULT_RAMP = " .:-=+*#%@";

/** Glyph width ÷ line height for a monospace font rendered at line-height 1. */
export const MONO_CELL_ASPECT = 0.6;

export type AsciiOptions = {
  /** Characters per line. */
  columns: number;
  /** Glyph width ÷ line height of the font the art will be shown in. */
  cellAspect?: number;
  /** Characters from empty to dense; at least two. */
  ramp?: string;
  /** Dense characters for dark areas instead (for subjects on a bright backdrop). */
  invert?: boolean;
  /** Luminance (0–1) shown through transparent pixels. 0 = the dark stage. */
  background?: number;
};

/** Relative luminance (0–1) of an sRGB colour, without linearisation. */
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Number of text rows for an image of this shape at `columns` characters wide. */
export function asciiRows(width: number, height: number, columns: number, cellAspect = MONO_CELL_ASPECT): number {
  return Math.max(1, Math.round(columns * (height / width) * cellAspect));
}

/** Convert pixels to ASCII art: lines joined by "\n", every line `columns` long. */
export function imageToAscii(src: PixelSource, options: AsciiOptions): string {
  const { width, height, data } = src;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    throw new RangeError("imageToAscii: pixel data does not match width × height × 4");
  }
  const ramp = options.ramp ?? DEFAULT_RAMP;
  if (ramp.length < 2) throw new RangeError("imageToAscii: ramp needs at least two characters");

  const columns = Math.max(1, Math.round(options.columns));
  const rows = asciiRows(width, height, columns, options.cellAspect);
  const background = options.background ?? 0;

  // Average luminance per cell (box filter over the pixels each cell covers).
  const cells = new Float64Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    const y0 = Math.floor((row * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / rows));
    for (let col = 0; col < columns; col++) {
      const x0 = Math.floor((col * width) / columns);
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * width) / columns));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const alpha = data[i + 3] / 255;
          sum += luminance(data[i], data[i + 1], data[i + 2]) * alpha + background * (1 - alpha);
        }
      }
      cells[row * columns + col] = sum / ((y1 - y0) * (x1 - x0));
    }
  }

  // Stretch contrast to the full ramp (skipped for flat images).
  let min = Infinity;
  let max = -Infinity;
  for (const v of cells) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const stretch = range > 0.02;

  const top = ramp.length - 1;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < columns; col++) {
      let v = cells[row * columns + col];
      if (stretch) v = (v - min) / range;
      if (options.invert) v = 1 - v;
      line += ramp[Math.min(top, Math.max(0, Math.round(v * top)))];
    }
    lines.push(line);
  }
  return lines.join("\n");
}
