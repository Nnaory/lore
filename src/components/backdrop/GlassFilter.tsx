/**
 * GlassFilter — the displacement map behind liquid glass (#lore-liquid-glass).
 *
 * Rendered once by the root layout. Only Chromium can run an SVG filter inside
 * backdrop-filter; there, the root layout's inline script adds `liquid` to
 * <html> before the first paint and every .lore-glass panel refracts what is
 * behind it through this filter. Elsewhere the panels are plain frosted glass.
 */

export function GlassFilter() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <filter id="lore-liquid-glass" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.007 0.011" numOctaves={2} seed={11} result="noise" />
        <feGaussianBlur in="noise" stdDeviation={2} result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={40} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
