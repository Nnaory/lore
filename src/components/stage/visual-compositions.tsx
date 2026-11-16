/**
 * LessonVisualBoard — a lesson illustrated on the stage canvas.
 *
 * Draws the lesson's visual spec (see lib/types/visual.ts) and animates it
 * step by step: arrows draw from tail to head, diagram boxes appear in
 * reading order with their connections, table rows and formula terms
 * reveal one at a time. Layout maths lives in visual-layout.ts; this file
 * only paints. Labels are SVG/HTML text, so they are always exact.
 */

import { useId, type CSSProperties } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { DiagramVisual, FormulaVisual, LessonVisual, PlotVisual, TableVisual, VectorsVisual, VisualTone } from "@/lib/types/visual";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./canvas-layout";
import { Field, GOLD, GOLD_DIM, lessonHeading, TEXT, TEXT_DIM, VOID, type LessonStep } from "./compositions";
import {
  boxEdgePoint,
  center,
  layoutDiagram,
  niceStep,
  plotProjection,
  ticks,
  TONE_COLORS,
  toneAt,
  vectorLabelPosition,
  vectorsProjection,
  visualDuration,
  type Area,
} from "./visual-layout";

const MONO = "var(--font-mono), monospace";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 → 1 over [start, start + length] frames. */
function progress(frame: number, start: number, length: number): number {
  return interpolate(frame, [start, start + length], [0, 1], clamp);
}

/** Readable text over lines and grid: a dark outline behind the glyphs. */
const halo = { paintOrder: "stroke", stroke: VOID, strokeWidth: 5, strokeLinejoin: "round" } as const;

function ArrowMarkers({ prefix }: { prefix: string }) {
  return (
    <defs>
      {(Object.keys(TONE_COLORS) as VisualTone[]).map((tone) => (
        <marker
          key={tone}
          id={`${prefix}-${tone}`}
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={TONE_COLORS[tone]} />
        </marker>
      ))}
    </defs>
  );
}

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
    >
      {children}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// vectors
// ---------------------------------------------------------------------------

function VectorsView({ visual, area }: { visual: VectorsVisual; area: Area }) {
  const frame = useCurrentFrame();
  const markers = useId().replace(/:/g, "");
  const { bounds, toPx } = vectorsProjection(visual, area);
  const step = niceStep(Math.max(bounds.xMax - bounds.xMin, bounds.yMax - bounds.yMin), 10);
  const xs = ticks(bounds.xMin, bounds.xMax, step);
  const ys = ticks(bounds.yMin, bounds.yMax, step);
  const labelEvery = Math.max(xs.length, ys.length) > 14 ? 2 : 1;
  const grid = progress(frame, 0, 15);
  const origin = toPx([0, 0]);
  const vectorsEnd = 15 + visual.vectors.length * 18;

  return (
    <Svg>
      <ArrowMarkers prefix={markers} />
      <g opacity={grid}>
        {xs.map((x) => (
          <line key={`gx${x}`} x1={toPx([x, bounds.yMin]).x} x2={toPx([x, bounds.yMin]).x} y1={toPx([x, bounds.yMin]).y} y2={toPx([x, bounds.yMax]).y} stroke={GOLD} strokeOpacity={x === 0 ? 0 : 0.08} />
        ))}
        {ys.map((y) => (
          <line key={`gy${y}`} x1={toPx([bounds.xMin, y]).x} x2={toPx([bounds.xMax, y]).x} y1={toPx([bounds.xMin, y]).y} y2={toPx([bounds.xMin, y]).y} stroke={GOLD} strokeOpacity={y === 0 ? 0 : 0.08} />
        ))}
        <line x1={toPx([bounds.xMin, 0]).x} x2={toPx([bounds.xMax, 0]).x} y1={origin.y} y2={origin.y} stroke={TEXT_DIM} strokeOpacity={0.6} strokeWidth={2} />
        <line x1={origin.x} x2={origin.x} y1={toPx([0, bounds.yMin]).y} y2={toPx([0, bounds.yMax]).y} stroke={TEXT_DIM} strokeOpacity={0.6} strokeWidth={2} />
        <text x={toPx([bounds.xMax, 0]).x - 6} y={origin.y - 10} fill={TEXT_DIM} fontSize={18} textAnchor="end" fontStyle="italic">x</text>
        <text x={origin.x + 10} y={toPx([0, bounds.yMax]).y + 18} fill={TEXT_DIM} fontSize={18} fontStyle="italic">y</text>
        {xs.filter((x, i) => x !== 0 && i % labelEvery === 0).map((x) => (
          <text key={`tx${x}`} x={toPx([x, 0]).x} y={origin.y + 22} fill={TEXT_DIM} fontSize={14} textAnchor="middle" style={halo}>{x}</text>
        ))}
        {ys.filter((y, i) => y !== 0 && i % labelEvery === 0).map((y) => (
          <text key={`ty${y}`} x={origin.x - 10} y={toPx([0, y]).y + 5} fill={TEXT_DIM} fontSize={14} textAnchor="end" style={halo}>{y}</text>
        ))}
        <text x={origin.x - 10} y={origin.y + 22} fill={TEXT_DIM} fontSize={14} textAnchor="end">0</text>
      </g>

      {visual.vectors.map((v, i) => {
        const start = 15 + i * 18;
        const p = progress(frame, start, 18);
        if (p <= 0) return null;
        const from = toPx(v.from);
        const to = toPx(v.to);
        const head = { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
        const tone = toneAt(i, v.tone);
        const at = vectorLabelPosition(from, to, 22);
        return (
          <g key={i}>
            <line
              x1={from.x}
              y1={from.y}
              x2={head.x}
              y2={head.y}
              stroke={TONE_COLORS[tone]}
              strokeWidth={tone === "muted" ? 3 : 4.5}
              strokeDasharray={tone === "muted" ? "10 8" : undefined}
              strokeLinecap="round"
              markerEnd={`url(#${markers}-${tone})`}
            />
            {v.label && (
              <text x={at.x} y={at.y + 7} fill={TONE_COLORS[tone]} fontSize={22} fontWeight={600} textAnchor="middle" opacity={progress(frame, start + 12, 10)} style={halo}>
                {v.label}
              </text>
            )}
          </g>
        );
      })}

      {visual.points?.map((pt, i) => {
        const appear = progress(frame, vectorsEnd + i * 6, 10);
        const at = toPx(pt.at);
        return (
          <g key={`p${i}`} opacity={appear}>
            <circle cx={at.x} cy={at.y} r={6 + (1 - appear) * 6} fill={TEXT} />
            {pt.label && (
              <text x={at.x + 12} y={at.y - 12} fill={TEXT} fontSize={20} style={halo}>
                {pt.label}
              </text>
            )}
          </g>
        );
      })}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// plot
// ---------------------------------------------------------------------------

function PlotView({ visual, area }: { visual: PlotVisual; area: Area }) {
  const frame = useCurrentFrame();
  const inner = { x: area.x + 70, y: area.y + 10, w: area.w - 90, h: area.h - 60 };
  const { bounds, toPx, frame: box } = plotProjection(visual.series.flatMap((s) => s.points), inner);
  const xs = ticks(bounds.xMin, bounds.xMax, niceStep(bounds.xMax - bounds.xMin, 7));
  const ys = ticks(bounds.yMin, bounds.yMax, niceStep(bounds.yMax - bounds.yMin, 5));
  const axes = progress(frame, 0, 15);
  const labelled = visual.series.some((s) => s.label);

  return (
    <Svg>
      <g opacity={axes}>
        {ys.map((y) => (
          <g key={`y${y}`}>
            <line x1={box.x} x2={box.x + box.w} y1={toPx([bounds.xMin, y]).y} y2={toPx([bounds.xMin, y]).y} stroke={GOLD} strokeOpacity={0.08} />
            <text x={box.x - 12} y={toPx([bounds.xMin, y]).y + 5} fill={TEXT_DIM} fontSize={15} textAnchor="end">{y}</text>
          </g>
        ))}
        {xs.map((x) => (
          <text key={`x${x}`} x={toPx([x, bounds.yMin]).x} y={box.y + box.h + 24} fill={TEXT_DIM} fontSize={15} textAnchor="middle">{x}</text>
        ))}
        <path d={`M ${box.x} ${box.y} V ${box.y + box.h} H ${box.x + box.w}`} fill="none" stroke={TEXT_DIM} strokeOpacity={0.6} strokeWidth={2} />
        {visual.x_label && (
          <text x={box.x + box.w} y={box.y + box.h + 50} fill={TEXT_DIM} fontSize={18} textAnchor="end">{visual.x_label}</text>
        )}
        {visual.y_label && (
          <text x={box.x} y={box.y - 14} fill={TEXT_DIM} fontSize={18} textAnchor="middle">{visual.y_label}</text>
        )}
      </g>

      {visual.series.map((s, i) => {
        const tone = toneAt(i, s.tone);
        const p = progress(frame, 20 + i * 30, 30);
        const sorted = [...s.points].sort((a, b) => a[0] - b[0]);
        const d = sorted.map((pt, j) => `${j === 0 ? "M" : "L"} ${toPx(pt).x} ${toPx(pt).y}`).join(" ");
        const showDots = sorted.length <= 15;
        return (
          <g key={i}>
            <path d={d} fill="none" stroke={TONE_COLORS[tone]} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />
            {showDots &&
              sorted.map((pt, j) => (
                <circle key={j} cx={toPx(pt).x} cy={toPx(pt).y} r={5} fill={TONE_COLORS[tone]} opacity={p >= (j + 0.5) / sorted.length ? 1 : 0} />
              ))}
          </g>
        );
      })}

      {labelled && (
        <g opacity={progress(frame, 20 + visual.series.length * 30, 12)}>
          {visual.series.map((s, i) =>
            s.label ? (
              <g key={i} transform={`translate(${box.x + box.w - 220}, ${box.y + 10 + i * 30})`}>
                <rect width={22} height={6} y={-4} rx={3} fill={TONE_COLORS[toneAt(i, s.tone)]} />
                <text x={32} y={4} fill={TEXT} fontSize={18}>{s.label}</text>
              </g>
            ) : null
          )}
        </g>
      )}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// diagram
// ---------------------------------------------------------------------------

function DiagramView({ visual, area }: { visual: DiagramVisual; area: Area }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const markers = useId().replace(/:/g, "");
  const nodes = layoutDiagram(visual, area);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nodeStart = (order: number) => 10 + order * 8;

  return (
    <>
      <Svg>
        <ArrowMarkers prefix={markers} />
        {visual.edges.map((e, i) => {
          const a = byId.get(e.from)!;
          const b = byId.get(e.to)!;
          const from = boxEdgePoint(a.box, center(b.box), 4);
          const to = boxEdgePoint(b.box, center(a.box), 8);
          const p = progress(frame, Math.max(nodeStart(a.order), nodeStart(b.order)) + 8, 16);
          // Cycles bow outwards so opposite arrows do not overlap.
          const bend = visual.layout === "cycle" ? 0.18 : 0;
          const mid = { x: (from.x + to.x) / 2 - (to.y - from.y) * bend, y: (from.y + to.y) / 2 + (to.x - from.x) * bend };
          return (
            <g key={i}>
              <path
                d={`M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`}
                fill="none"
                stroke={GOLD}
                strokeOpacity={0.75}
                strokeWidth={2.5}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - p}
                markerEnd={p > 0.95 ? `url(#${markers}-primary)` : undefined}
              />
              {e.label && (
                <text x={mid.x} y={mid.y - 8} fill={GOLD_DIM} fontSize={16} textAnchor="middle" opacity={progress(frame, nodeStart(Math.max(a.order, b.order)) + 18, 10)} style={halo}>
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
      </Svg>
      {nodes.map((n) => {
        const pop = spring({ frame: frame - nodeStart(n.order), fps, config: { damping: 14, stiffness: 140 } });
        const fontSize = Math.min(22, n.box.w / 8.5);
        return (
          <div
            key={n.id}
            style={{
              position: "absolute",
              left: n.box.x,
              top: n.box.y,
              width: n.box.w,
              height: n.box.h,
              opacity: Math.min(1, pop * 1.4),
              transform: `scale(${0.8 + 0.2 * pop})`,
              border: `2px solid ${GOLD_DIM}`,
              borderRadius: 14,
              background: "rgba(26, 20, 16, 0.92)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: "8px 12px",
              overflow: "hidden",
              boxShadow: "0 0 24px rgba(232, 197, 71, 0.08)",
            }}
          >
            <div style={{ color: TEXT, fontSize, fontWeight: 600, lineHeight: 1.2 }}>{n.label}</div>
            {n.detail && <div style={{ color: TEXT_DIM, fontSize: fontSize * 0.68, lineHeight: 1.25, marginTop: 6 }}>{n.detail}</div>}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

function TableView({ visual, area }: { visual: TableVisual; area: Area }) {
  const frame = useCurrentFrame();
  const rowHeight = Math.min(58, area.h / (visual.rows.length + 1));
  const fontSize = Math.round(rowHeight * 0.42);
  const width = Math.min(area.w, visual.headers.length * 300);
  const highlighted = new Set(visual.highlight_rows ?? []);
  // Long phrases wrap inside their cell instead of pushing the table wider.
  const cell: CSSProperties = { height: rowHeight, padding: "4px 16px", textAlign: "center", lineHeight: 1.15, overflowWrap: "anywhere" };

  return (
    <div style={{ position: "absolute", left: area.x, top: area.y, width: area.w, height: area.h, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <table style={{ width, borderCollapse: "collapse", fontSize, opacity: progress(frame, 0, 12) }}>
        <thead>
          <tr>
            {visual.headers.map((h, i) => (
              <th key={i} style={{ ...cell, color: GOLD, fontWeight: 600, borderBottom: `2px solid ${GOLD_DIM}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visual.rows.map((row, r) => {
            const appear = progress(frame, 15 + r * 6, 10);
            const hot = highlighted.has(r);
            return (
              <tr
                key={r}
                style={{
                  opacity: appear,
                  transform: `translateX(${(1 - appear) * -16}px)`,
                  background: hot ? "rgba(232, 197, 71, 0.14)" : r % 2 ? "rgba(255, 255, 255, 0.02)" : "transparent",
                  borderBottom: "1px solid rgba(58, 45, 32, 0.8)",
                }}
              >
                {row.map((value, c) => (
                  <td key={c} style={{ ...cell, color: hot ? GOLD : TEXT, fontFamily: MONO, fontWeight: hot ? 600 : 400 }}>{value}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// formula
// ---------------------------------------------------------------------------

function FormulaView({ visual, area }: { visual: FormulaVisual; area: Area }) {
  const frame = useCurrentFrame();
  const enter = progress(frame, 0, 20);
  const exampleStart = 25 + visual.terms.length * 14;
  const typed = visual.example ? Math.floor(progress(frame, exampleStart, 30) * visual.example.length) : 0;

  return (
    <div style={{ position: "absolute", left: area.x, top: area.y, width: area.w, height: area.h, display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>
      <div
        style={{
          color: TEXT,
          fontSize: visual.expression.length > 40 ? 44 : 60,
          fontFamily: MONO,
          letterSpacing: 1,
          opacity: enter,
          transform: `translateY(${(1 - enter) * 20}px)`,
          padding: "14px 36px",
          borderBottom: `2px solid ${GOLD_DIM}`,
        }}
      >
        {visual.expression}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 26, rowGap: 14, alignItems: "center", maxWidth: 940 }}>
        {visual.terms.map((t, i) => {
          const appear = progress(frame, 25 + i * 14, 12);
          return [
            <div key={`s${i}`} style={{ opacity: appear, color: GOLD, fontFamily: MONO, fontSize: 30, textAlign: "right" }}>{t.symbol}</div>,
            <div key={`m${i}`} style={{ opacity: appear, transform: `translateX(${(1 - appear) * 16}px)`, color: TEXT_DIM, fontSize: 24 }}>{t.meaning}</div>,
          ];
        })}
      </div>
      {visual.example && (
        <div
          style={{
            opacity: progress(frame, exampleStart, 6),
            marginTop: "auto",
            color: TEXT,
            fontFamily: MONO,
            fontSize: 26,
            padding: "12px 24px",
            border: `1px solid ${GOLD_DIM}`,
            borderRadius: 10,
            background: "rgba(26, 20, 16, 0.85)",
            whiteSpace: "pre",
          }}
        >
          {visual.example.slice(0, typed)}
          <span style={{ opacity: typed < visual.example.length ? 1 : 0, color: TEXT_DIM }}>▍</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/** The drawing area below the lesson title and above the caption. */
export const VISUAL_AREA: Area = { x: 90, y: 150, w: 1100, h: 470 };

export function LessonVisualView({ visual, area = VISUAL_AREA }: { visual: LessonVisual; area?: Area }) {
  switch (visual.kind) {
    case "vectors":
      return <VectorsView visual={visual} area={area} />;
    case "plot":
      return <PlotView visual={visual} area={area} />;
    case "diagram":
      return <DiagramView visual={visual} area={area} />;
    case "table":
      return <TableView visual={visual} area={area} />;
    case "formula":
      return <FormulaView visual={visual} area={area} />;
  }
}

export type LessonVisualBoardProps = { title: string; visual: LessonVisual; seed: number; step?: LessonStep };

export function LessonVisualBoard({ title, visual, seed, step }: LessonVisualBoardProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const captionAt = Math.max(10, visualDuration(visual) - 40);
  return (
    <AbsoluteFill>
      <Field seed={seed} />
      <AbsoluteFill style={{ padding: "40px 90px", opacity: enter }}>
        <div style={{ color: GOLD_DIM, fontSize: 20, letterSpacing: 8, textTransform: "uppercase" }}>{lessonHeading(step)}</div>
        <div style={{ color: GOLD, fontSize: 38, fontWeight: 600, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </div>
      </AbsoluteFill>
      <LessonVisualView visual={visual} />
      {visual.caption && (
        <div
          style={{
            position: "absolute",
            left: 90,
            right: 90,
            bottom: 34,
            textAlign: "center",
            color: TEXT,
            fontSize: 22,
            lineHeight: 1.35,
            opacity: progress(frame, captionAt, 15),
          }}
        >
          {visual.caption}
        </div>
      )}
    </AbsoluteFill>
  );
}
