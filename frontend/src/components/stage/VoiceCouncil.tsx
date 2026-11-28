/**
 * VoiceCouncil: the answers of a puzzle as a council of characters (desktop canvas)
 *
 * Why: instead of a row of plain answer buttons, each answer is a claim made by one of the story's
 * characters, drawn as a column with the character's ASCII bust, name, role, the claim and a
 * "Trust <name>" button; the question runs along the top. It fills the canvas frame when the
 * puzzle has no picture or animation of its own (a puzzle with a picture keeps the picture and gets
 * `ChoiceButton`s that name the speaker). Picking a voice only selects that answer, exactly like
 * clicking an answer button: the player still presses Submit, and right or wrong comes only from
 * the puzzle interaction (`validateMultipleChoice`). Test ids are the plain buttons' ids
 * (`puzzle-choices`, `choice-<id>`), so everything that clicks an answer works unchanged.
 *
 * A claim longer than its box is clamped to a few lines; hovering or focusing the column shows the
 * whole claim over the column (no layout shift, nothing is cut off), and it is also the tooltip.
 */

"use client";

import { useMemo } from "react";
import { AsciiArt } from "@/components/ascii/AsciiArt";
import { useBoardPixelRatio } from "@/components/stage/ScaledBoard";
import { renderBust } from "@/lib/ascii";
import { councilText, VOICE_NAME_CLASS, type CouncilLanguage, type Voice } from "@/lib/story/voice-council";

type VoiceCouncilProps = {
  question: string;
  voices: Voice[];
  language: CouncilLanguage;
  selectedChoiceId: string | null;
  /** True once the right answer was submitted: the voices lock. */
  locked: boolean;
  onSelect: (choiceId: string) => void;
};

const BUST_FONT_PX = 4;

function VoiceColumn({
  voice,
  language,
  selected,
  locked,
  onSelect,
}: {
  voice: Voice;
  language: CouncilLanguage;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
}) {
  const layers = useMemo(() => renderBust(voice.castId, "calm"), [voice.castId]);
  const pixelRatio = useBoardPixelRatio();
  const text = councilText(language);
  return (
    <div
      className={`group/voice relative flex min-w-0 flex-1 flex-col items-center gap-2 px-3 py-3 ${
        selected ? "bg-smoke/60" : ""
      }`}
    >
      <AsciiArt layers={layers} fontPx={BUST_FONT_PX} pixelRatio={pixelRatio} label={voice.name} />
      <p className="m-0 flex max-w-full items-baseline gap-1.5 font-mono">
        <span className={`text-[12px] font-bold uppercase tracking-[0.12em] ${VOICE_NAME_CLASS[voice.castId]}`}>
          {voice.name}
        </span>
        <span className="truncate text-[11px] text-muted">{voice.role}</span>
      </p>
      {/* Fixed-height slot: the claim grows over what is below it on hover, so nothing moves. */}
      <div className="relative h-[84px] w-full">
        <p
          title={voice.text}
          className="pointer-events-none absolute inset-x-0 top-0 m-0 line-clamp-4 bg-ink text-center font-mono text-[13px] leading-[1.45] text-cream group-focus-within/voice:bottom-0 group-focus-within/voice:top-auto group-focus-within/voice:z-20 group-focus-within/voice:line-clamp-none group-focus-within/voice:border group-focus-within/voice:border-gold group-focus-within/voice:p-2 group-hover/voice:bottom-0 group-hover/voice:top-auto group-hover/voice:z-20 group-hover/voice:line-clamp-none group-hover/voice:border group-hover/voice:border-gold group-hover/voice:p-2"
        >
          {"\u201C"}{voice.text}{"\u201D"}
        </p>
      </div>
      <button
        type="button"
        data-testid={`choice-${voice.choiceId}`}
        aria-pressed={selected}
        disabled={locked}
        title={voice.text}
        onClick={onSelect}
        className={`mt-auto min-h-[44px] w-full cursor-pointer border-2 px-2 font-mono text-[12px] font-bold disabled:cursor-not-allowed ${
          selected ? "border-ember bg-ember text-ink" : "border-cream bg-transparent text-cream"
        }`}
      >
        {text.trust(voice.name)}
      </button>
    </div>
  );
}

export function VoiceCouncil({ question, voices, language, selectedChoiceId, locked, onSelect }: VoiceCouncilProps) {
  const text = councilText(language);
  return (
    <div data-testid="voice-council" className="absolute inset-0 flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 pt-2">
        <p className="m-0 min-w-0 truncate font-mono text-[11px] tracking-[0.12em] text-gold">
          {text.title} <span className="tracking-normal text-muted" title={question}>/ {question}</span>
        </p>
        <span className="shrink-0 bg-ember px-2 py-1 font-mono text-[11px] font-bold tracking-[0.12em] text-ink">
          {text.pickOne}
        </span>
      </div>
      <div
        data-testid="puzzle-choices"
        role="group"
        aria-label="Answer choices"
        className="mt-2 flex min-h-0 flex-1 divide-x divide-smoke border-t border-smoke"
      >
        {voices.map((voice) => (
          <VoiceColumn
            key={voice.choiceId}
            voice={voice}
            language={language}
            selected={selectedChoiceId === voice.choiceId}
            locked={locked}
            onSelect={() => onSelect(voice.choiceId)}
          />
        ))}
      </div>
    </div>
  );
}


