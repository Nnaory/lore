'use client';

/** Decorative jack-o'-lanterns behind a screen. Positions are part of each screen's spec. */
import { useMemo } from 'react';
import { pumpkin } from '@/lib/ascii';
import { AsciiArt } from './AsciiArt';

export interface PumpkinPlacement {
  x: number;
  y: number;
  /** cell size in px */
  fs: number;
  /** body width in cells */
  w: number;
  seed: number;
}

export const PUMPKINS_PREP_DESKTOP: PumpkinPlacement[] = [
  { x: 1110, y: 60, fs: 10, w: 30, seed: 3 },
  { x: 1190, y: 330, fs: 12, w: 26, seed: 9 },
  { x: 1080, y: 640, fs: 8, w: 14, seed: 5 },
  { x: 1260, y: 700, fs: 10, w: 18, seed: 12 },
  { x: 40, y: 40, fs: 8, w: 18, seed: 2 },
  { x: 120, y: 260, fs: 10, w: 22, seed: 6 },
  { x: -60, y: 560, fs: 12, w: 26, seed: 10 },
  { x: 230, y: 760, fs: 8, w: 12, seed: 4 },
];

export function PumpkinField({ items, className }: { items: PumpkinPlacement[]; className?: string }) {
  const art = useMemo(() => items.map((p) => ({ ...p, layers: pumpkin(p.w, p.seed) })), [items]);
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}>
      {art.map((p, i) => (
        <AsciiArt key={i} layers={p.layers} fontPx={p.fs} style={{ position: 'absolute', left: p.x, top: p.y }} />
      ))}
    </div>
  );
}
