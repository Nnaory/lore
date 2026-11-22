'use client';

/**
 * Council of Voices (DESIGN-SYSTEM §4.9.3) — used when beat.mode === 'council' (misconception questions).
 * Replaces the canvas content: 3 columns, each a character bust (6px cells) + claim + "Trust X".
 * One click commits (no preview step). Expressions react: chosen wrong voice smiles (it fooled you),
 * the correct voice smiles on success, the rival turns angry when beaten.
 */
import { useMemo } from 'react';
import type { CharacterDef, ChoiceBeat, Expression } from '@/lib/schemas/visual';
import { CAST, figure, cropRows, type CastId } from '@/lib/ascii';
import { t, type UiLang } from '@/lib/i18n/ui';
import { AsciiArt } from '@/components/ascii/AsciiArt';
import { CanvasFrame } from '@/components/story/CanvasFrame';

const BUST_FROM: Partial<Record<CastId, number>> = { mira: 6, nyx: 6 };

export function CouncilVoices({ beat, cast, picked, onPick, lang }: { beat: ChoiceBeat; cast: CharacterDef[]; picked: string | null; onPick: (optionId: string) => void; lang: UiLang }) {
  const correctId = beat.options.find((o) => o.correct)?.id;
  const solved = picked === correctId;
  const chip = !picked ? { text: t(lang, 'council.chip.pick'), tone: 'ember' as const } : solved ? { text: t(lang, 'council.chip.proven'), tone: 'gold' as const } : { text: t(lang, 'council.chip.fooled'), tone: 'cream' as const };
  return (
    <CanvasFrame title={t(lang, 'council.title')} label={t(lang, 'council.subtitle')} chip={chip} className="h-full w-full">
      <div className="absolute inset-0 grid grid-cols-3">
        {beat.options.slice(0, 3).map((o, i) => {
          const def = cast.find((c) => c.id === o.voice?.speaker);
          const chosen = picked === o.id;
          const isRival = def?.function === 'rival';
          const expr: Expression = !picked ? (o.voice?.expression ?? 'calm') : solved ? (o.correct ? 'smile' : isRival ? 'angry' : 'surprised') : chosen ? 'smile' : o.correct ? 'worried' : (o.voice?.expression ?? 'calm');
          return (
            <Voice key={o.id} def={def} expr={expr} mood={o.voice?.mood ?? ''} claim={o.voice?.claim ?? o.label}
              chosen={chosen} picked={!!picked} correct={!!o.correct} solved={solved} first={i === 0} lang={lang} onPick={() => !picked && onPick(o.id)} />
          );
        })}
      </div>
    </CanvasFrame>
  );
}

function Voice({ def, expr, mood, claim, chosen, picked, correct, solved, first, lang, onPick }: {
  def?: CharacterDef; expr: Expression; mood: string; claim: string; chosen: boolean; picked: boolean; correct: boolean; solved: boolean; first: boolean; lang: UiLang; onPick: () => void;
}) {
  const look = def ? (typeof def.look === 'string' ? CAST[def.look] : def.look) : CAST.eldric;
  const from = def && typeof def.look === 'string' ? (BUST_FROM[def.look] ?? 0) : 0;
  const layers = useMemo(() => cropRows(figure(look, expr), from, from + 31), [look, expr, from]);
  const name = (def?.name ?? '').toUpperCase();
  const ring = picked && correct ? 'shadow-[inset_0_0_0_2px_var(--color-ember)]' : chosen && !solved ? 'shadow-[inset_0_0_0_2px_var(--color-cream)]' : '';
  const btn = chosen ? (solved ? 'border-ember bg-ember text-ink' : 'border-cream bg-cream text-ink') : picked ? 'border-smoke text-muted' : 'border-cream text-cream';
  return (
    <div className={`relative flex flex-col items-center px-3.5 pb-3 ${first ? '' : 'border-l-2 border-smoke'} ${ring}`}>
      <AsciiArt layers={layers} fontPx={6} label={`${name}, ${expr}`} />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="font-mono text-[13px] font-bold tracking-[0.14em]" style={{ color: look.cloth }}>{name}</span>
        <span className="font-mono text-[10px] text-muted">{mood}</span>
      </div>
      <p className="m-0 mt-1.5 flex-1 text-center font-mono text-xs leading-[1.5] text-cream">{claim}</p>
      <button type="button" onClick={onPick} disabled={picked} className={`mt-2 h-11 w-full border-2 font-mono text-xs font-bold ${btn}`}>
        {picked ? (chosen ? t(lang, 'council.youTrust') : '—') : t(lang, 'council.trust', { name: (def?.name ?? '') })}
      </button>
      {picked && (chosen || correct) && (
        <span className={`absolute right-3 top-2 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.12em] text-ink ${correct ? 'bg-ember' : 'bg-cream'}`}>{t(lang, correct ? 'council.right' : 'council.wrong')}</span>
      )}
    </div>
  );
}
