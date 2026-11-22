'use client';

/**
 * Renders a design frame at its exact px size and scales it as ONE unit to fit the viewport
 * (DESIGN-SYSTEM §4.0). Children use the absolute px boxes from the spec — never re-flow them.
 *   desktop: <ScaledBoard w={1440} h={900}>   phone: <ScaledBoard w={390} h={844} fit="width">
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function ScaledBoard({ w, h, fit = 'contain', children, className }: { w: number; h: number; fit?: 'contain' | 'width'; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setScale(fit === 'width' ? width / w : Math.min(width / w, height / h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h, fit]);
  return (
    <div ref={ref} className={`relative w-full overflow-hidden bg-ink ${fit === 'contain' ? 'h-dvh' : ''} ${className ?? ''}`} style={fit === 'width' ? { height: h * scale } : undefined}>
      <div className="absolute left-1/2 top-0 origin-top" style={{ width: w, height: h, transform: `translateX(-50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
