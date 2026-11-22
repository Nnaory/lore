'use client';

/**
 * Desktop answer layer inside the Stage canvas frame (736 × 414, DESIGN-SYSTEM §4.9.1):
 *   preview panel 18,46 · 452×236 | seal 490,46 · 228×236 | rune tiles row at top 296, gap 12.
 * The question itself is NOT here — the speaker asks it in the DialogueBox.
 */
import type { ReactNode } from 'react';
import type { ChoiceBeat, ChoiceOption } from '@/lib/schemas/visual';
import { t, type UiLang } from '@/lib/i18n/ui';
import { CanvasFrame } from '@/components/story/CanvasFrame';
import { ShapePreview } from './ShapePreview';
import { optionState, type AnswerFlow, type OptionState } from './useAnswerFlow';

export function answerChip(flow: AnswerFlow, lang: UiLang, phone = false) {
  if (flow.solved) return { text: t(lang, 'answer.chip.open'), tone: 'gold' as const };
  if (flow.locked) return { text: t(lang, 'answer.chip.rejected'), tone: 'cream' as const };
  return { text: t(lang, phone ? 'answer.chip.yourMove' : 'answer.chip.paused'), tone: 'ember' as const };
}

/** Which option's shape to show: highlighted → last rejected → the solved one. */
export function previewOption(beat: ChoiceBeat, flow: AnswerFlow): ChoiceOption | undefined {
  const id = flow.focus ?? flow.locked;
  return beat.options.find((o) => o.id === id);
}

export function RuneBoard({ beat, flow, lang, footer }: { beat: ChoiceBeat; flow: AnswerFlow; lang: UiLang; footer?: ReactNode }) {
  const pv = previewOption(beat, flow);
  const lastWrong = !!flow.locked && !flow.solved;
  return (
    <CanvasFrame label={beat.canvasLabel ?? ''} chip={answerChip(flow, lang)} footer={footer} className="h-full w-full">
      {/* preview */}
      <div className="absolute left-[18px] top-[6px] h-[236px] w-[452px] border border-smoke">
        <span className="absolute left-2.5 top-2 font-mono text-[10px] tracking-[0.18em] text-muted">{t(lang, 'answer.preview.title')}</span>
        <div className="absolute left-0 top-1"><ShapePreview spec={pv?.preview} emptyText={t(lang, 'answer.preview.empty')} /></div>
        <span className={`absolute bottom-2 left-2.5 right-2.5 font-mono text-xs ${pv?.preview ? 'text-cream' : 'text-muted'}`}>
          {pv?.preview?.caption ?? t(lang, 'answer.preview.hint')}
        </span>
      </div>

      {/* seal */}
      <Seal state={flow.solved ? 'open' : lastWrong || flow.wrong.length ? 'cracked' : 'waiting'}
        slot={flow.solved ? pv?.label.replace(/^.*?=\s*/, '') ?? '' : flow.focus ? beat.options.find((o) => o.id === flow.focus)?.label.replace(/^.*?=\s*/, '') ?? '?' : '?'}
        focused={!!flow.focus && !flow.solved}
        label={t(lang, flow.solved ? 'answer.seal.open' : 'answer.seal.waiting')} />

      {/* rune tiles */}
      <div role="group" aria-label={beat.prompt} className="absolute inset-x-0 top-[256px] flex justify-center gap-3">
        {beat.options.map((o, i) => (
          <RuneTile key={o.id} keyCap={String(i + 1)} label={o.label} state={optionState(flow, o)} lang={lang} onClick={() => flow.select(o.id)} />
        ))}
      </div>
    </CanvasFrame>
  );
}

export function RuneTile({ keyCap, label, state, lang, onClick }: { keyCap: string; label: string; state: OptionState; lang: UiLang; onClick: () => void }) {
  const look: Record<OptionState, string> = {
    idle: 'border-cream text-cream',
    focus: 'border-ember text-cream',
    correct: 'border-ember bg-ember text-ink',
    rejected: 'border-dashed border-smoke text-muted',
    disabled: 'border-smoke text-muted',
  };
  const cap: Record<OptionState, string> = {
    idle: 'border-gold text-gold', focus: 'border-gold text-gold', correct: 'border-ink text-ink', rejected: 'border-smoke text-muted', disabled: 'border-smoke text-muted',
  };
  const aria = state === 'rejected' ? t(lang, 'answer.aria.rejected') : state === 'correct' ? t(lang, 'answer.aria.locked') : state === 'focus' ? t(lang, 'answer.aria.focus') : '';
  return (
    <button type="button" onClick={onClick} disabled={state === 'rejected' || state === 'disabled' || state === 'correct'} aria-pressed={state === 'focus'} aria-label={label + aria}
      className={`relative flex h-14 min-w-[160px] items-center justify-center gap-3 border-2 bg-ink px-3 font-mono ${look[state]} ${state === 'correct' ? 'bg-ember' : ''}`}>
      <span className={`flex size-[22px] items-center justify-center border-2 text-[11px] font-bold ${cap[state]}`}>{keyCap}</span>
      <span className={`text-[15px] font-bold ${state === 'rejected' ? 'line-through' : ''}`}>{label}</span>
      {state === 'focus' && (
        <span className="absolute -top-[11px] left-1/2 -translate-x-1/2 whitespace-nowrap bg-ember px-1.5 py-px text-[9px] font-bold tracking-[0.12em] text-ink">{t(lang, 'answer.clickAgain')}</span>
      )}
    </button>
  );
}

/** Seal: ring r96 + dotted ring r78 + 8 ticks; slot 160×44 in the middle. */
export function Seal({ state, slot, focused, label }: { state: 'waiting' | 'open' | 'cracked'; slot: string; focused: boolean; label: string }) {
  const ring = state === 'open' ? 'var(--color-ember)' : state === 'cracked' ? 'var(--color-cream)' : 'var(--color-gold)';
  return (
    <div className="absolute left-[490px] top-[6px] h-[236px] w-[228px]">
      <svg aria-hidden="true" width={228} height={236} viewBox="0 0 228 236" className="absolute inset-0">
        <circle cx={114} cy={112} r={96} fill={state === 'open' ? 'rgb(255 122 24 / 0.14)' : 'none'} stroke={ring} strokeWidth={state === 'open' ? 3 : 1.5} />
        <circle cx={114} cy={112} r={78} fill="none" stroke="var(--color-gold)" strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="2 7" />
        <path d="M114 10 V26 M114 198 V214 M12 112 H28 M200 112 H216 M42 40 L53 51 M175 173 L186 184 M186 40 L175 51 M53 173 L42 184" stroke="var(--color-gold)" strokeWidth={2} />
        {state === 'cracked' && <path d="M60 40 L84 78 L72 96 L98 120 M170 186 L150 152 L162 136 L138 118" stroke="var(--color-cream)" strokeWidth={2} fill="none" />}
      </svg>
      <div className={`absolute left-[34px] top-[90px] flex h-11 w-40 items-center justify-center border-2 font-mono text-[15px] font-bold ${
        state === 'open' ? 'border-ember bg-ember text-ink' : `border-dashed border-ember bg-ink ${focused ? 'text-cream' : 'text-ember'}`}`}>{slot}</div>
      <span className={`absolute inset-x-0 bottom-0 text-center font-mono text-[10px] tracking-[0.18em] ${state === 'open' ? 'text-ember' : 'text-muted'}`}>{label}</span>
    </div>
  );
}
