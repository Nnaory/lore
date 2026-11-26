/**
 * Remotion compositions for the stage canvas (rendered client-side by
 * @remotion/player — no video files). Each is driven only by its props,
 * so the same story data always produces the same animation.
 *
 *   AmbientScene  — location/chapter title over a drifting gold field
 *   LessonBoard   — a lesson's title and text revealed word by word
 *   DecisionGraph — a question node and the question itself (the fallback canvas of a puzzle
 *                   that has no visual of its own; answers are chips under the canvas)
 */

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { CANVAS_HEIGHT, CANVAS_WIDTH, DECISION_NODE } from "./canvas-layout";

// Kit tokens (lore-tokens.css) as the canvas needs them. Decision OQ-9 / D9: only colour,
// gradient and shadow follow the tokens; geometry, data, labels and numbers are unchanged.
// The constant names are kept so the compositions read the same as before.
export const GOLD = "var(--color-gold)";
export const GOLD_DIM = "color-mix(in srgb, var(--color-gold) 70%, var(--color-ink))";
export const TEXT = "var(--color-cream)";
export const TEXT_DIM = "var(--color-muted)";
export const VOID = "var(--color-ink)";
/** Fill of boxes and nodes drawn on the canvas. */
export const SURFACE = "var(--color-smoke)";

/** Deterministic pseudo-random numbers in [0, 1) from a seed. */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** The drifting gold background shared by every scene. */
export function Field({ seed }: { seed: number }) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: VOID }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} style={{ position: "absolute", inset: 0 }}>
        {Array.from({ length: 9 }, (_, i) => (
          <line
            key={`h${i}`}
            x1={0}
            x2={CANVAS_WIDTH}
            y1={((i * 90 + frame * 0.4) % CANVAS_HEIGHT)}
            y2={((i * 90 + frame * 0.4) % CANVAS_HEIGHT)}
            stroke={GOLD}
            strokeOpacity={0.04}
          />
        ))}
        {Array.from({ length: 28 }, (_, i) => {
          const s = seed * 100 + i;
          const x = rand(s) * CANVAS_WIDTH;
          const y = (rand(s + 0.5) * CANVAS_HEIGHT - frame * (0.3 + rand(s + 1) * 0.6) + CANVAS_HEIGHT) % CANVAS_HEIGHT;
          const r = 1 + rand(s + 2) * 2.5;
          const twinkle = 0.25 + 0.35 * Math.abs(Math.sin((frame + i * 13) / 25));
          return <circle key={i} cx={x} cy={y} r={r} fill={GOLD} opacity={twinkle} />;
        })}
      </svg>
    </AbsoluteFill>
  );
}

export type AmbientSceneProps = {
  title: string;
  subtitle?: string;
  seed: number;
};

export function AmbientScene({ title, subtitle, seed }: AmbientSceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill>
      <Field seed={seed} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 80 }}>
        <div style={{ opacity: enter, transform: `translateY(${(1 - enter) * 24}px)` }}>
          {subtitle && (
            <div style={{ color: GOLD_DIM, fontSize: 26, letterSpacing: 10, textTransform: "uppercase", marginBottom: 18 }}>
              {subtitle}
            </div>
          )}
          <div style={{ color: TEXT, fontSize: 64, fontWeight: 600, letterSpacing: 2, lineHeight: 1.15 }}>{title}</div>
          <div
            style={{
              height: 2,
              margin: "28px auto 0",
              width: interpolate(frame, [10, 50], [0, 320], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              background: GOLD,
            }}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** Position of a lesson within its concept's steps (index is zero-based). */
export type LessonStep = { index: number; total: number };

/** "Lesson", or "Lesson · 2 / 4" when a concept is taught in several steps. */
export function lessonHeading(step?: LessonStep): string {
  return step && step.total > 1 ? `Lesson · ${step.index + 1} / ${step.total}` : "Lesson";
}

export type LessonBoardProps = { title: string; body: string; seed: number; step?: LessonStep };

/** Frames needed to reveal a lesson of this length. */
export function lessonDuration(body: string): number {
  const words = body.split(/\s+/).filter(Boolean).length;
  return Math.min(30 + Math.ceil(words * 1.6) + 30, 900);
}

export function LessonBoard({ title, body, seed, step }: LessonBoardProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const words = body.split(/(\s+)/);
  const shown = Math.floor(interpolate(frame, [20, 20 + words.length * 0.8], [0, words.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <AbsoluteFill>
      <Field seed={seed} />
      <AbsoluteFill style={{ padding: "60px 90px", opacity: enter }}>
        <div style={{ color: GOLD_DIM, fontSize: 22, letterSpacing: 8, textTransform: "uppercase" }}>{lessonHeading(step)}</div>
        <div style={{ color: GOLD, fontSize: 44, fontWeight: 600, marginTop: 10 }}>{title}</div>
        <div
          style={{
            height: 2,
            width: interpolate(frame, [5, 35], [0, 260], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            background: GOLD,
            opacity: 0.6,
            margin: "18px 0 26px",
          }}
        />
        <div style={{ color: TEXT, fontSize: 30, lineHeight: 1.5, whiteSpace: "pre-wrap", overflow: "hidden" }}>
          {words.slice(0, shown).join("")}
          {shown < words.length && <span style={{ color: TEXT_DIM }}>▍</span>}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

export type DecisionGraphProps = {
  /** The question, drawn large under the node. Empty draws the node alone. */
  label: string;
  seed: number;
};

export const DECISION_DURATION = 50;

export function DecisionGraph({ label, seed }: DecisionGraphProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const node = { x: (DECISION_NODE.x / 100) * CANVAS_WIDTH, y: (DECISION_NODE.y / 100) * CANVAS_HEIGHT };
  const nodeIn = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  const textIn = interpolate(frame, [12, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <Field seed={seed} />
      <svg width="100%" height="100%" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} style={{ position: "absolute", inset: 0 }}>
        <circle cx={node.x} cy={node.y} r={34 * nodeIn} fill={SURFACE} stroke={GOLD} strokeWidth={2} />
        <circle
          cx={node.x}
          cy={node.y}
          r={(34 + 10 * Math.abs(Math.sin(frame / 12))) * nodeIn}
          fill="none"
          stroke={GOLD}
          strokeOpacity={0.25}
        />
        <text x={node.x} y={node.y + 12} fill={GOLD} fontSize={34} fontWeight={700} textAnchor="middle" opacity={nodeIn}>
          ?
        </text>
      </svg>
      <AbsoluteFill style={{ alignItems: "center" }}>
        <div
          style={{
            marginTop: node.y + 70,
            color: TEXT,
            fontSize: 44,
            lineHeight: 1.3,
            maxWidth: 1040,
            textAlign: "center",
            opacity: textIn,
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 5,
            overflow: "hidden",
          }}
        >
          {label}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
