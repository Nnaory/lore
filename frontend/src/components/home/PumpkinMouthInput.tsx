'use client';

/**
 * Home option A: the input lives inside the big pumpkin's mouth.
 * The <form> sits BEHIND the pumpkin; the pumpkin canvas is pointer-events:none and its
 * mouth cells are empty, so the candle-coloured form shows through and teeth overlap its edges.
 * Geometry comes from jackMouth().mouth (cells) × cell size — never hand-tune these pixels.
 */
import { useMemo, useState } from 'react';
import { CELL_ASPECT, jackMouth, MOUTH_PRESETS } from '@/lib/ascii';
import { AsciiArt } from '@/components/ascii/AsciiArt';

export function PumpkinMouthInput({
  size, onSubmit, onPickFile, hasFile,
}: { size: 'desktop' | 'phone'; onSubmit: (text: string) => void; onPickFile: () => void; hasFile: boolean }) {
  const preset = MOUTH_PRESETS[size];
  const j = useMemo(() => jackMouth(preset.w, { ...preset.opts }), [preset]);
  const fs = preset.fontPx;
  const cw = fs * CELL_ASPECT;
  const m = j.mouth;
  const [text, setText] = useState('');

  return (
    <div className="relative" style={{ width: j.C * cw, height: j.R * fs }}>
      <form
        aria-label="Start a story"
        onSubmit={(e) => { e.preventDefault(); onSubmit(text); }}
        className={`absolute flex items-center bg-candle ${size === 'desktop' ? 'gap-2 pl-[22px] pr-3.5' : 'gap-1 pl-2.5 pr-1.5'}`}
        style={{ left: m.c0 * cw, top: m.r0 * fs, width: (m.c1 - m.c0) * cw, height: (m.r1 - m.r0) * fs }}
      >
        <label htmlFor="mouth-input" className="sr-only">Topic or instructions</label>
        <input
          id="mouth-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={size === 'desktop' ? 'Type a topic, or feed me your notes…' : 'Topic or notes…'}
          className={`h-11 min-w-0 flex-1 border-0 bg-transparent font-mono text-ink outline-none placeholder:text-candle-ink ${size === 'desktop' ? 'text-[15px]' : 'text-sm'}`}
        />
        <button type="button" aria-label="Attach a file" onClick={onPickFile}
          className={`flex size-11 shrink-0 items-center justify-center border-2 border-ink ${hasFile ? 'bg-ink text-candle' : 'bg-transparent text-ink'}`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" /></svg>
        </button>
        <button type="submit" aria-label="Build the world" className="flex size-11 shrink-0 items-center justify-center bg-ink text-ember">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" aria-hidden="true"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>
        </button>
      </form>
      <AsciiArt layers={j.layers} fontPx={fs} className="pointer-events-none absolute left-0 top-0" />
    </div>
  );
}
