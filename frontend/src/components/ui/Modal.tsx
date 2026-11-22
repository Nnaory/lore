/**
 * Modal: the one dialog pattern of the Kit (Pola M). A full-viewport `ink/90`
 * scrim with a flat panel (2px smoke border, gold corner ticks, no radius, no
 * shadow). The scrim is 90% opaque so the animated root backdrop stays faintly
 * visible around the panel.
 *
 * Why it exists: ChatLog (and later other dialogs) need the same focus
 * handling. On mount focus goes to the element marked `data-autofocus` (or the
 * first focusable one), Tab/Shift+Tab wrap inside the panel, Escape and a click
 * on the scrim call `onClose`, and on unmount focus returns to whatever opened
 * it. It portals to `document.body` so it never lives inside `ScaledBoard`
 * (a transformed ancestor would break `position: fixed`).
 * Stage keyboard shortcuts are muted by the caller via `resolveShortcut`'s
 * `modalOpen`.
 */

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  onClose: () => void;
  /** id of the element that names the dialog (`aria-labelledby`). */
  labelledBy: string;
  children: ReactNode;
  /** Clicking the scrim closes the modal (default true). */
  closeOnBackdrop?: boolean;
  /** Extra classes for the panel (size). */
  className?: string;
  "data-testid"?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const TICK = "absolute w-[10px] h-[10px] border-gold pointer-events-none";

export function Modal({
  onClose,
  labelledBy,
  children,
  closeOnBackdrop = true,
  className,
  "data-testid": testId,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement as HTMLElement | null;
    const target =
      panel.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.querySelector<HTMLElement>(FOCUSABLE) ??
      panel;
    target.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch md:items-center justify-center md:p-4 bg-ink/90"
      data-testid={testId ? `${testId}-scrim` : undefined}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={panelRef}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`relative flex flex-col w-full bg-ink border-2 border-smoke md:max-h-[80dvh] ${className ?? ""}`}
      >
        <span aria-hidden="true" className={`${TICK} -top-[2px] -left-[2px] border-t-2 border-l-2`} />
        <span aria-hidden="true" className={`${TICK} -top-[2px] -right-[2px] border-t-2 border-r-2`} />
        <span aria-hidden="true" className={`${TICK} -bottom-[2px] -left-[2px] border-b-2 border-l-2`} />
        <span aria-hidden="true" className={`${TICK} -bottom-[2px] -right-[2px] border-b-2 border-r-2`} />
        {children}
      </div>
    </div>,
    document.body,
  );
}
