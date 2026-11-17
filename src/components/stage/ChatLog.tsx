/**
 * ChatLog — everything said and taught so far in this story run
 * (opened from the "log chat" button), so the player can re-read a
 * lesson before answering a puzzle.
 */

"use client";

import { useEffect, useRef } from "react";
import type { ChatEntry } from "./ChatBox";

type ChatLogProps = {
  entries: ChatEntry[];
  onClose: () => void;
};

export function ChatLog({ entries, onClose }: ChatLogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    endRef.current?.scrollIntoView();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(34, 34, 34, 0.7)" }}
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div
        data-testid="chat-log"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-log-title"
        onClick={(e) => e.stopPropagation()}
        className="lore-glass lore-glass-panel rounded-panel w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderBottomColor: "var(--border-dim)" }}>
          <h2 id="chat-log-title" className="text-xs tracking-[0.25em] uppercase" style={{ color: "var(--foreground)" }}>
            Story log
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="lore-pill lore-pill-sm">
            Close
          </button>
        </div>
        <ol className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {entries.length === 0 && (
            <li className="text-sm" style={{ color: "var(--foreground-faint)" }}>
              Nothing yet.
            </li>
          )}
          {entries.map((entry, i) => (
            <li key={i} className="text-sm leading-6">
              {entry.kind === "dialogue" && (
                <>
                  <span className="font-semibold mr-2" style={{ color: "var(--accent-gold)" }}>
                    {entry.name}
                  </span>
                  <span style={{ color: "var(--foreground)" }}>{entry.text}</span>
                </>
              )}
              {entry.kind === "narration" && (
                <span className="italic" style={{ color: "var(--foreground-muted)" }}>
                  {entry.text}
                </span>
              )}
              {entry.kind === "lesson" && (
                <div className="lore-tile rounded-tip p-3" style={{ borderLeft: "3px solid var(--accent-gold)" }}>
                  <p className="text-xs font-semibold tracking-widest uppercase mb-1" style={{ color: "var(--accent-gold)" }}>
                    Lesson · {entry.title}
                  </p>
                  <p style={{ color: "var(--foreground)" }}>{entry.text}</p>
                </div>
              )}
            </li>
          ))}
          <div ref={endRef} />
        </ol>
      </div>
    </div>
  );
}
