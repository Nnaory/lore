/**
 * StageCharacter — an original layered-SVG character portrait
 *
 * One drawing, varied by the character's ID (hair and eye colour) and the
 * campaign genre (accessory). Expressions swap brows, eyes and mouth;
 * CSS adds breathing, blinking and a talking mouth (all disabled under
 * prefers-reduced-motion by the global stylesheet).
 */

"use client";

import type { Genre } from "@/lib/types/campaign";
import { stableHash } from "@/lib/contracts/hash";
import type { Emotion } from "./emotion";

const PALETTES = [
  { hair: "#b83a3a", hairShade: "#7d2424", eyes: "#7fbf4a" },
  { hair: "#c9cfd9", hairShade: "#8d95a3", eyes: "#4a8fbf" },
  { hair: "#6b4fa8", hairShade: "#46326f", eyes: "#e8c547" },
  { hair: "#8a5a32", hairShade: "#5c3a1f", eyes: "#3f9b8e" },
  { hair: "#2f6f73", hairShade: "#1d4649", eyes: "#d98a3d" },
  { hair: "#1f1f26", hairShade: "#0f0f14", eyes: "#c0455a" },
];

type StageCharacterProps = {
  characterId: string;
  name: string;
  role?: string;
  emotion: Emotion;
  talking: boolean;
  genre?: Genre;
};

function Brows({ emotion }: { emotion: Emotion }) {
  // [left, right] as path data; the face is centred on x = 120.
  const shapes: Record<Emotion, [string, string]> = {
    idle: ["M88 112 Q100 107 112 110", "M128 110 Q140 107 152 112"],
    explaining: ["M88 109 Q100 103 112 107", "M128 107 Q140 103 152 109"],
    thinking: ["M88 110 Q100 108 112 112", "M128 106 Q140 100 152 104"],
    worried: ["M88 108 Q100 112 112 104", "M128 104 Q140 112 152 108"],
    happy: ["M88 108 Q100 102 112 106", "M128 106 Q140 102 152 108"],
    stern: ["M88 106 Q100 110 112 114", "M128 114 Q140 110 152 106"],
    surprised: ["M88 104 Q100 96 112 101", "M128 101 Q140 96 152 104"],
  };
  const [l, r] = shapes[emotion];
  return (
    <g stroke="#2a1d14" strokeWidth={3} fill="none" strokeLinecap="round">
      <path d={l} />
      <path d={r} />
    </g>
  );
}

function Eyes({ emotion, color }: { emotion: Emotion; color: string }) {
  if (emotion === "happy") {
    return (
      <g stroke="#2a1d14" strokeWidth={3} fill="none" strokeLinecap="round">
        <path d="M90 127 Q100 118 110 127" />
        <path d="M130 127 Q140 118 150 127" />
      </g>
    );
  }
  const big = emotion === "surprised";
  const look = emotion === "thinking" ? { dx: 3, dy: -3 } : { dx: 0, dy: 0 };
  return (
    <g className="stage-blink" style={{ transformOrigin: "120px 126px" }}>
      {[100, 140].map((cx) => (
        <g key={cx}>
          <ellipse cx={cx} cy={126} rx={big ? 10 : 9} ry={big ? 12 : 10} fill="#fffaf0" />
          <circle cx={cx + look.dx} cy={127 + look.dy} r={big ? 6 : 6.5} fill={color} />
          <circle cx={cx + look.dx} cy={127 + look.dy} r={3} fill="#1a1410" />
          <circle cx={cx + look.dx + 2.5} cy={124 + look.dy} r={1.8} fill="#fff" />
          <path d={`M${cx - 10} ${big ? 115 : 117} Q${cx} ${big ? 110 : 113} ${cx + 10} ${big ? 115 : 117}`} stroke="#2a1d14" strokeWidth={2.5} fill="none" />
        </g>
      ))}
    </g>
  );
}

function Mouth({ emotion, talking }: { emotion: Emotion; talking: boolean }) {
  const shapes: Record<Emotion, string> = {
    idle: "M112 152 Q120 156 128 152",
    explaining: "M111 151 Q120 158 129 151",
    thinking: "M114 153 Q121 151 127 154",
    worried: "M112 155 Q120 150 128 155",
    happy: "M109 149 Q120 161 131 149",
    stern: "M112 154 L128 154",
    surprised: "M120 148 a5 6 0 1 0 0.1 0",
  };
  return (
    <g className={talking ? "stage-talk" : undefined} style={{ transformOrigin: "120px 153px" }}>
      <path
        d={shapes[emotion]}
        stroke="#7a2f2f"
        strokeWidth={2.5}
        fill={emotion === "surprised" || emotion === "happy" ? "#7a2f2f" : "none"}
        strokeLinecap="round"
      />
    </g>
  );
}

function Accessory({ genre, hair }: { genre?: Genre; hair: string }) {
  if (genre === "fantasy" || genre === "horror" || genre === "historical") {
    // A wide-brimmed pointed hat with a gold band.
    return (
      <g>
        <path d="M58 92 Q120 70 182 92 Q150 100 120 98 Q90 100 58 92 Z" fill="#17141f" />
        <path d="M84 90 Q100 40 136 14 Q132 50 156 88 Z" fill="#1f1a2b" />
        <path d="M86 84 Q120 76 154 84 L156 92 Q120 84 84 92 Z" fill="#c9a43a" />
        {[0, 1, 2].map((i) => (
          <circle key={i} cx={104 + i * 12} cy={52 + (i % 2) * 10} r={1.6} fill="#f0ebe0" opacity={0.8} />
        ))}
      </g>
    );
  }
  if (genre === "science_fiction" || genre === "survival") {
    // A headset with a small visor light.
    return (
      <g>
        <path d="M70 108 Q72 58 120 54 Q168 58 170 108" stroke="#3a4250" strokeWidth={7} fill="none" />
        <rect x={62} y={104} width={14} height={30} rx={6} fill="#2b313c" />
        <rect x={164} y={104} width={14} height={30} rx={6} fill="#2b313c" />
        <path d="M164 128 Q150 160 134 160" stroke="#2b313c" strokeWidth={3} fill="none" />
        <circle cx={134} cy={160} r={3.5} fill="#e8c547" />
        <path d="M86 70 Q120 58 154 70" stroke={hair} strokeWidth={0} />
      </g>
    );
  }
  // Modern / non-fiction / mystery: round glasses.
  return (
    <g stroke="#3a2d20" strokeWidth={2.5} fill="#ffffff" fillOpacity={0.08}>
      <circle cx={100} cy={127} r={14} />
      <circle cx={140} cy={127} r={14} />
      <path d="M114 125 Q120 121 126 125" fill="none" />
    </g>
  );
}

export function StageCharacter({ characterId, name, role, emotion, talking, genre }: StageCharacterProps) {
  const palette = PALETTES[parseInt(stableHash(characterId), 36) % PALETTES.length];
  return (
    <figure
      data-testid="stage-character"
      data-emotion={emotion}
      data-character-id={characterId}
      className="flex flex-col items-center gap-3 w-full h-full justify-center"
    >
      <div className="relative w-full flex-1 min-h-0 flex items-end justify-center">
        <div
          aria-hidden="true"
          className="absolute inset-x-6 bottom-0 top-10 rounded-full"
          style={{ background: "radial-gradient(circle at 50% 60%, rgba(246,200,78,0.16), transparent 65%)" }}
        />
        <svg
          viewBox="0 0 240 300"
          className="relative h-full max-h-[420px] w-auto stage-breathe"
          role="img"
          aria-label={`${name}, ${emotion}`}
        >
          {/* back hair */}
          <path d="M66 120 Q60 60 120 56 Q180 60 174 120 L184 238 Q120 252 56 238 Z" fill={palette.hairShade} />
          {/* body */}
          <path d="M58 300 Q60 222 120 212 Q180 222 182 300 Z" fill="#e9e3d6" />
          <path d="M98 214 L120 246 L142 214" fill="#c9c1b0" />
          <path d="M104 214 Q120 226 136 214" stroke="#1f1a2b" strokeWidth={6} fill="none" />
          {/* neck */}
          <rect x={108} y={176} width={24} height={40} rx={10} fill="#f2d3b8" />
          {/* head */}
          <ellipse cx={120} cy={130} rx={58} ry={64} fill="#f7dcc4" />
          {emotion === "happy" && (
            <g fill="#e88a8a" opacity={0.45}>
              <ellipse cx={92} cy={146} rx={9} ry={5} />
              <ellipse cx={148} cy={146} rx={9} ry={5} />
            </g>
          )}
          {emotion === "worried" && <path d="M162 104 q4 8 0 12 q-4 -4 0 -12" fill="#9fd3ef" />}
          <Brows emotion={emotion} />
          <Eyes emotion={emotion} color={palette.eyes} />
          <Mouth emotion={emotion} talking={talking} />
          {/* bangs */}
          <path
            d="M62 116 Q66 60 120 58 Q174 60 178 116 Q160 92 148 104 Q140 84 124 100 Q112 82 100 102 Q88 86 76 108 Z"
            fill={palette.hair}
          />
          <Accessory genre={genre} hair={palette.hair} />
        </svg>
      </div>
      <figcaption className="text-center">
        <span className="block text-sm font-semibold tracking-widest uppercase" style={{ color: "var(--accent-gold)" }}>
          {name}
        </span>
        {role && (
          <span className="block text-xs" style={{ color: "var(--foreground-faint)" }}>
            {role}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
