/**
 * Draws the SHAPE of a highlighted answer inside the canvas (DESIGN-SYSTEM §4.9).
 * Design viewBox is 450 × 200; scale with width/height. It never shows right/wrong.
 * Kinds come from PreviewSpec: vector2d · scalar · matrix · text.
 */
import type { PreviewSpec } from '@/lib/schemas/visual';

const C = { ink: 'var(--color-ink)', smoke: 'var(--color-smoke)', gold: 'var(--color-gold)', ember: 'var(--color-ember)', cream: 'var(--color-cream)', muted: 'var(--color-muted)' };

function Grid() {
  const v = [];
  for (let x = 40; x <= 440; x += 40) v.push(<path key={`x${x}`} d={`M${x} 10 V190`} stroke={C.smoke} strokeWidth={1} />);
  for (let y = 20; y <= 180; y += 40) v.push(<path key={`y${y}`} d={`M10 ${y} H440`} stroke={C.smoke} strokeWidth={1} />);
  return <>{v}</>;
}

export function ShapePreview({ spec, emptyText, phone = false, width = 450, height = 200 }: { spec: PreviewSpec | null | undefined; emptyText: string; phone?: boolean; width?: number; height?: number }) {
  const fs = phone ? 15 : 12;
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox="0 0 450 200" className="font-mono">
      <Grid />
      {!spec && (
        <text x={225} y={106} textAnchor="middle" fill={C.muted} fontSize={fs}>{emptyText}</text>
      )}
      {spec?.kind === 'vector2d' && <Vector x={spec.x} y={spec.y} fs={fs} phone={phone} />}
      {spec?.kind === 'scalar' && <Scalar value={spec.value} fs={fs} phone={phone} />}
      {spec?.kind === 'matrix' && <Matrix rows={spec.rows} phone={phone} />}
      {spec?.kind === 'text' && (
        <text x={225} y={112} textAnchor="middle" fill={C.cream} fontSize={phone ? 26 : 22} fontWeight={700}>{spec.text}</text>
      )}
    </svg>
  );
}

/** Origin at (40,180); unit fits the larger component into 400×160 (max 40px per unit). */
function Vector({ x, y, fs, phone }: { x: number; y: number; fs: number; phone: boolean }) {
  const unit = Math.min(40, 400 / Math.max(Math.abs(x), 1), 160 / Math.max(Math.abs(y), 1));
  const ox = x < 0 ? 410 : 40, oy = y < 0 ? 20 : 180;
  const tx = ox + x * unit, ty = oy - y * unit;
  const ang = Math.atan2(ty - oy, tx - ox), h = 14;
  const p1 = `${tx - h * Math.cos(ang - 0.45)},${ty - h * Math.sin(ang - 0.45)}`, p2 = `${tx - h * Math.cos(ang + 0.45)},${ty - h * Math.sin(ang + 0.45)}`;
  return (
    <>
      <path d={`M${ox} ${oy} H${x < 0 ? 10 : 440} M${ox} ${oy} V${y < 0 ? 196 : 14}`} stroke={C.muted} strokeOpacity={0.6} strokeWidth={1.5} />
      <path d={`M${tx} ${oy} V${ty} M${ox} ${ty} H${tx}`} stroke={C.gold} strokeWidth={1.5} strokeDasharray="4 5" />
      <path d={`M${ox} ${oy} L${tx} ${ty}`} stroke={C.ember} strokeWidth={phone ? 3.5 : 3} />
      <polygon points={`${tx},${ty} ${p1} ${p2}`} fill={C.ember} />
      <text x={tx - 4} y={oy + 16} fill={C.gold} fontSize={fs}>{x}</text>
      <text x={ox - 16} y={ty + 5} fill={C.gold} fontSize={fs}>{y}</text>
    </>
  );
}

/** Number line with 11 ticks around the value (0…10 when the value fits). */
function Scalar({ value, phone }: { value: number; fs: number; phone: boolean }) {
  const start = value >= 0 && value <= 10 ? 0 : Math.floor(value) - 5;
  const ticks = Array.from({ length: 11 }, (_, i) => start + i);
  const px = 24 + (value - start) * 40;
  return (
    <>
      <path d="M24 120 H432" stroke={C.muted} strokeOpacity={0.7} strokeWidth={phone ? 2 : 1.5} />
      {ticks.map((n, i) => (
        <g key={n}>
          <path d={`M${24 + i * 40} 114 V126`} stroke={C.muted} strokeOpacity={0.7} strokeWidth={phone ? 2 : 1.5} />
          {(!phone || i % 2 === 0) && <text x={20 + i * 40} y={phone ? 146 : 142} fill={C.muted} fontSize={phone ? 14 : 11}>{n}</text>}
        </g>
      ))}
      <circle cx={px} cy={120} r={phone ? 9 : 7} fill={C.ember} />
      {!phone && <text x={px - 14} y={100} fill={C.ember} fontSize={13} fontWeight={700}>{value}</text>}
    </>
  );
}

/** rows × cols boxes inside square brackets; a dashed gold measure line + "n rows" label. */
function Matrix({ rows, phone }: { rows: (number | string)[][]; phone: boolean }) {
  const r = rows.length, c = Math.max(...rows.map((x) => x.length));
  const bw = 70, bh = 42, gap = 8;
  const W = c * bw + (c - 1) * gap, H = r * bh + (r - 1) * gap;
  const x0 = 225 - W / 2, y0 = 100 - H / 2;
  return (
    <>
      <path d={`M${x0 - 12} ${y0 - 6} H${x0 - 20} V${y0 + H + 6} H${x0 - 12} M${x0 + W + 12} ${y0 - 6} H${x0 + W + 20} V${y0 + H + 6} H${x0 + W + 12}`} stroke={C.cream} strokeWidth={phone ? 2.5 : 2} fill="none" />
      {rows.map((row, i) =>
        row.map((v, j) => (
          <g key={`${i}-${j}`}>
            <rect x={x0 + j * (bw + gap)} y={y0 + i * (bh + gap)} width={bw} height={bh} fill="none" stroke={C.ember} strokeWidth={phone ? 2.5 : 2} />
            <text x={x0 + j * (bw + gap) + bw / 2} y={y0 + i * (bh + gap) + bh / 2 + 6} textAnchor="middle" fill={C.cream} fontSize={phone ? 20 : 16} fontWeight={700}>{v}</text>
          </g>
        )),
      )}
      <path d={`M${x0 + W + 40} ${y0} V${y0 + H}`} stroke={C.gold} strokeWidth={1.5} strokeDasharray="4 5" />
      <text x={x0 + W + 50} y={100} fill={C.gold} fontSize={phone ? 15 : 12}>{`${r}×${c}`}</text>
    </>
  );
}
