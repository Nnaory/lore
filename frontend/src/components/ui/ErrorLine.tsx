/*
 * ErrorLine: the single error pattern of the Kit (design decision D8).
 * The palette has no danger colour, so an error is an ember "ERROR" chip
 * followed by cream text. role="alert" makes screen readers announce it.
 */

import type { ReactNode } from "react";

export interface ErrorLineProps {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function ErrorLine({ children, className, "data-testid": testId }: ErrorLineProps) {
  return (
    <p
      role="alert"
      data-testid={testId}
      className={`flex items-start gap-2 font-mono text-[12px] leading-[1.5] text-cream md:text-[13px] ${className ?? ""}`}
    >
      <span className="shrink-0 bg-ember px-1.5 py-[3px] text-[11px] font-bold leading-none text-ink">
        ERROR
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}
