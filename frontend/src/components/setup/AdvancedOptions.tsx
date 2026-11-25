/**
 * AdvancedOptions
 *
 * Optional story preferences shown inside "03 CHAPTERS" when its "Advanced options" link
 * is open (the link in ChaptersSection is the only toggle): story language as a two-segment
 * radiogroup and free-form instructions for the storyteller with an `n / 500` counter.
 * Story length is not here: it is set by the CHAPTERS boxes (design 6.3). Transparent surface.
 */

"use client";

import {
  MAX_INSTRUCTIONS_CHARS,
  type StoryLanguage,
} from "@/lib/setup/create-form";

type AdvancedOptionsProps = {
  language: StoryLanguage;
  customInstructions: string;
  onLanguageChange: (language: StoryLanguage) => void;
  onInstructionsChange: (text: string) => void;
};

const LANGUAGES: Array<{ value: StoryLanguage; label: string }> = [
  { value: "en", label: "English" },
  { value: "id", label: "Bahasa Indonesia" },
];

const fieldLabel = "mb-2 block font-mono uppercase text-[11px] font-bold tracking-[0.12em] text-muted";

export function AdvancedOptions(props: AdvancedOptionsProps) {
  return (
    <div className="flex flex-col gap-5" data-testid="advanced-options">
      <div>
        <span id="story-language-label" className={fieldLabel}>
          Story language
        </span>
        <div
          role="radiogroup"
          aria-labelledby="story-language-label"
          data-testid="story-language"
          className="flex"
        >
          {LANGUAGES.map((option) => {
            const checked = props.language === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                data-testid={`language-${option.value}`}
                onClick={() => props.onLanguageChange(option.value)}
                className={`h-11 flex-1 cursor-pointer border-2 border-smoke font-mono text-[13px] font-bold md:flex-none md:px-5 ${
                  checked ? "bg-cream text-ink" : "bg-transparent text-cream"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label htmlFor="story-instructions" className={fieldLabel}>
          Instructions for the storyteller
        </label>
        <textarea
          id="story-instructions"
          data-testid="story-instructions"
          rows={3}
          maxLength={MAX_INSTRUCTIONS_CHARS}
          value={props.customInstructions}
          onChange={(e) => props.onInstructionsChange(e.target.value)}
          placeholder="e.g. Set it in a coastal town. Keep the tone light."
          className="w-full resize-y border-2 border-smoke bg-transparent p-3 font-mono text-sm text-cream placeholder:text-muted"
        />
        <p className="mt-1 text-right font-mono text-[11px] text-muted">
          {props.customInstructions.length} / {MAX_INSTRUCTIONS_CHARS}
        </p>
      </div>
    </div>
  );
}
