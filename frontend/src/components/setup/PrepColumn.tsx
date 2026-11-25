'use client';

/*
 * PrepColumn: the frame of the Preparation screen, desktop and phone (DESIGN-SYSTEM §4.5 and
 * §4.6, Prep.dc.html and PrepMobile.dc.html). Same markup for both; only `md:` (768px, the
 * Stage breakpoint) changes the layout.
 * - Desktop: one 680px ink column centred on the page (x 380 at 1440), 1px smoke left/right
 *   borders, padding 24px 48px 0, a 44px top row (Back link with text, LORE), the NEW STORY
 *   eyebrow, 36px H1 and 15px intro.
 * - Phone: full width, a 56px header (44px back icon, LORE) with a 1px smoke bottom border,
 *   then 20px padding, an eyebrow row (60px, mini pumpkin at the right), 28px H1, 14px intro.
 * Sections are passed as children. The page flows (min-height, scrolls); it is not scaled.
 * The page paints only the grid lines; the pumpkins are the animated ASCII canvas the root
 * layout mounts (PumpkinBackdrop), per the user's decision to keep the moving background on
 * every screen (deviates from the static PumpkinField in the canvas). On phone the column is
 * transparent so that canvas stays visible; the sticky action bar keeps its ink fill.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AsciiPre } from '@/components/ascii/AsciiArt';
import { pumpkin } from '@/lib/ascii';

export interface PrepColumnProps {
  children?: ReactNode;
  /** Target of the "← Back" link. */
  backHref?: string;
}

/** The 84x60 mini pumpkin of the phone eyebrow row (PrepMobile: pumpkin(16, 7) at 6px). */
const MINI_PUMPKIN = pumpkin(16, 7);

export function PrepColumn({ children, backHref = '/' }: PrepColumnProps) {
  return (
    <div
      data-testid="prep-page"
      className="lore-grid-lines relative min-h-screen overflow-clip font-display text-cream"
    >
      <main
        data-testid="prep-column"
        className="relative mx-auto flex min-h-screen w-full max-w-full flex-col bg-transparent px-0 pb-0 pt-0 md:w-[680px] md:border-x md:border-smoke md:bg-ink md:px-12 md:pt-6"
      >
        <div className="flex h-14 items-center justify-between border-b border-smoke pl-1.5 pr-4 md:h-11 md:border-b-0 md:p-0">
          <Link
            href={backHref}
            aria-label="Back"
            data-testid="prep-back"
            className="flex h-11 w-11 items-center justify-center font-mono text-[13px] text-cream no-underline md:w-auto md:justify-start md:gap-2"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="square"
              aria-hidden="true"
              focusable="false"
              className="h-5 w-5 md:h-4 md:w-4"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span className="hidden md:inline">Back</span>
          </Link>
          <span className="font-mono text-[13px] font-bold leading-[1.32] tracking-[0.4em] text-gold">LORE</span>
        </div>

        <div className="flex flex-1 flex-col px-5 pt-5 md:px-0 md:pt-0">
          <div className="flex h-[60px] items-end justify-between md:mt-9 md:block md:h-auto">
            <span className="font-mono text-[11px] font-bold leading-[1.32] tracking-[0.24em] text-ember md:text-[12px]">
              NEW STORY
            </span>
            <AsciiPre
              layers={MINI_PUMPKIN}
              fontPx={6}
              className="shrink-0 overflow-hidden md:hidden"
              style={{ width: 84, height: 60 }}
            />
          </div>
          <h1 className="mb-0 mt-2 text-[28px] font-bold leading-[1.15] md:mt-2.5 md:text-[36px]">
            Turn your material into a story
          </h1>
          <p className="mb-0 mt-2 max-w-[560px] text-sm leading-normal text-muted md:mt-3 md:text-[15px]">
            Upload lecture notes, a chapter, or a slide deck. LORE builds a world around it where every challenge is
            solved with what you learn.
          </p>

          {children}
        </div>
      </main>
    </div>
  );
}