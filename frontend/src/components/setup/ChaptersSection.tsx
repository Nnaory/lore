'use client';

/*
 * ChaptersSection: "03 CHAPTERS" of the Preparation screen (DESIGN-SYSTEM §4.5, Prep.dc.html).
 * Five 44px squares in a radiogroup "Number of chapters" (selected = ember fill) and a
 * "› Advanced options" link (44px touch height) that reveals the existing AdvancedOptions
 * panel, passed in as `advanced`. OQ-6: lib/setup only knows short (3) and medium (5), so
 * all five boxes are drawn but 1, 2 and 4 are aria-disabled. A click on an enabled box maps
 * through lengthForChapters and calls onLengthChange (the page dispatches `length_set`).
 */
import { useState, type ReactNode } from 'react';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { chapterSquares, lengthForChapters } from '@/lib/prep/chapter-choices';
import type { StoryLength } from '@/lib/setup/create-form';

export interface ChaptersSectionProps {
  length: StoryLength;
  onLengthChange: (length: StoryLength) => void;
  /** Content shown when "Advanced options" is open (the existing AdvancedOptions). */
  advanced?: ReactNode;
}

export function ChaptersSection({ length, onLengthChange, advanced }: ChaptersSectionProps) {
  const [open, setOpen] = useState(false);
  const result = chapterSquares(length);
  const squares = result.ok ? result.squares : [];

  function pick(n: number) {
    const mapped = lengthForChapters(n);
    if (mapped.ok) onLengthChange(mapped.length);
  }

  return (
    <section className="mt-[22px] md:mt-[30px]" data-testid="chapters-section">
      <SectionLabel number="03" title="CHAPTERS" />
      <div className="mt-3 flex flex-col md:mt-3.5 md:flex-row md:items-center md:justify-between">
        <div
          role="radiogroup"
          aria-label="Number of chapters"
          data-testid="chapters-group"
          className="grid w-full grid-cols-5 gap-1.5 md:flex md:w-auto"
        >
          {squares.map((sq) => (
            <button
              key={sq.n}
              type="button"
              role="radio"
              aria-checked={sq.selected}
              aria-disabled={sq.enabled ? undefined : true}
              data-testid={`chapters-${sq.n}`}
              onClick={() => {
                if (sq.enabled) pick(sq.n);
              }}
              className={`h-11 w-full border-2 md:w-11 font-mono text-[15px] font-bold ${
                sq.selected
                  ? 'border-ember bg-ember text-ink'
                  : 'border-smoke bg-transparent text-cream'
              } ${sq.enabled ? 'cursor-pointer' : 'cursor-not-allowed text-muted'}`}
            >
              {sq.n}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="advanced-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-11 cursor-pointer items-center gap-2 border-none bg-transparent p-0 font-mono text-xs text-muted"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="square"
            aria-hidden="true"
            focusable="false"
            className={open ? 'rotate-90' : undefined}
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          Advanced options
        </button>
      </div>
      {open && advanced ? <div className="mt-4">{advanced}</div> : null}
    </section>
  );
}
