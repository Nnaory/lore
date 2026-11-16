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
      style={{ backgroundColor: "rgba(10, 10, 12, 0.8)" }}
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div
        data-testid="chat-log"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-log-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-lg overflow-hidden"
        style={{ backgroundColor: "var(--background-panel)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderBottomColor: "var(--border-dim)" }}>
          <h2 id="chat-log-title" className="text-xs tracking-[0.25em] uppercase" style={{ color: "var(--foreground)" }}>
            Story log
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="text-xs px-2 py-1 rounded" style={{ color: "var(--foreground-muted)", border: "1px solid var(--border-dim)" }}>
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
                <div className="rounded p-3" style={{ border: "1px solid var(--border-dim)", borderLeft: "3px solid var(--accent-gold)" }}>
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
