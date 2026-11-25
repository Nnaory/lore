/**
 * shortcuts.ts — maps a key press to a Stage action.
 *
 * Why: SPACE = next line, F = fast/animate, L = open log. They must not fire
 * while typing, with Ctrl/Meta/Alt (keeps browser shortcuts like Ctrl+F), while
 * a modal is open, or when SPACE would activate the focused control itself.
 * Pure so the rules can be tested without a DOM.
 */

export type ShortcutAction = "next" | "toggle-mode" | "open-log";

/** Kind of the focused element, classified by the caller. */
export type ShortcutTargetKind =
  | "none"
  | "editable" // input (text-like), textarea, select, contenteditable
  | "activatable" // button, a, summary, checkbox/radio: handle SPACE themselves
  | "other";

export interface ShortcutEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly targetKind?: ShortcutTargetKind;
}

export interface ShortcutContext {
  readonly modalOpen?: boolean;
}

export type ShortcutResult =
  | { ok: true; action: ShortcutAction }
  | {
      ok: false;
      reason: "modifier" | "editable" | "modal" | "self_handled" | "unmapped" | "invalid_event";
    };

export function resolveShortcut(
  event: ShortcutEventLike,
  context: ShortcutContext = {},
): ShortcutResult {
  if (!event || typeof event.key !== "string") return { ok: false, reason: "invalid_event" };
  if (event.ctrlKey || event.metaKey || event.altKey) return { ok: false, reason: "modifier" };
  if (event.targetKind === "editable") return { ok: false, reason: "editable" };
  if (context?.modalOpen) return { ok: false, reason: "modal" };

  const isSpace = event.key === " " || event.code === "Space";
  if (isSpace) {
    if (event.targetKind === "activatable") return { ok: false, reason: "self_handled" };
    return { ok: true, action: "next" };
  }
  const k = event.key.toLowerCase();
  if (k === "f") return { ok: true, action: "toggle-mode" };
  if (k === "l") return { ok: true, action: "open-log" };
  return { ok: false, reason: "unmapped" };
}
