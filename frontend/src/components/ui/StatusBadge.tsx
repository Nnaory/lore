/*
 * StatusBadge: small mono label for a state (story progress, ending type).
 * Tokens only, no radius, no colour outside the Kit palette. `current` is
 * ink-on-cream-border so it stays legible on the inverted (cream) Current row
 * of CampaignLobby as well as on the dark surface.
 */

import type { ReactNode } from "react";

export type StatusBadgeVariant = "done" | "current" | "available" | "locked";

export interface StatusBadgeProps {
  variant: StatusBadgeVariant;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

const VARIANT_CLASS: Record<StatusBadgeVariant, string> = {
  done: "bg-gold text-ink border-gold",
  current: "bg-ink text-cream border-ink",
  available: "bg-transparent text-cream border-cream",
  locked: "bg-transparent text-muted border-smoke",
};

export function StatusBadge({ variant, children, className, "data-testid": testId }: StatusBadgeProps) {
  return (
    <span
      data-testid={testId}
      data-variant={variant}
      className={`inline-flex shrink-0 items-center border px-2 py-0.5 font-mono text-[11px] font-bold leading-[1.32] ${VARIANT_CLASS[variant]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}
