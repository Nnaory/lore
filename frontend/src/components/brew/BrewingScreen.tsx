'use client';

/**
 * Building World (DESIGN-SYSTEM §4.10): Hazel stirs a cauldron; every concept / world part /
 * chapter the pipeline emits rises as a bubble. Render ONLY from BrewState (SSE → brewReducer).
 * Review step (LangGraph interrupt) turns the dialogue into a concept checklist.
 */
import { useEffect, useMemo, useState } from 'react';
import { renderCharacter, type Expression } from '@/lib/ascii';
import { BREW_STEPS, keptConcepts, type BrewState, type BrewStep } from '@/lib/schemas/brew';
import { t, type UiKey, type UiLang } from '@/lib/i18n/ui';
import { useIsPhone } from '@/lib/hooks/media';
import { AsciiArt } from '@/components/ascii/AsciiArt';
import { PumpkinField } from '@/components/ascii/PumpkinField';
import { ScaledBoard } from '@/components/layout/ScaledBoard';
import { Cauldron } from './Cauldron';

interface Props {
  state: BrewState;
  lang: UiLang;
  /** world name for the final button, e.g. "Valoria" */
  worldName: string;
  onToggleConcept: (label: string) => void;
  onProceed: () => void;
  onEnter: () => void;
}

const EXPR: Record<BrewStep, Expression> = { reading: 'calm', review: 'smile', world: 'calm', writing: 'surprised', done: 'smile' };
const PUMPKINS = [{ x: 1200, y: 720, fs: 8, w: 22, seed: 9 }, { x: -40, y: 90, fs: 8, w: 20, seed: 3 }, { x: 760, y: 120, fs: 6, w: 14, seed: 5 }];
const BUB_X = [20, 150, 70, 210, 40, 180, 110, 230, 10, 160];
const BUB_X_PHONE = [10, 90, 40, 120, 20, 80, 50, 110];

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function useBrewView(state: BrewState, lang: UiLang) {
  const now = useNow(state.step !== 'done');
  const kept = keptConcepts(state);
  const elapsed = (s: BrewStep) => (state.startedAt[s] ? (state.endedAt[s] ?? now) - state.startedAt[s]! : 0);
  const order: BrewStep[] = [...BREW_STEPS, 'done'];
  const idx = order.indexOf(state.step);
  const steps = BREW_STEPS.map((s, i) => {
    const done = idx > i, active = idx === i, waiting = active && s === 'review';
    const meta = waiting ? t(lang, 'brew.waiting') : s === 'review' ? (done ? t(lang, 'brew.nConcepts', { n: kept.length }) : '') : done || active ? mmss(elapsed(s)) : '';
    return { key: s, label: t(lang, `brew.step.${s}` as UiKey), done, active, waiting, meta };
  });
  const bubbles = [
    ...state.concepts.map((text) => ({ text, tone: 'text-candle' })),
    ...state.world.map((w) => ({ text: w.label, tone: 'text-cream' })),
    ...state.chapterTitles.map((text) => ({ text, tone: 'text-ember' })),
  ];
  const log: { text: string; tone: string }[] = [{ text: t(lang, 'brew.log.reading', { file: state.file, pages: state.pages }), tone: 'text-muted' }];
  state.concepts.forEach((c) => log.push({ text: t(lang, 'brew.log.concept', { label: c }), tone: state.dropped.includes(c) ? 'text-ink-soft' : 'text-candle' }));
  if (idx >= 1) log.push(idx === 1 ? { text: t(lang, 'brew.log.waiting'), tone: 'text-gold' } : { text: t(lang, 'brew.log.approved', { n: kept.length }), tone: 'text-muted' });
  state.world.forEach((w) => log.push({ text: t(lang, w.kind === 'place' ? 'brew.log.place' : 'brew.log.character', { label: w.label }), tone: 'text-cream' }));
  state.chapterTitles.forEach((c) => log.push({ text: t(lang, 'brew.log.chapter', { title: c }), tone: 'text-ember' }));
  if (state.step === 'done') log.push({ text: t(lang, 'brew.log.done', { chapters: state.chapterTitles.length, characters: state.world.filter((w) => w.kind === 'character').length }), tone: 'text-gold' });
  const total = BREW_STEPS.reduce((a, s) => a + elapsed(s), 0);
  const line = t(lang, `brew.hazel.${state.step}` as UiKey, { pages: state.pages });
  return { kept, steps, bubbles, log, total: mmss(total), line, idx };
}

export function BrewingScreen(props: Props) {
  const phone = useIsPhone();
  return phone ? (
    <ScaledBoard w={390} h={844} fit="width"><BrewingPhone {...props} /></ScaledBoard>
  ) : (
    <ScaledBoard w={1440} h={900}><BrewingDesktop {...props} /></ScaledBoard>
  );
}

function Chips({ state, onToggle }: { state: BrewState; onToggle: (l: string) => void }) {
  return (
    <>
      {state.concepts.map((c) => {
        const on = !state.dropped.includes(c);
        return (
          <button key={c} type="button" aria-pressed={on} onClick={() => onToggle(c)}
            className={`h-[34px] px-3 font-mono text-[13px] font-bold ${on ? 'border-2 border-ink bg-ink text-cream' : 'border-2 border-dashed border-ink bg-transparent text-ink-soft line-through'}`}>
            {on ? '✓' : '+'} {c}
          </button>
        );
      })}
    </>
  );
}

export function BrewingDesktop({ state, lang, worldName, onToggleConcept, onProceed, onEnter }: Props) {
  const v = useBrewView(state, lang);
  const hazel = useMemo(() => renderCharacter('hazel', EXPR[state.step]), [state.step]);
  return (
    <div className="lore-grid-bg relative h-[900px] w-[1440px] overflow-hidden font-display text-cream">
      <PumpkinField items={PUMPKINS} />
      <header className="absolute inset-x-0 top-0 flex h-16 items-center justify-between border-b border-smoke bg-ink px-8">
        <span className="font-mono text-sm font-bold tracking-[0.4em] text-gold">LORE</span>
        <div className="flex flex-col items-center gap-1">
          <span className="font-mono text-xs font-bold tracking-[0.24em] text-ember">{t(lang, 'brew.title')}</span>
          <span className="font-mono text-xs text-muted">{t(lang, 'brew.meta', { file: state.file, pages: state.pages, genre: state.genre, chapters: state.chapters })}</span>
        </div>
        <span className="w-[120px] text-right font-mono text-[13px] font-bold">{v.total}</span>
      </header>

      <div aria-hidden className="pointer-events-none absolute left-[380px] top-[160px] h-[260px] w-[400px]">
        {v.bubbles.map((b, i) => (
          <span key={`${i}-${b.text}`} className={`lore-bub absolute top-[224px] whitespace-nowrap font-mono text-sm font-bold ${b.tone}`} style={{ left: BUB_X[i % BUB_X.length] }}>( {b.text} )</span>
        ))}
      </div>
      <Cauldron fontPx={10} className="absolute left-[380px] top-[404px]" />
      <AsciiArt layers={hazel} fontPx={10} label={`Hazel, ${EXPR[state.step]}`} className="absolute left-[110px] top-[186px]" />

      <aside aria-label={t(lang, 'brew.steps')} className="absolute left-[880px] top-[112px] flex h-[556px] w-[440px] flex-col gap-3.5 border-l border-smoke pl-8">
        <span className="font-mono text-xs font-bold tracking-[0.2em] text-muted">{t(lang, 'brew.steps')}</span>
        <ol className="m-0 flex list-none flex-col p-0">
          {v.steps.map((s) => (
            <li key={s.key} className="flex h-[52px] items-center gap-3.5 border-b border-smoke">
              <span aria-hidden className={`relative size-3.5 border-2 ${s.done ? 'border-ember bg-ember' : s.waiting ? 'border-gold' : s.active ? 'border-ember' : 'border-smoke'}`}>
                {s.active && !s.waiting && <span className="lore-blink absolute inset-0.5 bg-ember" />}
              </span>
              <span className={`flex-1 text-[15px] ${s.active ? 'font-bold' : ''} ${s.done || s.active ? 'text-cream' : 'text-muted'}`}>{s.label}</span>
              <span className={`font-mono text-xs ${s.waiting ? 'text-gold' : 'text-muted'}`}>{s.meta}</span>
            </li>
          ))}
        </ol>
        <span className="mt-3.5 font-mono text-xs font-bold tracking-[0.2em] text-muted">{t(lang, 'brew.log')}</span>
        <div role="log" aria-live="polite" className="flex flex-1 flex-col justify-end gap-1 overflow-hidden border border-smoke px-4 py-3.5 font-mono text-xs leading-[1.5]">
          {v.log.slice(-11).map((g, i) => <span key={i} className={`whitespace-pre ${g.tone}`}>{g.text}</span>)}
          <span aria-hidden className="lore-blink h-3.5 w-2 bg-ember" />
        </div>
      </aside>

      <section aria-label="Hazel" className="lore-dialog absolute left-[110px] top-[700px] flex h-40 w-[1210px] flex-col gap-3 px-8 pb-4 pt-6">
        <div className="lore-nametag absolute -top-[18px] left-8 flex h-[30px] items-center gap-2.5 px-3">
          <span className="text-[13px] text-cloth-hazel">HAZEL</span>
          <span className="font-normal tracking-normal text-[11px] text-muted">{t(lang, 'home.hazelRole')}</span>
        </div>
        <p className="m-0 font-mono text-base leading-[1.55]">{v.line}</p>
        {state.step === 'review' && (
          <div className="flex items-end justify-between gap-6">
            <div role="group" className="flex flex-wrap gap-2"><Chips state={state} onToggle={onToggleConcept} /></div>
            <button type="button" onClick={onProceed} disabled={!v.kept.length} className="h-11 shrink-0 bg-ember px-5 font-mono text-[13px] font-bold text-ink">{t(lang, 'brew.proceed', { n: v.kept.length })}</button>
          </div>
        )}
        {state.step === 'done' && (
          <div className="flex justify-end"><button type="button" onClick={onEnter} className="h-11 bg-ember px-5 font-mono text-[13px] font-bold text-ink">{t(lang, 'brew.enter', { world: worldName })}</button></div>
        )}
      </section>
    </div>
  );
}

export function BrewingPhone({ state, lang, worldName, onToggleConcept, onProceed, onEnter }: Props) {
  const v = useBrewView(state, lang);
  const hazel = useMemo(() => renderCharacter('hazel', EXPR[state.step]), [state.step]);
  const cur = v.steps[Math.min(v.idx, 3)];
  return (
    <div className="lore-grid-bg relative h-[844px] w-[390px] overflow-hidden font-display text-cream">
      <header className="absolute inset-x-0 top-0 flex h-14 items-center justify-between border-b border-smoke bg-ink px-4">
        <span className="font-mono text-xs font-bold tracking-[0.4em] text-gold">LORE</span>
        <div className="flex flex-col items-center gap-0.5">
          <span className="font-mono text-[11px] font-bold tracking-[0.2em] text-ember">{t(lang, 'brew.title')}</span>
          <span className="font-mono text-[10px] text-muted">{t(lang, 'brew.metaShort', { file: state.file, pages: state.pages })}</span>
        </div>
        <span className="w-11 text-right font-mono text-xs font-bold">{v.total}</span>
      </header>
      <div aria-hidden className="pointer-events-none absolute left-[140px] top-[110px] h-[270px] w-[250px]">
        {v.bubbles.map((b, i) => (
          <span key={`${i}-${b.text}`} className={`lore-bub absolute top-[236px] whitespace-nowrap font-mono text-xs font-bold ${b.tone}`} style={{ left: BUB_X_PHONE[i % BUB_X_PHONE.length] }}>( {b.text} )</span>
        ))}
      </div>
      <Cauldron fontPx={6} className="absolute left-[150px] top-[380px]" />
      <AsciiArt layers={hazel} fontPx={6} label={`Hazel, ${EXPR[state.step]}`} className="absolute left-0.5 top-[248px]" />

      <div className="absolute inset-x-4 top-[552px] flex flex-col gap-2">
        <div aria-hidden className="grid grid-cols-4 gap-1">
          {v.steps.map((s) => <span key={s.key} className={`h-1.5 ${s.done ? 'bg-ember' : s.waiting ? 'bg-gold' : s.active ? 'bg-cream' : 'bg-smoke'}`} />)}
        </div>
        <div className="flex justify-between font-mono text-xs">
          <span className="font-bold">{state.step === 'done' ? t(lang, 'brew.ready') : `${v.idx + 1}/4 · ${cur.label}`}</span>
          <span className={cur.waiting ? 'text-gold' : 'text-muted'}>{state.step === 'done' ? '' : cur.meta}</span>
        </div>
        <div role="log" aria-live="polite" className="flex flex-col gap-0.5 font-mono text-[11px] leading-[1.45]">
          {v.log.slice(-3).map((g, i) => <span key={i} className={`truncate whitespace-pre ${g.tone}`}>{g.text}</span>)}
        </div>
      </div>

      <section aria-label="Hazel" className={`lore-dialog absolute inset-x-3 bottom-3 flex flex-col gap-2.5 px-3.5 pb-3.5 pt-5 ${state.step === 'review' ? 'top-[462px]' : 'top-[676px]'}`}>
        <div className="lore-nametag absolute -top-4 left-3.5 flex h-[26px] items-center px-2.5"><span className="text-xs text-cloth-hazel">HAZEL</span></div>
        <p className="m-0 font-mono text-[13px] leading-[1.55]">{v.line}</p>
        {state.step === 'review' && (
          <>
            <div role="group" className="flex flex-wrap gap-1.5"><Chips state={state} onToggle={onToggleConcept} /></div>
            <button type="button" onClick={onProceed} disabled={!v.kept.length} className="mt-auto h-12 bg-ember font-mono text-[13px] font-bold text-ink">{t(lang, 'brew.proceed', { n: v.kept.length })}</button>
          </>
        )}
        {state.step === 'done' && <button type="button" onClick={onEnter} className="mt-auto h-12 bg-ember font-mono text-[13px] font-bold text-ink">{t(lang, 'brew.enter', { world: worldName })}</button>}
      </section>
    </div>
  );
}
