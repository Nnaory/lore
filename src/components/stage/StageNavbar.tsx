/**
 * StageNavbar — story title, chapter progress and location, HP, and exit.
 */

"use client";

import { LogOut } from "lucide-react";
import { MAX_HP } from "@/lib/game/hp-manager";

type StageNavbarProps = {
  storyTitle: string;
  chapterTitle?: string;
  chapterIndex: number;
  chapterCount: number;
  location?: string;
  hp: number;
  failed: boolean;
  onExit?: () => void;
};

export function StageNavbar({
  storyTitle,
  chapterTitle,
  chapterIndex,
  chapterCount,
  location,
  hp,
  failed,
  onExit,
}: StageNavbarProps) {
  return (
    <header
      className="flex items-center gap-4 px-4 py-2.5 border-b"
      style={{ backgroundColor: "var(--background-panel)", borderBottomColor: "var(--border)" }}
    >
      <button
        type="button"
        data-testid="sidebar-exit-button"
        onClick={onExit}
        disabled={!onExit}
        className="story-exit-btn flex-shrink-0"
        aria-label="Exit story"
        title="Exit story"
      >
        <LogOut size={16} aria-hidden="true" />
      </button>

      <span className="hidden sm:block text-xs font-semibold tracking-[0.3em]" style={{ color: "var(--accent-gold-dim)" }}>
        LORE
      </span>

      <div data-testid="story-header" className="flex-1 min-w-0 text-center">
        <p data-testid="sidebar-story-title" className="text-sm font-semibold tracking-wide truncate" style={{ color: "var(--foreground)" }}>
          {storyTitle}
        </p>
        <p className="text-xs truncate" style={{ color: "var(--foreground-faint)" }}>
          <span data-testid="chapter-progress">
            Chapter {chapterIndex + 1} / {chapterCount}
          </span>
          {chapterTitle && <> · {chapterTitle}</>}
          {location && <> · {location}</>}
        </p>
      </div>

      <div data-testid="hp-display" className="flex items-center gap-2 flex-shrink-0">
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: MAX_HP }).map((_, i) => (
            <span
              key={i}
              className="w-2.5 h-2.5 rounded-sm transition-colors"
              style={{ backgroundColor: i < hp ? "var(--accent-gold)" : "var(--border-dim)" }}
            />
          ))}
        </div>
        <span
          data-testid="hp-value"
          className="text-xs font-mono"
          aria-label={`HP: ${hp} of ${MAX_HP}`}
          aria-live="polite"
          style={{ color: failed ? "var(--danger)" : "var(--foreground)" }}
        >
          {hp} / {MAX_HP}
        </span>
      </div>
    </header>
  );
}
