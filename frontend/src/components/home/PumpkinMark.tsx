/**
 * PumpkinMark — LORE's mark on the Halloween home: a pumpkin of glass (the
 * ASCII pumpkins drifting behind it blur and, in Chromium, bend through it)
 * with ribs, a stem and a carved face lit from within.
 *
 * The glass is cut to the pumpkin's shape by /pumpkin-mark.svg (a CSS mask,
 * see .lore-pumpkin-mark); this SVG draws the same shape on top, tinted.
 * Decorative: the page heading names the site.
 */

const LOBES = [
  { cx: 25, cy: 64, rx: 21, ry: 31 },
  { cx: 95, cy: 64, rx: 21, ry: 31 },
  { cx: 42, cy: 63, rx: 24, ry: 36 },
  { cx: 78, cy: 63, rx: 24, ry: 36 },
  { cx: 60, cy: 62, rx: 22, ry: 38 },
];

export function PumpkinMark() {
  return (
    <div className="lore-pumpkin-mark" aria-hidden="true">
      <svg viewBox="0 0 120 104" className="absolute inset-0 h-full w-full" focusable="false">
        <defs>
          <linearGradient id="lore-mark-skin" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f68928" />
            <stop offset="1" stopColor="#c83e3e" />
          </linearGradient>
          <filter id="lore-mark-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Tinted as one layer, so the overlapping lobes don't darken each other. */}
        <g fill="url(#lore-mark-skin)" opacity={0.42}>
          {LOBES.map((l) => (
            <ellipse key={`${l.cx}`} {...l} />
          ))}
        </g>
        <path d="M55 26 C55 17 56 11 61 6 C63 4 67 5 66 8 C63 12 62 18 63 26 Z" fill="#5c4426" fillOpacity={0.85} />
        <g fill="none" stroke="#7a2f1c" strokeOpacity={0.55} strokeWidth={1.6} strokeLinecap="round">
          <path d="M52 26 C42 40 42 86 52 99" />
          <path d="M68 26 C78 40 78 86 68 99" />
          <path d="M37 29 C24 44 24 84 37 97" />
          <path d="M83 29 C96 44 96 84 83 97" />
        </g>
        <g className="lore-pumpkin-face" fill="#f6c84e" filter="url(#lore-mark-glow)">
          <path d="M36 58 L50 58 L43 45 Z" />
          <path d="M70 58 L84 58 L77 45 Z" />
          <path d="M56 68 L64 68 L60 61 Z" />
          <path d="M31 72 L39 77 L45 73 L52 79 L60 75 L68 79 L75 73 L81 77 L89 72 Q85 91 60 93 Q35 91 31 72 Z" />
        </g>
      </svg>
    </div>
  );
}
