/**
 * GlassScope — a wrapper that turns on liquid glass for everything inside it.
 *
 * .lore-glass panels are frosted (blur + saturate) everywhere. Only Chromium
 * can also run an SVG filter inside backdrop-filter, so there the wrapper gets
 * the `liquid` class and the panels refract what is behind them through the
 * displacement map defined here (#lore-liquid-glass). The class is added after
 * hydration, so the server and the first client render match.
 */

"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const noSubscribe = () => () => {};
const isChromium = () => /Chrome\//.test(navigator.userAgent);

export function GlassScope({ className = "", children }: { className?: string; children: ReactNode }) {
  const liquid = useSyncExternalStore(noSubscribe, isChromium, () => false);
  return (
    <div className={liquid ? `${className} liquid` : className}>
      <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
        <filter id="lore-liquid-glass" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.007 0.011" numOctaves={2} seed={11} result="noise" />
          <feGaussianBlur in="noise" stdDeviation={2} result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={40} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      {children}
    </div>
  );
}
