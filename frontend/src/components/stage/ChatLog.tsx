/**
 * ChatLog — everything said and taught so far in this story run
 * (opened from the "log chat" button), so the player can re-read a
 * lesson before answering a puzzle.
 *
 * Why: restyled to the Black Cat Gold Kit (design 6.2). Dialog behaviour
 * (focus, Escape, scrim click, role/aria) lives in `ui/Modal`; this file only
 * lays out the header and the entry list and keeps `chat-log` as the panel hook.
 */

"use client";

import { useEffect, useRef } from "react";
import { Modal } from "@/components/ui/Modal";
import type { ChatEntry } from "./chat-entry";

type ChatLogProps = {
  entries: ChatEntry[];
  onClose: () => void;
};

export function ChatLog({ entries, onClose }: ChatLogProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.();
  }, []);

  return (
    <Modal
      onClose={onClose}
      labelledBy="chat-log-title"
      data-testid="chat-log"
      className="md:max-w-[720px] h-full md:h-auto"
    >
      <div className="flex items-center justify-between px-5 min-h-[56px] border-b border-smoke">
        <h2
          id="chat-log-title"
          className="font-mono text-[12px] font-bold tracking-[0.24em] uppercase text-cream"
        >
          Story log
        </h2>
        <button
          type="button"
          data-autofocus
          data-testid="chat-log-close"
          onClick={onClose}
          className="font-mono text-[13px] font-bold min-h-[44px] min-w-[44px] px-4 border-2 border-cream text-cream bg-transparent cursor-pointer"
        >
          Close
        </button>
      </div>
      <ol className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3 list-none">
        {entries.length === 0 && (
          <li className="text-[15px] leading-normal text-muted">Nothing yet.</li>
        )}
        {entries.map((entry, i) => (
          <li key={i} className="text-[15px] leading-normal">
            {entry.kind === "dialogue" && (
              <>
                <span className="font-mono text-[12px] font-bold mr-2 text-gold">{entry.name}</span>
                <span className="text-cream">{entry.text}</span>
              </>
            )}
            {entry.kind === "narration" && <span className="text-muted">{entry.text}</span>}
            {entry.kind === "lesson" && (
              <div className="pl-3 border-l-2 border-gold">
                <p className="font-mono text-[11px] font-bold tracking-[0.12em] uppercase mb-1 text-gold">
                  Lesson · {entry.title}
                </p>
                <p className="text-cream">{entry.text}</p>
              </div>
            )}
          </li>
        ))}
        <div ref={endRef} />
      </ol>
    </Modal>
  );
}
