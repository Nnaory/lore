/**
 * GenrePicker
 *
 * Step 02: three world cards (native radio buttons, so arrow keys work).
 * Backgrounds are CSS-only patterns — no images — per docs/DESIGN.md.
 */

"use client";

import type { CSSProperties } from "react";
import type { Genre } from "@/lib/types/campaign";

type GenreChoice = {
  genre: Genre;
  label: string;
  description: string;
  pattern: CSSProperties;
};

/** "Non-fiction" maps to the engine's `modern` genre (the real world, today). */
export const GENRE_CHOICES: readonly GenreChoice[] = [
  {
    genre: "fantasy",
    label: "Fantasy",
    description: "Ancient realms, fading magic, old secrets.",
    pattern: {
      backgroundImage: "radial-gradient(circle at 25% 15%, rgba(232, 197, 71, 0.16), transparent 60%)",
    },
  },
  {
    genre: "modern",
    label: "Non-fiction",
    description: "The real world, here and now.",
    pattern: {
      backgroundImage: "repeating-linear-gradient(0deg, rgba(232, 197, 71, 0.06) 0 1px, transparent 1px 14px)",
    },
  },
  {
    genre: "science_fiction",
    label: "Sci-fi",
    description: "Research stations and the technology of tomorrow.",
    pattern: {
      backgroundImage: "radial-gradient(rgba(232, 197, 71, 0.18) 1px, transparent 1px)",
      backgroundSize: "12px 12px",
    },
  },
];

type GenrePickerProps = {
  value: Genre | null;
  onChange: (genre: Genre) => void;
};

export function GenrePicker({ value, onChange }: GenrePickerProps) {
  return (
    <fieldset>
      <legend className="sr-only">Choose a world</legend>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {GENRE_CHOICES.map((choice) => {
          const checked = value === choice.genre;
          return (
            <label
              key={choice.genre}
              data-testid={`genre-${choice.genre}`}
              className="relative flex flex-col gap-1.5 rounded-lg p-4 min-h-28 cursor-pointer transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
              style={{
                backgroundColor: "var(--background-panel)",
                border: `1px solid ${checked ? "var(--accent-gold)" : "var(--border-dim)"}`,
                outlineColor: "var(--accent-gold)",
                ...choice.pattern,
              }}
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
                className="text-sm font-semibold tracking-widest uppercase"
                style={{ color: checked ? "var(--accent-gold)" : "var(--foreground)" }}
              >
                {choice.label}
              </span>
              <span className="text-xs leading-5" style={{ color: "var(--foreground-muted)" }}>
                {choice.description}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
