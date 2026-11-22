'use client';

/**
 * Story ending (DESIGN-SYSTEM §4.11): VN credits roll → end card.
 * The roll starts automatically after the last narration line; "skip" or the roll's end shows the card.
 * Data: StoryResult (lib/story/result.ts) — computed on the client, no backend call.
 */
import { useEffect, useMemo, useState } from 'react';
import { CAST, cropRows, figure, renderScene, type CastId, type Expression } from '@/lib/ascii';
import type { CharacterDef } from '@/lib/schemas/visual';
import type { CastCredit, StoryResult } from '@/lib/story/result';
import { t, type UiKey, type UiLang } from '@/lib/i18n/ui';
import { useIsPhone, useReducedMotion } from '@/lib/hooks/media';
import { AsciiArt } from '@/components/ascii/AsciiArt';
import { ScaledBoard } from '@/components/layout/ScaledBoard';

const ROLL_MS = 34_000;
const BUST_FROM: Partial<Record<CastId, number>> = { mira: 6, nyx: 6 };

interface Props {
  result: StoryResult;
  lang: UiLang;
  onRetry: (concept: string) => void;
  onNewStory: () => void;
  onViewLog: () => void;
  /** start on the end card (e.g. when re-opening a finished story) */
  startAtEnd?: boolean;
}

function specOf(def: CharacterDef) { return typeof def.look === 'string' ? CAST[def.look] : def.look; }
function exprOf(c: CastCredit): Expression { return c.def.function === 'rival' ? 'angry' : 'smile'; }
function bust(c: CastCredit, cropCols = false) {
  const from = typeof c.def.look === 'string' ? (BUST_FROM[c.def.look] ?? 0) : 0;
  const ls = cropRows(figure(specOf(c.def), exprOf(c)), from, from + 31);
  return cropCols ? ls.map((l) => ({ ...l, text: l.text.split('\n').map((r) => r.slice(4, 40)).join('\n') })) : ls;
}
function statLine(c: CastCredit, lang: UiLang) {
  return c.def.function === 'rival' ? t(lang, 'end.stat.rival', { won: c.trapsWon, broken: c.trapsBroken }) : t(lang, 'end.stat.questions', { q: c.questions, f: c.firstTry });
}
const square = { first: 'border-ember bg-ember', retry: 'border-gold bg-gold', weak: 'border-muted bg-transparent' } as const;

export function Ending(props: Props) {
  const phone = useIsPhone();
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<'roll' | 'end'>(props.startAtEnd || reduce ? 'end' : 'roll');
  useEffect(() => {
    if (phase !== 'roll') return;
    const id = setTimeout(() => setPhase('end'), ROLL_MS + 500);
    return () => clearTimeout(id);
  }, [phase]);
  const p = { ...props, phase, setPhase };
  return phone ? <ScaledBoard w={390} h={844} fit="width"><EndingPhone {...p} /></ScaledBoard> : <ScaledBoard w={1440} h={900}><EndingDesktop {...p} /></ScaledBoard>;
}

type Inner = Props & { phase: 'roll' | 'end'; setPhase: (p: 'roll' | 'end') => void };

function EndingDesktop({ result: r, lang, onRetry, onNewStory, onViewLog, phase, setPhase }: Inner) {
  const scene = useMemo(() => renderScene({ biome: 'city_gate', seed: 7 }, 'credits'), []);
  const busts = useMemo(() => r.cast.map((c) => bust(c)), [r.cast]);
  const weak = r.concepts.find((c) => c.outcome === 'weak') ?? r.concepts.find((c) => c.outcome === 'retry');
  return (
    <div className="relative h-[900px] w-[1440px] overflow-hidden bg-ink font-display text-cream">
      <AsciiArt layers={scene} fontPx={9} className="absolute left-0 top-0 opacity-55" />
      {phase === 'roll' ? (
        <>
          <main aria-label="Credits" className="absolute left-[400px] top-0 h-[900px] w-[640px] overflow-hidden border-x border-smoke bg-ink">
            <div className="lore-roll flex flex-col items-center px-14" style={{ ['--lore-roll-from' as string]: '860px', ['--lore-roll-to' as string]: '-2240px' }}>
              <span className="font-mono text-xs tracking-[0.3em] text-muted">{t(lang, 'end.presents')}</span>
              <h1 className="m-0 mt-[18px] text-center text-5xl font-bold leading-[1.05]">{r.title}</h1>
              <span className="mt-3.5 font-mono text-sm text-gold">{r.subtitle}</span>
              <span className="mt-2 font-mono text-xs text-muted">{t(lang, 'end.brewedFrom', { file: r.sourceFile, pages: r.pages })}</span>
              <span className="mt-[140px] font-mono text-xs font-bold tracking-[0.3em] text-muted">{t(lang, 'end.cast')}</span>
              {r.cast.map((c, i) => (
                <div key={c.def.id} className="mt-14 flex w-[528px] items-center gap-7">
                  <AsciiArt layers={busts[i]} fontPx={7} label={`${c.def.name}, ${exprOf(c)}`} />
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-[26px] font-bold tracking-[0.16em]" style={{ color: specOf(c.def).cloth }}>{c.def.name.toUpperCase()}</span>
                    <span className="text-base font-medium">{c.def.role}</span>
                    <span className="mt-2 font-mono text-xs text-muted">{t(lang, `end.verb.${c.def.function}` as UiKey)}</span>
                    <span className="font-mono text-[15px] leading-[1.45]">{lessonOf(c)}</span>
                    <span className="mt-1 font-mono text-xs text-gold">{statLine(c, lang)}</span>
                  </div>
                </div>
              ))}
              <span className="mt-[140px] font-mono text-xs font-bold tracking-[0.3em] text-muted">{t(lang, 'end.takeHome')}</span>
              <div className="mt-7 flex flex-col items-center gap-3.5">
                {r.concepts.map((k) => <span key={k.label} className={`font-mono text-lg ${k.outcome === 'weak' ? 'text-muted' : 'text-cream'}`}>{k.label}</span>)}
              </div>
              <div className="mt-[140px] grid grid-cols-2 gap-x-8 gap-y-2.5 font-mono text-[13px]">
                <span className="text-right text-muted">{t(lang, 'end.world')}</span><span>{r.world}</span>
                <span className="text-right text-muted">{t(lang, 'end.stirredBy')}</span><span>Hazel</span>
                <span className="text-right text-muted">{t(lang, 'end.writtenBy')}</span><span>{t(lang, 'end.writtenByValue')}</span>
                <span className="text-right text-muted">{t(lang, 'end.playedBy')}</span><span className="text-ember">{t(lang, 'end.you')}</span>
              </div>
              <span className="mt-40 text-[22px] font-bold">{t(lang, 'end.thanks')}</span>
            </div>
          </main>
          <button type="button" onClick={() => setPhase('end')} className="absolute bottom-8 right-10 h-11 border-2 border-smoke bg-ink px-[18px] font-mono text-[13px] font-bold">{t(lang, 'end.skip')}</button>
        </>
      ) : (
        <main aria-label={t(lang, 'end.theEnd')} className="lore-in absolute left-[340px] top-0 flex h-[900px] w-[760px] flex-col items-center border-x border-smoke bg-ink px-14 pt-[52px]">
          <span className="bg-ember px-3 py-[5px] font-mono text-xs font-bold tracking-[0.24em] text-ink">{t(lang, 'end.theEnd')}</span>
          <h1 className="m-0 mt-[18px] text-[44px] font-bold leading-[1.05]">{r.title}</h1>
          <span className="mt-2.5 font-mono text-[13px] text-gold">{r.subtitle}</span>
          <div className="mt-7 flex gap-5">
            {r.cast.map((c, i) => (
              <figure key={c.def.id} className="m-0 flex flex-col items-center gap-1.5">
                <AsciiArt layers={busts[i]} fontPx={5} label={`${c.def.name}, ${exprOf(c)}`} />
                <figcaption className="font-mono text-[11px] font-bold tracking-[0.14em]" style={{ color: specOf(c.def).cloth }}>{c.def.name.toUpperCase()}</figcaption>
              </figure>
            ))}
          </div>
          <div className="mt-7 grid w-[648px] grid-cols-[360px_minmax(0,1fr)] gap-x-8 border-t border-smoke pt-[22px]">
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[11px] font-bold tracking-[0.2em] text-muted">{t(lang, 'end.concepts')}</span>
              {r.concepts.map((k) => (
                <div key={k.label} className="flex h-[26px] items-center gap-2.5 font-mono text-[13px]">
                  <span aria-hidden className={`size-2.5 border-2 ${square[k.outcome]}`} />
                  <span className="flex-1">{k.label}</span>
                  <span className={`text-[11px] ${k.outcome === 'weak' ? 'text-ember' : 'text-muted'}`}>{t(lang, `end.outcome.${k.outcome}` as UiKey)}</span>
                </div>
              ))}
            </div>
            <Stats r={r} lang={lang} />
          </div>
          <div className="mt-7 flex w-[648px] gap-2.5">
            {weak && <button type="button" onClick={() => onRetry(weak.label)} className="h-[52px] flex-1 bg-ember font-mono text-sm font-bold text-ink">{t(lang, 'end.retry', { concept: weak.label })}</button>}
            <button type="button" onClick={onNewStory} className={`h-[52px] border-2 border-cream px-5 font-mono text-[13px] font-bold ${weak ? '' : 'flex-1'}`}>{t(lang, 'end.newStory')}</button>
          </div>
          <div className="mt-2.5 flex w-[648px] justify-between">
            <button type="button" onClick={() => setPhase('roll')} className="h-11 font-mono text-xs text-muted">{t(lang, 'end.replayCredits')}</button>
            <button type="button" onClick={onViewLog} className="h-11 font-mono text-xs text-muted">{t(lang, 'end.viewLog')}</button>
          </div>
        </main>
      )}
    </div>
  );
}

function Stats({ r, lang }: { r: StoryResult; lang: UiLang }) {
  const mastered = r.concepts.filter((c) => c.outcome !== 'weak').length;
  return (
    <div className="grid grid-cols-2 content-start gap-x-4 gap-y-[18px] pt-6">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] tracking-[0.16em] text-muted">{t(lang, 'common.hp')}</span>
        <span className="flex gap-[3px]" aria-label={`${r.hp}/${r.hpMax}`}>
          {Array.from({ length: r.hpMax }, (_, i) => <span key={i} className={`size-2.5 ${i < r.hp ? 'bg-ember' : 'border-2 border-smoke'}`} />)}
        </span>
      </div>
      <Stat label={t(lang, 'end.accuracy')} value={`${r.firstTryCorrect}/${r.questions}`} />
      <Stat label={t(lang, 'end.concepts')} value={`${mastered}/${r.concepts.length}`} />
      <Stat label={t(lang, 'end.time')} value={t(lang, 'end.minutes', { n: r.minutes })} />
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col gap-1"><span className="font-mono text-[11px] tracking-[0.16em] text-muted">{label}</span><span className="font-mono text-xl font-bold">{value}</span></div>;
}

function lessonOf(c: CastCredit) {
  return c.lesson;
}

function EndingPhone({ result: r, lang, onRetry, onNewStory, phase, setPhase }: Inner) {
  const scene = useMemo(() => renderScene({ biome: 'city_gate', seed: 7 }, 'creditsPhone'), []);
  const busts = useMemo(() => r.cast.map((c) => bust(c)), [r.cast]);
  const tiny = useMemo(() => r.cast.map((c) => bust(c, true)), [r.cast]);
  const weak = r.concepts.find((c) => c.outcome === 'weak') ?? r.concepts.find((c) => c.outcome === 'retry');
  const mastered = r.concepts.filter((c) => c.outcome !== 'weak').length;
  return (
    <div className="relative h-[844px] w-[390px] overflow-hidden bg-ink font-display text-cream">
      {phase === 'roll' ? (
        <>
          <AsciiArt layers={scene} fontPx={6} className="absolute bottom-0 left-0 opacity-45" />
          <main aria-label="Credits" className="absolute inset-0 overflow-hidden">
            <div className="lore-roll flex flex-col items-center px-6 text-center" style={{ ['--lore-roll-from' as string]: '800px', ['--lore-roll-to' as string]: '-2200px' }}>
              <span className="font-mono text-[11px] tracking-[0.3em] text-muted">{t(lang, 'end.presents')}</span>
              <h1 className="m-0 mt-3.5 text-[32px] font-bold leading-[1.1]">{r.title}</h1>
              <span className="mt-2.5 font-mono text-xs text-gold">{r.subtitle}</span>
              <span className="mt-[110px] font-mono text-[11px] font-bold tracking-[0.3em] text-muted">{t(lang, 'end.cast')}</span>
              {r.cast.map((c, i) => (
                <div key={c.def.id} className="mt-11 flex flex-col items-center gap-1">
                  <AsciiArt layers={busts[i]} fontPx={6} label={`${c.def.name}, ${exprOf(c)}`} />
                  <span className="mt-1.5 font-mono text-xl font-bold tracking-[0.16em]" style={{ color: specOf(c.def).cloth }}>{c.def.name.toUpperCase()}</span>
                  <span className="text-sm">{c.def.role}</span>
                  <span className="mt-1.5 font-mono text-[11px] text-muted">{t(lang, `end.verb.${c.def.function}` as UiKey)}</span>
                  <span className="font-mono text-[13px] leading-[1.45]">{lessonOf(c)}</span>
                  <span className="font-mono text-[11px] text-gold">{statLine(c, lang)}</span>
                </div>
              ))}
              <span className="mt-[110px] font-mono text-[11px] font-bold tracking-[0.3em] text-muted">{t(lang, 'end.takeHome')}</span>
              <div className="mt-5 flex flex-col gap-2.5">{r.concepts.map((k) => <span key={k.label} className={`font-mono text-[15px] ${k.outcome === 'weak' ? 'text-muted' : ''}`}>{k.label}</span>)}</div>
              <span className="mt-[120px] text-lg font-bold">{t(lang, 'end.thanks')}</span>
            </div>
          </main>
          <button type="button" onClick={() => setPhase('end')} className="absolute right-4 top-4 h-11 border-2 border-smoke bg-ink px-3.5 font-mono text-xs font-bold">{t(lang, 'end.skip')}</button>
        </>
      ) : (
        <main aria-label={t(lang, 'end.theEnd')} className="lore-in absolute inset-0 flex flex-col items-center px-4 pt-9">
          <span className="bg-ember px-2.5 py-1 font-mono text-[11px] font-bold tracking-[0.24em] text-ink">{t(lang, 'end.theEnd')}</span>
          <h1 className="m-0 mt-3.5 text-center text-[28px] font-bold leading-[1.1]">{r.title}</h1>
          <span className="mt-2 font-mono text-[11px] text-gold">{r.subtitle}</span>
          <div className="mt-5 flex gap-1">
            {r.cast.map((c, i) => (
              <figure key={c.def.id} className="m-0 flex flex-col items-center gap-1">
                <AsciiArt layers={tiny[i]} fontPx={4} label={`${c.def.name}, ${exprOf(c)}`} />
                <figcaption className="font-mono text-[10px] font-bold tracking-[0.12em]" style={{ color: specOf(c.def).cloth }}>{c.def.name.toUpperCase()}</figcaption>
              </figure>
            ))}
          </div>
          <div className="mt-[18px] grid w-full grid-cols-4 border-y border-smoke py-3 text-center font-mono">
            <MiniStat label={t(lang, 'common.hp')} value={`${r.hp}/${r.hpMax}`} ember />
            <MiniStat label={t(lang, 'end.accuracy')} value={`${r.firstTryCorrect}/${r.questions}`} />
            <MiniStat label={t(lang, 'end.concepts')} value={`${mastered}/${r.concepts.length}`} />
            <MiniStat label={t(lang, 'end.time')} value={`${r.minutes}m`} />
          </div>
          <div className="mt-3.5 flex w-full flex-col gap-1">
            {r.concepts.map((k) => (
              <div key={k.label} className="flex h-7 items-center gap-2.5 font-mono text-[13px]">
                <span aria-hidden className={`size-2.5 border-2 ${square[k.outcome]}`} />
                <span className="flex-1">{k.label}</span>
                <span className={`text-[10px] ${k.outcome === 'weak' ? 'text-ember' : 'text-muted'}`}>{t(lang, `end.outcomeShort.${k.outcome}` as UiKey)}</span>
              </div>
            ))}
          </div>
          <div className="absolute inset-x-4 bottom-5 flex flex-col gap-2">
            {weak && <button type="button" onClick={() => onRetry(weak.label)} className="h-[52px] bg-ember font-mono text-sm font-bold text-ink">{t(lang, 'end.retry', { concept: weak.label })}</button>}
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={onNewStory} className="h-11 border-2 border-cream font-mono text-xs font-bold">{t(lang, 'end.newStory')}</button>
              <button type="button" onClick={() => setPhase('roll')} className="h-11 border-2 border-smoke font-mono text-xs font-bold text-muted">{t(lang, 'end.replayCredits')}</button>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
function MiniStat({ label, value, ember }: { label: string; value: string; ember?: boolean }) {
  return <span className="flex flex-col gap-0.5"><span className="text-[10px] text-muted">{label}</span><span className={`text-base font-bold ${ember ? 'text-ember' : ''}`}>{value}</span></span>;
}
