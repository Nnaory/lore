/**
 * StageHud — top bar of the Stage (replaces StageNavbar), DESIGN-SYSTEM §4.1/4.2.
 *
 * Why: shows exit button, LORE mark, story title, chapter progress and HP.
 * Desktop box 1440x64 (padding 0 24), phone 390x56. The HP squares and `n/5`
 * label come from `hpSquares` (lib/stage/hud); this component decides nothing
 * about HP. Positioned absolutely in design px, z-index 50, Kit tokens only.
 */

"use client";

import { Icon } from "@/components/ui/Icon";
import type { StageLayout } from "@/lib/stage/board-scale";
import { hpSquares } from "@/lib/stage/hud";
import { STAGE_BOXES } from "@/lib/stage/stage-boxes";

export interface StageHudProps {
  layout: StageLayout;
  storyTitle: string;
  /** Zero-based chapter index. */
  chapterIndex: number;
  chapterCount: number;
  chapterTitle?: string;
  location?: string;
  hp: number;
  failed?: boolean;
  onExit?: () => void;
}

export function StageHud({
  layout,
  storyTitle,
  chapterIndex,
  chapterCount,
  chapterTitle,
  location,
  hp,
  failed = false,
  onExit,
}: StageHudProps) {
  const phone = layout === "phone";
  const box = STAGE_BOXES[layout].hud;
  const hpView = hpSquares(hp);
  const squareSize = phone ? 7 : 12;

  const progress = phone
    ? `Ch ${chapterIndex + 1}/${chapterCount}`
    : `Chapter ${chapterIndex + 1} / ${chapterCount}`;
  const extras = (phone ? [location] : [chapterTitle, location]).filter(Boolean);

  return (
    <header
      data-testid="stage-hud"
      className="bg-ink border-smoke"
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        boxSizing: "border-box",
        padding: phone ? "0 12px 0 6px" : "0 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottomWidth: 1,
        borderBottomStyle: "solid",
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, width: phone ? 44 : 300 }}>
        <button
          type="button"
          data-testid="sidebar-exit-button"
          aria-label="Exit story"
          onClick={onExit}
          disabled={!onExit}
          className={phone ? "text-cream" : "border-2 border-smoke text-cream"}
          style={{
            width: 44,
            height: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            padding: 0,
            cursor: onExit ? "pointer" : "default",
          }}
        >
          <Icon name="back" size={18} />
        </button>
        {!phone && (
          <span
            className="font-mono text-gold"
            style={{ fontWeight: 700, fontSize: 14, letterSpacing: "0.4em" }}
          >
            LORE
          </span>
        )}
      </div>

      <div
        data-testid="story-header"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          minWidth: 0,
          flex: 1,
        }}
      >
        <span
          data-testid="sidebar-story-title"
          className="text-cream"
          style={{
            fontSize: phone ? 14 : 16,
            fontWeight: 700,
            letterSpacing: "0.02em",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {storyTitle}
        </span>
        <span
          className="font-mono text-muted"
          style={{
            fontSize: phone ? 11 : 12,
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span data-testid="chapter-progress">{progress}</span>
          {extras.map((part) => ` · ${part}`).join("")}
        </span>
      </div>

      <div
        data-testid="hp-display"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: phone ? 6 : 10,
          width: phone ? 76 : 300,
        }}
      >
        {!phone && (
          <span className="font-mono text-muted" style={{ fontSize: 11, letterSpacing: "0.2em" }}>
            HP
          </span>
        )}
        {hpView.ok && (
          <>
            <div style={{ display: "flex", gap: phone ? 3 : 4 }} aria-hidden="true">
              {hpView.squares.map((filled, i) => (
                <span
                  key={i}
                  data-testid="hp-square"
                  data-filled={filled}
                  className={filled ? "bg-ember" : "bg-smoke"}
                  style={{ width: squareSize, height: squareSize }}
                />
              ))}
            </div>
            <span
              data-testid="hp-value"
              role="status"
              aria-label={`HP: ${hpView.value} of ${hpView.total}`}
              className={`font-mono ${failed ? "text-ember" : "text-cream"}`}
              style={{ fontSize: phone ? 11 : 13, fontWeight: 700 }}
            >
              {hpView.label}
            </span>
          </>
        )}
      </div>
    </header>
  );
}
