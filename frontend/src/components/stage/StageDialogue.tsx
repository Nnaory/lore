/**
 * StageDialogue — the Stage's dialogue box (replaces ChatBox).
 *
 * Why: wraps the Kit `DialogueBox` and drives it with the pure typewriter
 * (`useTypewriter`: 25 ms per character in `animate`, instant in `fast`).
 * Click on the text (or SPACE/Enter while it has focus) first shows a line
 * that is still typing in full, then calls `onAdvance` when `canAdvance`.
 * Name tag: the speaker's `Character.name`, `NARRATION` for narration and
 * `LESSON` for lessons (the lesson title becomes the first text line). The
 * `type something` input stays disabled ("coming soon"). Placed at the
 * layout's dialogue box (STAGE_BOXES) with z 10: the desktop sprite (z 20) is
 * in front of it, the phone sprite (z 5) behind it. Existing test hooks:
 * story-main, scene-content, character-name, pacing-toggle, log-chat-button,
 * plus narration-block / learning-card / character-bubble around the text.
 */

"use client";

import { useEffect, type ReactNode } from "react";
import { DialogueBox } from "@/components/story/DialogueBox";
import { NARRATION_TAG } from "@/lib/cast/cast-mapping";
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
  /** Who the (disabled) ask input would address. */
  askName?: string;
  /** Choice buttons shown inside the box on phone. */
  choices?: ReactNode;
  /** Extra controls under the text (e.g. the bad-branch "try again" button). */
  actions?: ReactNode;
  /** A modal is open: SPACE, F and L are ignored. */
  modalOpen?: boolean;
}

/** Tag and text for an entry. A lesson's title is the first text line. */
export function dialogueParts(entry: ChatEntry | null): { tag: string; text: string } {
  if (!entry) return { tag: NARRATION_TAG, text: "" };
  if (entry.kind === "dialogue") return { tag: entry.name, text: entry.text };
  if (entry.kind === "lesson") return { tag: LESSON_TAG, text: `${entry.title}\n${entry.text}` };
  return { tag: NARRATION_TAG, text: entry.text };
}

export function StageDialogue({
  layout,
  entry,
  mode,
  onModeChange,
  canAdvance,
  onAdvance,
  onTypingChange,
  onOpenLog,
  speakerRole,
  askName,
  choices,
  actions,
  modalOpen = false,
}: StageDialogueProps) {
  const box = STAGE_BOXES[layout].dialogue;
  const { tag, text } = dialogueParts(entry);
  const { visible, done, skip } = useTypewriter(text, mode);
  const typing = !done;

  useEffect(() => {
    onTypingChange?.(typing);
  }, [typing, onTypingChange]);

  function handleAdvance() {
    if (typing) {
      skip();
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
    if (entry?.kind === "dialogue") {
      return (
        <div data-testid="character-bubble" data-character-id={entry.characterId}>
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
    if (entry?.kind === "narration") {
      return (
        <div data-testid="narration-block" aria-label="Narration">
          {paragraph}
        </div>
      );
    }
    return paragraph;
  }

  const askLabel = askName ?? "a character";
  return (
    <div
      data-testid="stage-dialogue"
      style={{ position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height, zIndex: 10 }}
    >
      <DialogueBox
        className="h-full"
        speakerName={tag}
        speakerRole={entry?.kind === "dialogue" ? speakerRole : undefined}
        text={visible}
        choices={choices}
        mode={mode}
        onModeChange={onModeChange}
        onOpenLog={onOpenLog}
        askDisabled
        askPlaceholder={`Ask ${askLabel} something… (coming soon)`}
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
