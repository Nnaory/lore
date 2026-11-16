/**
 * ChatBox — the stage's bottom panel (wireframe "chat: …")
 *
 * Shows the current line (narration, a character's dialogue, or a lesson)
 * with a typewriter effect in "animate" pacing. Clicking the panel first
 * completes a line that is still typing, then advances the story. Also
 * holds the fast|animate toggle, the (not yet active) free-question input,
 * and the log button.
 */

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motionAllowed, type Pacing } from "@/lib/story/pacing";

export type ChatEntry =
  | { kind: "narration"; text: string }
  | { kind: "dialogue"; characterId: string; name: string; expression: string; expressionKey: string; text: string }
  | { kind: "lesson"; title: string; text: string };

type ChatBoxProps = {
  entry: ChatEntry | null;
  /** Identifies the line; the typewriter restarts when it changes. */
  entryKey: string;
  pacing: Pacing;
  onPacingChange: (pacing: Pacing) => void;
  canAdvance: boolean;
  onAdvance: () => void;
  onTypingChange?: (typing: boolean) => void;
  onOpenLog: () => void;
  /** Who the free-question input would ask. */
  askName?: string;
  /** Buttons shown in place of the continue hint (e.g. "try a different choice"). */
  actions?: ReactNode;
};

const CHARS_PER_TICK = 2;
const TICK_MS = 22;

export function ChatBox({
  entry,
  entryKey,
  pacing,
  onPacingChange,
  canAdvance,
  onAdvance,
  onTypingChange,
  onOpenLog,
  askName,
  actions,
}: ChatBoxProps) {
  const text = entry?.text ?? "";
  const animate = pacing === "animate" && motionAllowed();
  const [typed, setTyped] = useState({ key: entryKey, count: animate ? 0 : text.length });
  // A new line starts typing from zero (or appears at once in fast pacing).
  const count = typed.key === entryKey ? typed.count : animate ? 0 : text.length;
  const typing = animate && count < text.length;

  useEffect(() => {
    if (!typing) return;
    const timer = setTimeout(
      () => setTyped({ key: entryKey, count: Math.min(text.length, count + CHARS_PER_TICK) }),
      TICK_MS
    );
    return () => clearTimeout(timer);
  }, [typing, count, entryKey, text.length]);

  useEffect(() => {
    onTypingChange?.(typing);
  }, [typing, onTypingChange]);

  function handleClick() {
    if (typing) {
      setTyped({ key: entryKey, count: text.length });
      return;
    }
    if (canAdvance) onAdvance();
  }

  const shown = typing ? text.slice(0, count) : text;

  return (
    <section
      data-testid="story-main"
      aria-label="Dialogue"
      onClick={handleClick}
      className="lore-glass lore-glass-panel rounded-panel relative flex flex-col gap-3 px-5 pt-4 pb-3 cursor-pointer select-text"
      style={{ minHeight: "11rem" }}
    >
      {/* fast | animate */}
      <div
        data-testid="pacing-toggle"
        role="group"
        aria-label="Story pacing"
        className="absolute top-3 right-3 flex rounded-pill overflow-hidden text-xs"
        style={{ border: "1px solid var(--glass-edge)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {(["fast", "animate"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={pacing === option}
            onClick={() => onPacingChange(option)}
            className="px-3 py-1"
            style={{
              backgroundColor: pacing === option ? "var(--accent-gold)" : "transparent",
              color: pacing === option ? "var(--background)" : "var(--foreground-muted)",
            }}
          >
            {option}
          </button>
        ))}
      </div>

      <div data-testid="scene-content" className="flex-1 pr-36 overflow-y-auto" aria-live="polite" style={{ maxHeight: "9rem" }}>
        {entry?.kind === "dialogue" && (
          <div data-testid="character-bubble" data-character-id={entry.characterId} className="animate-fade-in-up">
            <p className="flex items-baseline gap-2 mb-1">
              <span data-testid="character-name" className="text-sm font-semibold tracking-wide uppercase" style={{ color: "var(--accent-gold)" }}>
                {entry.name}
              </span>
              <span
                data-testid="character-expression"
                aria-label={`Expression: ${entry.expressionKey}`}
                className="text-sm font-mono"
                style={{ color: "var(--foreground-muted)" }}
              >
                {entry.expression}
              </span>
            </p>
            <p className="text-base leading-7" style={{ color: "var(--foreground)" }}>
              {shown}
            </p>
          </div>
        )}
        {entry?.kind === "narration" && (
          <div data-testid="narration-block" className="animate-fade-in-up" aria-label="Narration">
            <p className="text-base leading-7 italic" style={{ color: "var(--foreground-muted)" }}>
              {shown}
            </p>
          </div>
        )}
        {entry?.kind === "lesson" && (
          <div data-testid="learning-card" role="region" aria-label={`Learning: ${entry.title}`} className="animate-fade-in-up">
            <p className="text-xs font-semibold tracking-widest uppercase mb-1" style={{ color: "var(--accent-gold)" }}>
              Lesson · {entry.title}
            </p>
            <p className="text-sm leading-6" style={{ color: "var(--foreground)" }}>
              {shown}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          disabled
          aria-label="Ask a question (coming soon)"
          title="Asking the characters questions is coming soon"
          placeholder={`Ask ${askName ?? "a character"} something… (coming soon)`}
          className="lore-well flex-1 min-w-0 rounded-pill px-4 py-2 text-sm disabled:cursor-not-allowed"
          style={{ color: "var(--foreground-faint)" }}
        />
        <button
          type="button"
          data-testid="log-chat-button"
          onClick={onOpenLog}
          className="lore-pill flex-shrink-0"
        >
          log chat
        </button>
      </div>

      <div className="flex justify-end min-h-5 -mt-1" onClick={(e) => e.stopPropagation()}>
        {actions ??
          (canAdvance && !typing && (
            <span className="text-xs font-mono animate-pulse-gold pointer-events-none flex gap-1.5" style={{ color: "var(--accent-gold-dim)" }} aria-hidden="true">
              <span>Click anywhere to continue</span>
              <span>▸</span>
            </span>
          ))}
      </div>
    </section>
  );
}
