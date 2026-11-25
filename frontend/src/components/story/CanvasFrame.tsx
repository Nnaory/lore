/**
 * The "window" that holds the Remotion player on the Stage (docs/DESIGN-SYSTEM.md §4.2).
 * Solid ink, 2px smoke border, 14px gold corner ticks (10px on phone). No glass, no radius.
 *
 *   <CanvasFrame label="beacon_ignition" status="paused" footer={<PlayerBar … />}>
 *     <Player component={…} style={{ width: '100%', height: '100%' }} … />
 *   </CanvasFrame>
 *
 * Optional props (task 1.4; defaults keep the Kit look): `footerless` drops the footer bar even
 * when a `footer` is passed, `bodyClassName` adds classes to the body wrapper.
 */
import type { ReactNode } from 'react';

export function CanvasFrame({
  label, status, children, footer, className, footerless = false, bodyClassName,
}: {
  label: string; status: 'paused' | 'playing' | 'resumed'; children: ReactNode; footer?: ReactNode; className?: string;
  footerless?: boolean; bodyClassName?: string;
}) {
  const chip = status === 'paused' ? { text: 'PAUSED · YOUR MOVE', bg: 'bg-ember' } : status === 'resumed' ? { text: 'RESUMED', bg: 'bg-gold' } : { text: 'PLAYING', bg: 'bg-gold' };
  const tick = 'absolute size-2.5 border-gold md:size-3.5';
  return (
    <section aria-label="Interactive canvas" className={`relative flex flex-col border-2 border-smoke bg-ink ${className ?? ''}`}>
      <span aria-hidden className={`${tick} -left-0.5 -top-0.5 border-l-2 border-t-2`} />
      <span aria-hidden className={`${tick} -right-0.5 -top-0.5 border-r-2 border-t-2`} />
      <span aria-hidden className={`${tick} -bottom-0.5 -left-0.5 border-b-2 border-l-2`} />
      <span aria-hidden className={`${tick} -bottom-0.5 -right-0.5 border-b-2 border-r-2`} />

      <header className="flex items-center justify-between px-2.5 pt-2 md:px-[18px] md:pt-3.5">
        <span className="font-mono text-[10px] tracking-[0.18em] text-gold md:text-[11px]">
          CANVAS <span className="hidden tracking-normal text-muted md:inline">/ {label}</span>
        </span>
        <span className={`${chip.bg} px-1.5 py-[3px] font-mono text-[10px] font-bold tracking-[0.12em] text-ink md:px-2 md:py-1 md:text-[11px]`}>{chip.text}</span>
      </header>

      <div className={`relative min-h-0 flex-1 ${bodyClassName ?? ''}`}>{children}</div>
      {footer && !footerless && <footer className="flex h-[38px] items-center gap-2 border-t border-smoke pr-2.5 md:h-10 md:gap-3 md:pr-3">{footer}</footer>}
    </section>
  );
}

/** Remotion scrubber: ember progress, gold diamonds at keyframes where the canvas pauses. */
export function PlayerBar({ progress, keyframes, time, onPlay }: { progress: number; keyframes: number[]; time: string; onPlay: () => void }) {
  return (
    <>
      <button type="button" aria-label="Play animation" onClick={onPlay} className="flex h-9 w-11 items-center justify-center text-cream md:w-9">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8z" /></svg>
      </button>
      <span className="order-last font-mono text-[10px] text-muted md:order-none md:text-[11px]">{time}</span>
      <div aria-hidden className="relative h-1 flex-1 bg-smoke">
        <div className="absolute inset-y-0 left-0 bg-ember" style={{ width: `${progress}%` }} />
        {keyframes.map((k) => (
          <span key={k} className="absolute -top-[3px] -ml-1 size-2 rotate-45 bg-gold" style={{ left: `${k}%` }} />
        ))}
      </div>
    </>
  );
}
