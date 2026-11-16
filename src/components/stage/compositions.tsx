/**
 * Remotion compositions for the stage canvas (rendered client-side by
 * @remotion/player — no video files). Each is driven only by its props,
 * so the same story data always produces the same animation.
 *
 *   AmbientScene  — location/chapter title over a drifting gold field,
 *                   with the player's ASCII avatar in the corner
 *   LessonBoard   — a lesson's title and text revealed word by word
 *   DecisionGraph — a question node with lines to the answer boxes
 *                   (answers themselves are clickable HTML overlays),
 *                   watched by the player's avatar
 */

import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { MONO_CELL_ASPECT } from "@/lib/ascii/image-to-ascii";
import { CANVAS_HEIGHT, CANVAS_WIDTH, DECISION_NODE, choiceBoxes } from "./canvas-layout";

const GOLD = "#e8c547";
const GOLD_DIM = "#b89636";
const TEXT = "#f0ebe0";
const TEXT_DIM = "#a8a090";
const VOID = "#0a0a0c";

/** Deterministic pseudo-random numbers in [0, 1) from a seed. */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function Field({ seed }: { seed: number }) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 35%, #1a1410 0%, ${VOID} 70%)` }}>
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

/**
 * The player's ASCII avatar, revealed top to bottom like a scanline and
 * gently bobbing, fitted inside `box` (canvas pixels) with a "YOU" label.
 */
function PlayerFigure({ art, box }: { art: string; box: { x: number; y: number; w: number; h: number } }) {
  const frame = useCurrentFrame();
  const lines = art.split("\n");
  const columns = Math.max(1, ...lines.map((l) => l.length));
  const labelSpace = 34;
  const fontSize = Math.min(22, box.w / (columns * MONO_CELL_ASPECT), (box.h - labelSpace) / lines.length);
  const revealed = interpolate(frame, [4, 4 + lines.length * 1.2], [0, lines.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bob = Math.sin(frame / 22) * 3;
  return (
    <div
      data-testid="canvas-player-avatar"
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono), monospace",
          fontSize,
          lineHeight: 1,
          whiteSpace: "pre",
          color: GOLD,
          textShadow: `0 0 ${fontSize * 0.6}px rgba(232, 197, 71, 0.35)`,
          transform: `translateY(${bob}px)`,
        }}
      >
        {lines.map((line, i) => (
          <div key={i} style={{ opacity: interpolate(revealed - i, [0, 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
            {line || " "}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, color: GOLD_DIM, fontSize: 16, letterSpacing: 8 }}>YOU</div>
    </div>
  );
}

export type AmbientSceneProps = {
  title: string;
  subtitle?: string;
  seed: number;
  /** The player's ASCII avatar, drawn in the lower-left corner. */
  avatar?: string;
};

export function AmbientScene({ title, subtitle, seed, avatar }: AmbientSceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill>
      <Field seed={seed} />
      {avatar && <PlayerFigure art={avatar} box={{ x: 48, y: CANVAS_HEIGHT - 330, w: 300, h: 300 }} />}
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
              background: `linear-gradient(90deg, transparent, ${GOLD}, transparent)`,
            }}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

export type LessonBoardProps = { title: string; body: string; seed: number };

/** Frames needed to reveal a lesson of this length. */
export function lessonDuration(body: string): number {
  const words = body.split(/\s+/).filter(Boolean).length;
  return Math.min(30 + Math.ceil(words * 1.6) + 30, 900);
}

export function LessonBoard({ title, body, seed }: LessonBoardProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const words = body.split(/(\s+)/);
  const shown = Math.floor(interpolate(frame, [20, 20 + words.length * 0.8], [0, words.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <AbsoluteFill>
      <Field seed={seed} />
      <AbsoluteFill style={{ padding: "60px 90px", opacity: enter }}>
        <div style={{ color: GOLD_DIM, fontSize: 22, letterSpacing: 8, textTransform: "uppercase" }}>Lesson</div>
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
  label: string;
  count: number;
  seed: number;
  /** The player's ASCII avatar, drawn small in the upper-left corner. */
  avatar?: string;
};

export const DECISION_DURATION = 50;

export function DecisionGraph({ label, count, seed, avatar }: DecisionGraphProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const boxes = choiceBoxes(count);
  const node = { x: (DECISION_NODE.x / 100) * CANVAS_WIDTH, y: (DECISION_NODE.y / 100) * CANVAS_HEIGHT };
  const nodeIn = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
  return (
    <AbsoluteFill>
      <Field seed={seed} />
      <svg width="100%" height="100%" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} style={{ position: "absolute", inset: 0 }}>
        {boxes.map((b, i) => {
          const tx = ((b.x + b.w / 2) / 100) * CANVAS_WIDTH;
          const ty = (b.y / 100) * CANVAS_HEIGHT;
          const length = Math.hypot(tx - node.x, ty - node.y);
          const drawn = interpolate(frame, [8 + i * 4, 30 + i * 4], [length, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const boxIn = interpolate(frame, [24 + i * 4, 40 + i * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <g key={i}>
              <path
                d={`M ${node.x} ${node.y} Q ${(node.x + tx) / 2} ${node.y + 40} ${tx} ${ty}`}
                fill="none"
                stroke={GOLD}
                strokeOpacity={0.55}
                strokeWidth={2}
                strokeDasharray={length * 1.2}
                strokeDashoffset={drawn * 1.2}
              />
              <rect
                x={(b.x / 100) * CANVAS_WIDTH}
                y={(b.y / 100) * CANVAS_HEIGHT}
                width={(b.w / 100) * CANVAS_WIDTH}
                height={(b.h / 100) * CANVAS_HEIGHT}
                rx={12}
                fill="#1a1410"
                fillOpacity={0.55 * boxIn}
                stroke={GOLD_DIM}
                strokeOpacity={0.5 * boxIn}
              />
            </g>
          );
        })}
        <circle cx={node.x} cy={node.y} r={34 * nodeIn} fill="#1a1410" stroke={GOLD} strokeWidth={2} />
        <circle
          cx={node.x}
          cy={node.y}
          r={(34 + 10 * Math.abs(Math.sin(frame / 12))) * nodeIn}
          fill="none"
          stroke={GOLD}
          strokeOpacity={0.25}
        />
      </svg>
      <AbsoluteFill style={{ alignItems: "center" }}>
        <div
          style={{
            marginTop: (DECISION_NODE.y / 100) * CANVAS_HEIGHT + 44,
            color: TEXT,
            fontSize: 26,
            maxWidth: 900,
            textAlign: "center",
            opacity: nodeIn,
          }}
        >
          {label}
        </div>
      </AbsoluteFill>
      {/* Above the answer boxes (which start at 42% of the height). */}
      {avatar && <PlayerFigure art={avatar} box={{ x: 40, y: 16, w: 210, h: 260 }} />}
    </AbsoluteFill>
  );
}
