'use client';

/**
 * Home, option B (DESIGN-SYSTEM §4.7): Hazel greets you; the input is the reply row of her dialogue.
 * Adding a file switches Hazel to `surprised` and changes her line. A file is required to brew
 * when no topic is typed (same rule as Preparation).
 */
import { useMemo, useRef, useState } from 'react';
import { renderBust, renderCharacter } from '@/lib/ascii';
import { t, type UiLang } from '@/lib/i18n/ui';
import { useIsPhone } from '@/lib/hooks/media';
import { AsciiArt } from '@/components/ascii/AsciiArt';
import { PumpkinField, type PumpkinPlacement } from '@/components/ascii/PumpkinField';
import { ScaledBoard } from '@/components/layout/ScaledBoard';

const ACCEPT = '.pdf,.docx,.pptx,.txt,.md';
const MAX_BYTES = 25 * 1024 * 1024;
const PUMPKINS_DESKTOP: PumpkinPlacement[] = [
  { x: 60, y: 60, fs: 8, w: 24, seed: 3 }, { x: 1200, y: 40, fs: 10, w: 26, seed: 9 }, { x: 1180, y: 330, fs: 12, w: 22, seed: 6 },
  { x: 40, y: 760, fs: 8, w: 18, seed: 2 }, { x: 1290, y: 700, fs: 10, w: 18, seed: 11 }, { x: 960, y: 250, fs: 6, w: 14, seed: 5 },
];
const PUMPKINS_PHONE: PumpkinPlacement[] = [{ x: 250, y: 190, fs: 7, w: 20, seed: 9 }, { x: 290, y: 330, fs: 5, w: 14, seed: 5 }, { x: -20, y: 20, fs: 5, w: 18, seed: 3 }];

interface Props {
  lang: UiLang;
  onBrew: (input: { text: string; file: File | null }) => void;
  onPlayDemo: () => void;
}

function useHome(lang: UiLang, onBrew: Props['onBrew']) {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const pick = useRef<HTMLInputElement>(null);
  const input = (
    <input ref={pick} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1}
      onChange={(e) => { const f = e.target.files?.[0]; if (f && f.size <= MAX_BYTES) setFile(f); e.target.value = ''; }} />
  );
  return {
    file, text, setText, input,
    openPicker: () => pick.current?.click(),
    clear: () => setFile(null),
    submit: () => { if (file || text.trim()) onBrew({ text: text.trim(), file }); },
    line: (short: boolean) => (file ? t(lang, short ? 'home.gotFileShort' : 'home.gotFile', { file: file.name }) : t(lang, short ? 'home.greetingShort' : 'home.greeting')),
  };
}

export function HomeGreeting(props: Props) {
  const phone = useIsPhone();
  return phone ? <ScaledBoard w={390} h={844} fit="width"><HomePhone {...props} /></ScaledBoard> : <ScaledBoard w={1440} h={900}><HomeDesktop {...props} /></ScaledBoard>;
}

function FileChip({ name, onRemove, lang }: { name: string; onRemove: () => void; lang: UiLang }) {
  return (
    <span className="inline-flex h-7 items-center gap-2 bg-ink pl-2.5 pr-1 font-mono text-xs text-cream">
      {name}
      <button type="button" aria-label={t(lang, 'home.removeFile')} onClick={onRemove} className="size-6 text-muted">✕</button>
    </span>
  );
}

function HomeDesktop({ lang, onBrew, onPlayDemo }: Props) {
  const h = useHome(lang, onBrew);
  const hazel = useMemo(() => renderCharacter('hazel', h.file ? 'surprised' : 'smile'), [h.file]);
  return (
    <div className="lore-grid-bg relative h-[900px] w-[1440px] overflow-hidden font-display text-cream">
      <PumpkinField items={PUMPKINS_DESKTOP} />
      <div className="absolute inset-x-0 top-[72px] flex flex-col items-center gap-2.5">
        <span className="pl-[0.5em] font-mono text-[40px] font-bold tracking-[0.5em]">LORE</span>
        <span className="text-base text-muted">{t(lang, 'common.tagline')}</span>
      </div>
      <section aria-label="Start a story" className="lore-dialog absolute left-[450px] top-[548px] flex min-h-[212px] w-[780px] flex-col">
        <div className="lore-nametag absolute -top-[18px] left-10 flex h-[30px] items-center gap-2.5 px-3">
          <span className="text-[13px] text-cloth-hazel">HAZEL</span>
          <span className="font-normal tracking-normal text-[11px] text-muted">{t(lang, 'home.hazelRole')}</span>
        </div>
        <p className="m-0 flex-1 px-10 pt-7 font-mono text-[17px] leading-[1.6]">{h.line(false)}</p>
        {h.file && <div className="px-10 pb-2.5"><FileChip name={h.file.name} onRemove={h.clear} lang={lang} /></div>}
        <form className="flex h-14 items-stretch border-t-2 border-ink" onSubmit={(e) => { e.preventDefault(); h.submit(); }}>
          <label htmlFor="home-ask" className="sr-only">{t(lang, 'home.placeholder')}</label>
          <div className="flex flex-1 items-center gap-2.5 pl-10">
            <span aria-hidden className="font-mono font-bold">&gt;</span>
            <input id="home-ask" value={h.text} onChange={(e) => h.setText(e.target.value)} placeholder={t(lang, 'home.placeholder')}
              className="h-11 flex-1 border-0 bg-transparent font-mono text-[15px] text-ink outline-none placeholder:text-ink-soft" />
          </div>
          {h.input}
          <button type="button" onClick={h.openPicker} className={`flex items-center gap-2 border-l-2 border-ink px-[18px] font-mono text-[13px] font-bold ${h.file ? 'bg-ink text-cream' : 'text-ink'}`}>
            <ClipIcon />{h.file ? t(lang, 'home.replace') : t(lang, 'home.addFile')}
          </button>
          <button type="submit" className="border-l-2 border-ink bg-ember px-5 font-mono text-[13px] font-bold text-ink">{t(lang, 'home.brew')}</button>
        </form>
      </section>
      <AsciiArt layers={hazel} fontPx={10} label={`Hazel, ${h.file ? 'surprised' : 'smile'}`} className="absolute left-[230px] top-[300px]" />
      <div className="absolute left-[450px] top-[790px] flex w-[780px] items-center justify-between">
        <span className="font-mono text-xs text-muted">{t(lang, 'common.formats')}</span>
        <button type="button" onClick={onPlayDemo} className="flex h-11 items-center gap-2.5 border-2 border-smoke px-4 font-mono text-[13px]"><PlayIcon />{t(lang, 'common.playDemo')}</button>
      </div>
    </div>
  );
}

function HomePhone({ lang, onBrew, onPlayDemo }: Props) {
  const h = useHome(lang, onBrew);
  const hazel = useMemo(() => renderBust('hazel', h.file ? 'surprised' : 'smile'), [h.file]);
  return (
    <div className="lore-grid-bg relative h-[844px] w-[390px] overflow-hidden font-display text-cream">
      <PumpkinField items={PUMPKINS_PHONE} />
      <div className="absolute inset-x-0 top-14 flex flex-col items-center gap-1.5">
        <span className="pl-[0.5em] font-mono text-[26px] font-bold tracking-[0.5em]">LORE</span>
        <span className="text-sm text-muted">{t(lang, 'common.tagline')}</span>
      </div>
      <AsciiArt layers={hazel} fontPx={9} label={`Hazel, ${h.file ? 'surprised' : 'smile'}`} className="absolute left-2.5 top-[150px]" />
      <section aria-label="Start a story" className="lore-dialog absolute left-3 top-[420px] flex w-[366px] flex-col">
        <div className="lore-nametag absolute -top-4 left-3.5 flex h-[26px] items-center px-2.5"><span className="text-xs text-cloth-hazel">HAZEL</span></div>
        <p className="m-0 px-4 pb-3 pt-[22px] font-mono text-[13px] leading-[1.55]">{h.line(true)}</p>
        {h.file && <div className="px-4 pb-2.5"><FileChip name={h.file.name} onRemove={h.clear} lang={lang} /></div>}
        <form className="flex flex-col border-t-2 border-ink" onSubmit={(e) => { e.preventDefault(); h.submit(); }}>
          <label htmlFor="home-ask-m" className="sr-only">{t(lang, 'home.placeholder')}</label>
          <div className="flex h-[52px] items-center gap-2 px-3.5">
            <span aria-hidden className="font-mono font-bold">&gt;</span>
            <input id="home-ask-m" value={h.text} onChange={(e) => h.setText(e.target.value)} placeholder={t(lang, 'home.placeholder')}
              className="h-11 min-w-0 flex-1 border-0 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-ink-soft" />
          </div>
          {h.input}
          <div className="grid h-[50px] grid-cols-2 border-t-2 border-ink">
            <button type="button" onClick={h.openPicker} className={`flex items-center justify-center gap-2 font-mono text-[13px] font-bold ${h.file ? 'bg-ink text-cream' : 'text-ink'}`}><ClipIcon />{h.file ? t(lang, 'home.replace') : t(lang, 'home.addFile')}</button>
            <button type="submit" className="border-l-2 border-ink bg-ember font-mono text-[13px] font-bold text-ink">{t(lang, 'home.brew')}</button>
          </div>
        </form>
      </section>
      <span className="absolute inset-x-0 top-[726px] text-center font-mono text-[11px] text-muted">{t(lang, 'common.formatsShort')}</span>
      <button type="button" onClick={onPlayDemo} className="absolute inset-x-4 bottom-7 flex h-[52px] items-center justify-center gap-2.5 border-2 border-smoke font-mono text-[13px]"><PlayIcon />{t(lang, 'common.playDemoLong')}</button>
    </div>
  );
}

function ClipIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" /></svg>;
}
function PlayIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--color-ember)" aria-hidden="true"><path d="M6 4l14 8-14 8z" /></svg>;
}
