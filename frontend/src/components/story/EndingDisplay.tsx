/**
 * EndingDisplay — story ending panel on the Stage (Pola P, design 6.7)
 *
 * Why: shown when an ending scene is reached. Built from Kit tokens and
 * StatusBadge (`Success` = done, `Failed` = locked, `Partial Success` =
 * available), top-aligned and scrollable inside the panel with no glass,
 * radius, shadow or non-token colours.
 */

import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/StatusBadge";
import type { Ending } from "@/lib/types/scene";

type EndingDisplayProps = {
  ending: Ending;
};

const ENDING_BADGE: Record<Ending["type"], { label: string; variant: StatusBadgeVariant }> = {
  success: { label: "Success", variant: "done" },
  failure: { label: "Failed", variant: "locked" },
  partial_success: { label: "Partial Success", variant: "available" },
};

export function EndingDisplay({ ending }: EndingDisplayProps) {
  const badge = ENDING_BADGE[ending.type];

  return (
    <div
      data-testid="ending-display"
      className="mx-auto flex max-h-[600px] w-full max-w-[366px] flex-col items-center gap-4 overflow-y-auto border-2 border-smoke bg-ink p-5 text-center md:max-w-[720px] md:p-6"
      role="region"
      aria-label={`Story ending: ${ending.title}`}
    >
      <StatusBadge variant={badge.variant} data-testid="ending-type-badge">
        {badge.label}
      </StatusBadge>

      <h2 className="font-display text-[18px] font-bold leading-snug text-gold md:text-[20px]">
        {ending.title}
      </h2>

      <div aria-hidden="true" className="h-px w-full bg-smoke" />

      <p className="whitespace-pre-line text-center text-[15px] leading-[1.5] text-muted">
        {ending.narration}
      </p>
    </div>
  );
}
