/*
 * SectionLabel: "01 MATERIAL ─────" heading used by the Preparation screens
 * (Prep.dc.html). Gold number, cream title, then a 1px smoke rule that fills the
 * rest of the row. Uses the Kit's .lore-eyebrow class for mono/700/0.2em caps.
 */

export interface SectionLabelProps {
  /** Section number, e.g. "01". */
  number: string;
  /** Section title, e.g. "MATERIAL". */
  title: string;
  className?: string;
  "data-testid"?: string;
}

export function SectionLabel({ number, title, className, "data-testid": testId }: SectionLabelProps) {
  return (
    <div data-testid={testId} className={`flex items-center gap-2.5 md:gap-3 ${className ?? ""}`}>
      <span className="font-mono text-[11px] font-bold leading-[1.32] text-gold md:text-[12px]">{number}</span>
      {/* Not .lore-eyebrow: the legacy rule in globals.css (10px, muted) outranks the layered token class. */}
      <span className="font-mono text-[11px] font-bold uppercase md:text-[12px] leading-[1.32] tracking-[0.2em] text-cream">
        {title}
      </span>
      <span aria-hidden="true" className="h-px grow bg-smoke" />
    </div>
  );
}
