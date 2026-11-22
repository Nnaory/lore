'use client';

/**
 * Cream visual-novel dialogue box (docs/DESIGN-SYSTEM.md §4.3).
 * Desktop: name tag + role, 17px mono text, bottom bar [> ask …][fast|animate][log].
 * Phone (< md): 13px text, choices inside the box, bottom bar [> Ask…][fast|animate][log].
 *
 * Optional props (task 1.4; defaults keep the Kit look): `askDisabled` disables the ask input,
 * `onAdvance` makes the text area a click/Enter/Space target, `testIds` adds data-testid hooks,
 * `nameTag={false}` hides the speaker tag, `wrapText` wraps the paragraph, `testIds.mode` marks the fast|animate group. ChoiceButton adds `letter`, `title`, `testId`,
 * `ariaPressed`, `disabled`; its label clamps to 2 lines.
 * Task 5.5 (Home B): ottomBar swaps the whole bottom bar; padLeft sets the desktop text/name-tag inset.
 * Phone (task 2.3): the text area scrolls inside the fixed 250px box (`min-h-0`), and the bottom bar
 * sits directly under the choices (the 8px gap above it is desktop only).
 */
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

export type TextMode = 'fast' | 'animate';

/** data-testid hooks per part; every key is optional. */
export interface DialogueTestIds {
  root?: string; nameTag?: string; text?: string; advance?: string; ask?: string;
  fast?: string; animate?: string; log?: string;
  /** The fast|animate button group (task 1.25). */
  mode?: string;
}

interface Props {
  speakerName: string;
  speakerRole?: string;
  /** Name colour: gold by default; a character's cloth colour on Home B (Hazel = var(--color-cloth-hazel)). */
  nameColor?: string;
  text: string;
  /** Optional choice buttons (render <ChoiceButton>s). */
  choices?: ReactNode;
  mode: TextMode;
  onModeChange: (m: TextMode) => void;
  onAsk?: (q: string) => void;
  onOpenLog: () => void;
  askPlaceholder?: string;
  /** Disable the ask input (feature not available yet). */
  askDisabled?: boolean;
  /** Called when the text area is clicked (or Enter/Space is pressed on it). */
  onAdvance?: () => void;
  testIds?: DialogueTestIds;
  /** Show the speaker name tag. Default true. */
  nameTag?: boolean;
  /** Wraps the text paragraph (task 1.25: narration-block, learning-card, character-bubble hooks). */
  wrapText?: (paragraph: ReactNode) => ReactNode;
  /** Replaces the whole bottom bar (Home B puts the composer here: input, Add file, Brew it). */
  bottomBar?: ReactNode;
  /** Desktop left inset in px for the text and the name tag (default 96; Home B uses 40). */
  padLeft?: number;
  className?: string;
}

export function DialogueBox({
  speakerName, speakerRole, nameColor, text, choices, mode, onModeChange, onAsk, onOpenLog,
  askPlaceholder = `Ask ${speakerName.charAt(0) + speakerName.slice(1).toLowerCase()} something…`,
  askDisabled = false, onAdvance, testIds, nameTag = true, wrapText, bottomBar, padLeft, className,
}: Props) {
  const paragraph = (
    <p data-testid={testIds?.text} className="m-0 max-w-[700px] whitespace-pre-line font-mono text-[13px] leading-[1.55] md:text-[17px] md:leading-[1.6]">{text}</p>
  );
  return (
    <section aria-label="Dialogue" data-testid={testIds?.root} style={padLeft === undefined ? undefined : ({ '--dlg-pl': `${padLeft}px` } as CSSProperties)} className={`lore-dialog relative flex flex-col ${className ?? ''}`}>
      {nameTag && <div data-testid={testIds?.nameTag} className="lore-nametag absolute -top-4 left-3.5 flex h-[26px] items-center gap-2.5 px-2.5 md:-top-[18px] md:left-[var(--dlg-pl,6rem)] md:h-[30px] md:px-3">
        <span className="text-xs md:text-[13px]" style={{ color: nameColor ?? 'var(--color-gold)' }}>
          {speakerName.toUpperCase()}
        </span>
        {speakerRole && <span className="hidden font-normal tracking-normal text-[11px] text-muted md:inline">{speakerRole}</span>}
      </div>}

      <div
        data-testid={testIds?.advance}
        {...(onAdvance ? {
          role: 'button' as const,
          tabIndex: 0,
          onClick: onAdvance,
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdvance(); }
          },
        } : {})}
        className={`relative min-h-0 flex-1 px-4 pt-5 max-md:overflow-y-auto md:pl-[var(--dlg-pl,6rem)] md:pr-14 md:pt-[26px] ${onAdvance ? 'cursor-pointer' : ''}`}
      >
        {wrapText ? wrapText(paragraph) : paragraph}
        <span aria-hidden className="absolute bottom-0.5 right-3 text-xs text-ember md:right-6 md:text-sm">▼</span>
      </div>

      {choices && (
        <div role="group" aria-label="Choices" className="flex gap-1.5 px-2.5 pb-2.5 pt-2 md:hidden">
          {choices}
        </div>
      )}

      {bottomBar ?? <div className="flex h-[46px] md:mt-2 items-stretch border-t-2 border-ink md:h-[52px]">
        <form
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3 md:pl-24"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('ask') as HTMLInputElement;
            if (input.value.trim()) onAsk?.(input.value.trim());
            input.value = '';
          }}
        >
          <span aria-hidden className="font-mono font-bold">&gt;</span>
          <label htmlFor="lore-ask" className="sr-only">{askPlaceholder}</label>
          <input
            id="lore-ask"
            name="ask"
            data-testid={testIds?.ask}
            disabled={askDisabled}
            placeholder={askPlaceholder}
            className="h-11 min-w-0 flex-1 border-0 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-soft md:text-sm"
          />
        </form>
        <div role="group" aria-label="Text speed" data-testid={testIds?.mode} className="flex shrink-0 border-l-2 border-ink">
          {(['fast', 'animate'] as const).map((m, i) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              data-testid={testIds?.[m]}
              onClick={() => onModeChange(m)}
              className={`font-mono text-[11px] font-bold md:text-xs ${i ? 'w-[72px] border-l-2 border-ink md:w-[92px]' : 'w-[52px] md:w-[76px]'} ${
                mode === m ? 'bg-ink text-cream' : 'bg-transparent text-ink'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button type="button" data-testid={testIds?.log} onClick={onOpenLog} className="w-14 shrink-0 border-l-2 border-ink bg-ember font-mono text-[11px] font-bold text-ink md:w-[84px] md:text-xs">
          log
        </button>
      </div>}
    </section>
  );
}

/**
 * Answer chip. Desktop puts these in the canvas frame; phone puts them in the dialogue box.
 * Optional: `letter` prefix (A, B, ...), `title` (tooltip, defaults to the label because the label
 * clamps to 2 lines), `testId`, `ariaPressed`, `disabled`.
 */
export function ChoiceButton({
  label, state, onClick, letter, title, testId, ariaPressed, disabled,
}: {
  label: string; state: 'idle' | 'picked' | 'correct'; onClick: () => void;
  letter?: string; title?: string; testId?: string; ariaPressed?: boolean; disabled?: boolean;
}) {
  const look = state === 'correct' ? 'bg-ember text-ink border-ember' : state === 'picked' ? 'bg-cream text-ink border-cream' : 'bg-smoke text-cream border-smoke';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      data-testid={testId}
      aria-pressed={ariaPressed}
      disabled={disabled}
      className={`h-11 min-w-0 flex-1 border-2 px-4 font-mono text-xs font-bold tracking-[0.08em] disabled:cursor-not-allowed md:min-w-[112px] md:flex-initial md:text-[13px] ${look}`}
    >
      <span className="line-clamp-2">{letter && <span aria-hidden className="mr-2">{letter}</span>}{label}</span>
    </button>
  );
}