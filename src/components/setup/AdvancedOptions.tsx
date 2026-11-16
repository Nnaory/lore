/**
 * AdvancedOptions
 *
 * Optional story preferences, collapsed by default: length, language and
 * free-form instructions for the storyteller.
 */

"use client";

import {
  MAX_INSTRUCTIONS_CHARS,
  type StoryLanguage,
  type StoryLength,
} from "@/lib/setup/create-form";

type AdvancedOptionsProps = {
  length: StoryLength;
  language: StoryLanguage;
  customInstructions: string;
  onLengthChange: (length: StoryLength) => void;
  onLanguageChange: (language: StoryLanguage) => void;
  onInstructionsChange: (text: string) => void;
};

const LENGTHS: Array<{ value: StoryLength; label: string }> = [
  { value: "short", label: "Short · 3 chapters" },
  { value: "medium", label: "Medium · 5 chapters" },
];

const fieldLabel = "block text-xs tracking-widest uppercase mb-2";

export function AdvancedOptions(props: AdvancedOptionsProps) {
  return (
    <details className="group" data-testid="advanced-options">
      <summary
        className="cursor-pointer text-xs tracking-wide select-none list-none flex items-center gap-1.5"
        style={{ color: "var(--foreground-muted)" }}
      >
        <span className="inline-block transition-transform group-open:rotate-90" aria-hidden="true">▸</span>
        Advanced options
      </summary>

      <div className="mt-4 flex flex-col gap-5">
        <fieldset>
          <legend className={fieldLabel} style={{ color: "var(--foreground-faint)" }}>Story length</legend>
          <div className="flex flex-wrap gap-2">
            {LENGTHS.map((option) => {
              const checked = props.length === option.value;
              return (
                <label
                  key={option.value}
                  className={`lore-pill lore-pill-sm ${checked ? "lore-pill-accent" : ""} focus-within:outline focus-within:outline-2`}
                  style={{ outlineColor: "var(--accent-gold)" }}
                >
                  <input
                    type="radio"
                    name="story-length"
                    value={option.value}
                    checked={checked}
                    onChange={() => props.onLengthChange(option.value)}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label htmlFor="story-language" className={fieldLabel} style={{ color: "var(--foreground-faint)" }}>
            Story language
          </label>
          <select
            id="story-language"
            value={props.language}
            onChange={(e) => props.onLanguageChange(e.target.value as StoryLanguage)}
            className="lore-well rounded-tip px-3 py-2 text-sm"
            style={{ color: "var(--foreground)" }}
          >
            <option value="en">English</option>
            <option value="id">Bahasa Indonesia</option>
          </select>
        </div>

        <div>
          <label htmlFor="story-instructions" className={fieldLabel} style={{ color: "var(--foreground-faint)" }}>
            Instructions for the storyteller
          </label>
          <textarea
            id="story-instructions"
            rows={3}
            maxLength={MAX_INSTRUCTIONS_CHARS}
            value={props.customInstructions}
            onChange={(e) => props.onInstructionsChange(e.target.value)}
            placeholder="e.g. Set it in a coastal town. Keep the tone light."
            className="lore-well rounded-tip w-full p-3 text-sm resize-y"
            style={{ color: "var(--foreground)" }}
          />
          <p className="text-xs text-right mt-1" style={{ color: "var(--foreground-faint)" }}>
            {props.customInstructions.length} / {MAX_INSTRUCTIONS_CHARS}
          </p>
        </div>
      </div>
    </details>
  );
}
