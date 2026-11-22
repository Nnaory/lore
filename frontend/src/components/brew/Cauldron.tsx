'use client';

/** Hazel's cauldron, 64 × 26 cells, 4 frames at 250 ms. Static frame 0 for reduced motion. */
import { useEffect, useMemo, useState } from 'react';
import { CAULDRON_FRAMES, CAULDRON_FRAME_MS, cauldron } from '@/lib/ascii';
import { useReducedMotion } from '@/lib/hooks/media';
import { AsciiArt } from '@/components/ascii/AsciiArt';

export function Cauldron({ fontPx, className, style }: { fontPx: number; className?: string; style?: React.CSSProperties }) {
  const frames = useMemo(() => Array.from({ length: CAULDRON_FRAMES }, (_, i) => cauldron(i)), []);
  const reduce = useReducedMotion();
  const [f, setF] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setF((x) => (x + 1) % CAULDRON_FRAMES), CAULDRON_FRAME_MS);
    return () => clearInterval(id);
  }, [reduce]);
  return <AsciiArt layers={frames[reduce ? 0 : f]} fontPx={fontPx} className={className} style={style} />;
}
