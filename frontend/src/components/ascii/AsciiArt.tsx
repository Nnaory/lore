'use client';

/**
 * Renders a stack of ASCII layers (from lib/ascii) at an exact cell grid.
 *
 * - <AsciiArt>  : <canvas>, one fillText per glyph at col * cellW → pixel-identical columns even
 *                 when a glyph comes from a fallback font. '█' is drawn as a filled rect (no gaps).
 * - <AsciiPre>  : DOM fallback (stacked <pre>) — exactly what the design canvas uses. Good for
 *                 server rendering, print and tests. Visually identical when JetBrains Mono loads.
 *
 * Sizing: pass `fontPx` for a fixed size (design spec), or `fitWidth` to scale the cell size to
 * the container width (cellW = width / cols). Height always = rows * fontPx.
 * Optional pixelRatio overrides the canvas resolution (task 1.4); omitted = unchanged Kit behaviour.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CELL_ASPECT, layerSize, type Layer } from '@/lib/ascii';

interface Props {
  layers: Layer[];
  /** Cell height in px (= font size = line height). Ignored when `fitWidth` is set. */
  fontPx?: number;
  /** Scale to the parent's width instead of a fixed font size. */
  fitWidth?: boolean;
  /** Accessible name. Omit for decorative art (then aria-hidden). */
  label?: string;
  /** Canvas backing-store scale. Default (omitted): min(devicePixelRatio, 2), the Kit behaviour.
   *  ScaledBoard passes min(devicePixelRatio * boardScale, 4) so art stays sharp when scaled up. */
  pixelRatio?: number;
  className?: string;
  style?: CSSProperties;
}

export function AsciiArt({ layers, fontPx = 10, fitWidth = false, label, pixelRatio, className, style }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { cols, rows } = useMemo(() => layerSize(layers), [layers]);
  // Only the measured parent width is state; the cell size is derived from it.
  const [measuredW, setMeasuredW] = useState(0);
  const px = fitWidth && measuredW > 0 && cols > 0 ? measuredW / cols / CELL_ASPECT : fontPx;

  useEffect(() => {
    if (!fitWidth) return;
    const el = wrapRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setMeasuredW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cols) return;
    let cancelled = false;
    const family = getComputedStyle(canvas).fontFamily || '"JetBrains Mono", monospace';
    const font = `${px}px ${family}`;
    const draw = () => {
      if (cancelled) return;
      const dpr = pixelRatio && pixelRatio > 0 ? pixelRatio : Math.min(window.devicePixelRatio || 1, 2);
      const cw = px * CELL_ASPECT;
      canvas.width = Math.ceil(cols * cw * dpr);
      canvas.height = Math.ceil(rows * px * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cols * cw, rows * px);
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (const layer of layers) {
        ctx.globalAlpha = layer.op;
        ctx.fillStyle = layer.color;
        const lines = layer.text.split('\n');
        for (let r = 0; r < lines.length; r++) {
          const line = lines[r];
          for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            if (ch === ' ') continue;
            if (ch === '█') ctx.fillRect(c * cw, r * px, cw + 0.5, px + 0.5);
            else ctx.fillText(ch, c * cw + cw / 2, r * px + px / 2);
          }
        }
      }
      ctx.globalAlpha = 1;
    };
    // Wait for JetBrains Mono so glyph shapes match the design.
    (document.fonts?.load(font) ?? Promise.resolve()).then(draw, draw);
    return () => {
      cancelled = true;
    };
  }, [layers, px, cols, rows, pixelRatio]);

  const w = cols * px * CELL_ASPECT;
  const h = rows * px;
  return (
    <div ref={wrapRef} className={className} style={{ width: fitWidth ? '100%' : w, height: h, ...style }}>
      <canvas
        ref={canvasRef}
        className="font-mono block"
        style={{ width: w, height: h }}
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      />
    </div>
  );
}

/** DOM version: stacked <pre>, one per layer (same as the design canvas). */
export function AsciiPre({ layers, fontPx = 10, label, className, style }: Omit<Props, 'fitWidth' | 'pixelRatio'>) {
  const { cols, rows } = layerSize(layers);
  return (
    <div
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ position: 'relative', width: cols * fontPx * CELL_ASPECT, height: rows * fontPx, ...style }}
    >
      {layers.map((l, i) => (
        <pre
          key={i}
          aria-hidden
          className="font-mono"
          style={{
            position: 'absolute', inset: 0, margin: 0, whiteSpace: 'pre',
            fontSize: fontPx, lineHeight: `${fontPx}px`, color: l.color, opacity: l.op,
          }}
        >
          {l.text}
        </pre>
      ))}
    </div>
  );
}
