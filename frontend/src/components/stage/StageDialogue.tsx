/**
 * StageDialogue — the Stage's dialogue box (replaces ChatBox).
 *
 * Why: wraps the Kit `DialogueBox` and drives it with the pure typewriter
 * (`useTypewriter`: 25 ms per character in `animate`, instant in `fast`).
 * Click on the text (or SPACE/Enter while it has focus) first shows a line
 * that is still typing in full, then calls `onAdvance` when `canAdvance`.
 * Tag: the speaker's `Character.name`, `NARRATION` for narration,
 * `LESSON` for lessons (the lesson title sits beside the tag on desktop; the text is the
 * body only), or the answering character's `name` for inline Q&A replies. Text longer than the
 * desktop box is paged (`paginateText`). Placed at the layout's dialogue box (STAGE_BOXES) with z 10: the desktop sprite (z 20) is
 * in front of it, the phone sprite (z 5) behind it. Existing test hooks:
 * story-main, scene-content, character-name, pacing-toggle, log-chat-button,
 * plus narration-block / learning-card / character-bubble around the text.
 */

"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DialogueBox } from "@/components/story/DialogueBox";
import { NARRATION_TAG } from "@/lib/cast/cast-mapping";
import { DIALOGUE_CAPACITY, paginateText } from "@/lib/dialogue/pagination";
import { useTypewriter } from "@/lib/dialogue/use-typewriter";
import type { TextMode } from "@/lib/dialogue/typewriter";
import type { StageLayout } from "@/lib/stage/board-scale";
import { STAGE_BOXES } from "@/lib/stage/stage-boxes";
import { useStageShortcuts } from "@/lib/stage/use-stage-shortcuts";
import type { ChatEntry } from "./chat-entry";

export const LESSON_TAG = "LESSON";

export interface StageDialogueProps {
  layout: StageLayout;
  entry: ChatEntry | null;
  /** Unique identifier of the active beat so adjacent identical text still resets to page 0. */
  entryKey?: string;
  /** Text mode (fast | animate). */
  mode: TextMode;
  onModeChange: (mode: TextMode) => void;
  canAdvance: boolean;
  onAdvance: () => void;
  /** Reports whether the line is still being typed. */
  onTypingChange?: (typing: boolean) => void;
  onOpenLog: () => void;
  /** Role line next to the name tag (desktop only). */
  speakerRole?: string;
  /** Who the ask input addresses. */
  askName?: string;
  /** Called when the player submits a question from the dialogue bar. */
  onAsk?: (question: string) => void;
  /** Disables the ask input (e.g. during puzzle, ending, or in-flight request). */
  askDisabled?: boolean;
  /** Optional custom placeholder for the ask input. */
  askPlaceholder?: string;
  /** Non-scrolled puzzle feedback rendered above choices on phone. */
  feedback?: ReactNode;
  /** Choice buttons shown inside the box on phone. */
  choices?: ReactNode;
  /** Extra controls under the text (e.g. the bad-branch "try again" button). */
  actions?: ReactNode;
  /** Optional bounding box override (used on mobile puzzle beats to expand upward). */
  boxOverride?: { x: number; y: number; width: number; height: number };
  /** A modal is open: SPACE, F and L are ignored. */
  modalOpen?: boolean;
}

/**
 * Tag and text for an entry. A lesson's text is its body only: the title is drawn in the canvas
 * heading and beside the name tag, so the three lines of the box are all for the text.
 */
export function dialogueParts(entry: ChatEntry | null): { tag: string; text: string } {
  if (!entry) return { tag: NARRATION_TAG, text: "" };
  if (entry.kind === "dialogue" || entry.kind === "answer") {
    return { tag: entry.name, text: entry.text };
  }
  if (entry.kind === "lesson") return { tag: LESSON_TAG, text: entry.text };
  return { tag: NARRATION_TAG, text: entry.text };
}

export function StageDialogue({
  layout,
  entry,
  entryKey,
  mode,
  onModeChange,
  canAdvance,
  onAdvance,
  onTypingChange,
  onOpenLog,
  speakerRole,
  askName,
  onAsk,
  askDisabled = false,
  askPlaceholder,
  feedback,
  choices,
  actions,
  boxOverride,
  modalOpen = false,
}: StageDialogueProps) {
  const box = boxOverride ?? STAGE_BOXES[layout].dialogue;
  const { tag, text } = dialogueParts(entry);
  const pageKey = entryKey ?? text;

  // Text longer than the desktop box is shown page by page (the AI side keeps chunks short, this
  // is the safety net for saved projects and the demo). Tagging pageState with pageKey resets it
  // to page 0 whenever the active beat or text changes without a synchronous setState in an effect.
  const pages = useMemo(() => paginateText(text, DIALOGUE_CAPACITY[layout]), [text, layout]);
  const [pageState, setPageState] = useState({ key: pageKey, index: 0 });
  const pageIndex = pageState.key === pageKey ? Math.min(pageState.index, pages.length - 1) : 0;
  const lastPage = pageIndex >= pages.length - 1;
  const pageText = pages[pageIndex] ?? text;

  const { visible, done, skip } = useTypewriter(pageText, mode);
  const typing = !done;

  useEffect(() => {
    onTypingChange?.(typing);
  }, [typing, onTypingChange]);

  function handleAdvance() {
    if (typing) {
      skip();
      return;
    }
    if (!lastPage) {
      setPageState({ key: pageKey, index: pageIndex + 1 });
      return;
    }
    if (canAdvance) onAdvance();
  }

  useStageShortcuts(
    {
      next: handleAdvance,
      "toggle-mode": () => onModeChange(mode === "fast" ? "animate" : "fast"),
      "open-log": onOpenLog,
    },
    modalOpen,
  );

  function wrapText(paragraph: ReactNode): ReactNode {
    const body = wrapEntry(paragraph);
    if (!actions) return body;
    return (
      <>
        {body}
        <div
          className="mt-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      </>
    );
  }

  function wrapEntry(paragraph: ReactNode): ReactNode {
    if (entry?.kind === "dialogue" || entry?.kind === "answer") {
      return (
        <div
          data-testid="character-bubble"
          data-character-id={entry.characterId}
          {...(entry.kind === "answer" ? { "data-qa-reply": "true" } : {})}
        >
          {paragraph}
        </div>
      );
    }
    if (entry?.kind === "lesson") {
      return (
        <div data-testid="learning-card" role="region" aria-label={`Learning: ${entry.title}`}>
          {paragraph}
        </div>
      );
    }
    if (entry?.kind === "narration" || entry?.kind === "question") {
      return (
        <div data-testid="narration-block" aria-label="Narration">
          {paragraph}
        </div>
      );
    }
    return paragraph;
  }

  const askLabel = askName ?? "a character";
  const resolvedPlaceholder =
    askPlaceholder ?? (layout === "phone" ? `Ask ${askLabel}…` : `Ask ${askLabel} something…`);
  return (
    <div
      data-testid="stage-dialogue"
      style={{ position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height, zIndex: 10 }}
    >
      <DialogueBox
        className="h-full"
        speakerName={tag}
        speakerRole={
          entry?.kind === "dialogue" || entry?.kind === "answer"
            ? speakerRole
            : entry?.kind === "lesson"
              ? entry.title
              : undefined
        }
        text={visible}
        feedback={feedback}
        choices={choices}
        mode={mode}
        onModeChange={onModeChange}
        onAsk={onAsk}
        onOpenLog={onOpenLog}
        askDisabled={askDisabled}
        askPlaceholder={resolvedPlaceholder}
        onAdvance={handleAdvance}
        wrapText={wrapText}
        testIds={{
          // `story-main` is the click-to-advance area (what the old ChatBox root was).
          root: "stage-dialogue-box",
          advance: "story-main",
          nameTag: "character-name",
          text: "scene-content",
          mode: "pacing-toggle",
          fast: "pacing-fast",
          animate: "pacing-animate",
          log: "log-chat-button",
          ask: "ask-input",
        }}
      />
    </div>
  );
}
