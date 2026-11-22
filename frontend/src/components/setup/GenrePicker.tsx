/**
 * GenrePicker
 *
 * Step 02 "WORLD" (DESIGN-SYSTEM §4.5, Prep.dc.html): a 3-column grid of 84px cells
 * inside a 2px smoke border. Exactly one cell can be selected; the selected cell is
 * cream with an ember 8px square. Native radios (sr-only) keep arrow-key behaviour
 * and the `genre-<genre>` test ids on the wrapping labels.
 */

"use client";

import type { Genre } from "@/lib/types/campaign";

type GenreChoice = {
  genre: Genre;
  label: string;
  description: string;
};

/** "Non-fiction" maps to the engine's `modern` genre (the real world, today). */
export const GENRE_CHOICES: readonly GenreChoice[] = [
  { genre: "fantasy", label: "Fantasy", description: "Ancient realms, fading magic, old secrets." },
  { genre: "modern", label: "Non-fiction", description: "The real world, here and now." },
  {
    genre: "science_fiction",
    label: "Sci-fi",
    description: "Research stations and the technology of tomorrow.",
  },
];

type GenrePickerProps = {
  value: Genre | null;
  onChange: (genre: Genre) => void;
};

export function GenrePicker({ value, onChange }: GenrePickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="World"
      data-testid="genre-picker"
      className="flex flex-col border-2 border-smoke md:grid md:grid-cols-3"
    >
      {GENRE_CHOICES.map((choice, i) => {
        const checked = value === choice.genre;
        return (
          <label
            key={choice.genre}
            data-testid={`genre-${choice.genre}`}
            className={`grid h-[54px] min-w-0 cursor-pointer grid-cols-[8px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 px-3.5 text-left md:h-[84px] md:items-start md:gap-x-2 md:gap-y-1.5 md:px-4 md:py-3.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ember ${
              i === 0 ? "" : "border-t-2 border-smoke md:border-l-2 md:border-t-0"
            } ${checked ? "bg-cream text-ink" : "bg-transparent text-cream"}`}
          >
            <input
              type="radio"
              name="genre"
              value={choice.genre}
              checked={checked}
              onChange={() => onChange(choice.genre)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className={`row-span-2 h-2 w-2 shrink-0 self-center md:row-span-1 ${checked ? "bg-ember" : "bg-smoke"}`}
            />
            <span className="font-mono text-xs font-bold uppercase tracking-[0.14em] md:text-[13px]">
              {choice.label}
            </span>
            <span
              className={`col-start-2 truncate text-xs leading-[1.35] md:col-span-2 md:col-start-1 md:overflow-visible md:whitespace-normal md:text-[13px] ${checked ? "text-ink/80" : "text-muted"}`}
            >
              {choice.description}
            </span>
          </label>
        );
      })}
    </div>
  );
}
