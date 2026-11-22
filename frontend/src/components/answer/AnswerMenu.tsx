'use client';

/**
 * Phone answer layer (DESIGN-SYSTEM §4.9.2): full-width rows inside the DialogueBox (`extra`),
 * shape preview in the canvas frame (`PhonePreview`). Same flow as the desktop runes.
 */
import type { ChoiceBeat } from '@/lib/schemas/visual';
import { t, type UiLang } from '@/lib/i18n/ui';
import { CanvasFrame } from '@/components/story/CanvasFrame';
import { ShapePreview } from './ShapePreview';
import { answerChip, previewOption } from './RuneBoard';
import { optionState, type AnswerFlow, type OptionState } from './useAnswerFlow';

export function AnswerMenu({ beat, flow, lang }: { beat: ChoiceBeat; flow: AnswerFlow; lang: UiLang }) {
  return (
    <div role="group" aria-label={beat.prompt} className="flex flex-col gap-1.5">
      {beat.options.map((o, i) => {
        const st = optionState(flow, o);
        const look: Record<OptionState, string> = {
          idle: 'border-ink bg-transparent text-ink',
          focus: 'border-ink bg-ink text-cream',
          correct: 'border-ember bg-ember text-ink',
          rejected: 'border-dashed border-muted text-ink-soft',
          disabled: 'border-muted text-ink-soft',
        };
        const tag = st === 'correct' ? t(lang, 'answer.correct') : st === 'rejected' ? t(lang, 'answer.rejected') : st === 'focus' ? t(lang, 'answer.tapAgain') : '';
        return (
          <button key={o.id} type="button" onClick={() => flow.select(o.id)} disabled={st === 'rejected' || st === 'disabled' || st === 'correct'} aria-pressed={st === 'focus'}
            className={`flex h-12 items-center gap-2.5 border-2 pl-2 pr-3 text-left font-mono ${look[st]}`}>
            <span className="w-3 text-[11px] text-ember">{st === 'focus' ? '▶' : ''}</span>
            <span className={`flex size-[22px] items-center justify-center border-2 text-[11px] font-bold ${st === 'focus' ? 'border-gold' : st === 'correct' ? 'border-ink' : st === 'idle' ? 'border-ink' : 'border-muted'}`}>{i + 1}</span>
            <span className={`flex-1 text-sm font-bold ${st === 'rejected' ? 'line-through' : ''}`}>{o.label}</span>
            <span className={`text-[10px] font-bold tracking-[0.08em] ${st === 'focus' ? 'text-ember' : ''}`}>{tag}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Phone canvas: 366×246 frame, preview svg 346×154, caption, 30px progress bar. */
export function PhonePreview({ beat, flow, lang, progress, time }: { beat: ChoiceBeat; flow: AnswerFlow; lang: UiLang; progress: number; time: string }) {
  const pv = previewOption(beat, flow);
  return (
    <CanvasFrame title={t(lang, 'answer.preview.title')} label="" chip={answerChip(flow, lang, true)} className="h-full w-full"
      footer={<><div aria-hidden className="relative ml-2.5 h-1 flex-1 bg-smoke"><div className="absolute inset-y-0 left-0 bg-ember" style={{ width: `${progress}%` }} /></div><span className="font-mono text-[10px] text-muted">{time}</span></>}>
      <div className="absolute left-2 top-0"><ShapePreview spec={pv?.preview} emptyText={t(lang, 'answer.preview.emptyPhone')} phone width={346} height={154} /></div>
      <span className={`absolute inset-x-2.5 top-[158px] font-mono text-[10px] leading-[1.4] ${pv?.preview ? 'text-cream' : 'text-muted'}`}>{pv?.preview?.caption ?? t(lang, 'answer.preview.hint')}</span>
    </CanvasFrame>
  );
}
