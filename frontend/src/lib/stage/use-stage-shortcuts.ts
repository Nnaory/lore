/**
 * use-stage-shortcuts.ts — thin hook that wires keyboard shortcuts to Stage actions.
 *
 * Why: SPACE, F and L must work anywhere on the Stage. The decision of what a
 * key means (modifiers, typing, modal, self-handled SPACE) is made by
 * `resolveShortcut`; this hook only classifies the focused element, listens
 * to `keydown` on `window` and calls the matching handler.
 */

"use client";

import { useEffect } from "react";
import {
  resolveShortcut,
  type ShortcutAction,
  type ShortcutTargetKind,
} from "./shortcuts";

export type StageShortcutHandlers = Partial<Record<ShortcutAction, () => void>>;

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "image",
  "file",
  "color",
  "range",
]);

/** Classify the focused element for `resolveShortcut`. */
export function classifyTarget(target: EventTarget | null): ShortcutTargetKind {
  if (!target || typeof (target as Element).tagName !== "string") return "none";
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (el.isContentEditable) return "editable";
  if (tag === "textarea" || tag === "select") return "editable";
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return NON_TEXT_INPUT_TYPES.has(type) ? "activatable" : "editable";
  }
  if (tag === "button" || tag === "a" || tag === "summary") return "activatable";
  if (el.getAttribute("role") === "button") return "activatable";
  return "other";
}

export function useStageShortcuts(handlers: StageShortcutHandlers, modalOpen = false): void {
  const { next, "toggle-mode": toggleMode, "open-log": openLog } = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const result = resolveShortcut(
        {
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          targetKind: classifyTarget(e.target),
        },
        { modalOpen },
      );
      if (!result.ok) return;
      const run =
        result.action === "next" ? next : result.action === "toggle-mode" ? toggleMode : openLog;
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [next, toggleMode, openLog, modalOpen]);
}
