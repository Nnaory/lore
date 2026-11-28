/**
 * Voice council: who "says" each answer of a puzzle, and in which language the screen talks
 *
 * Why: a multiple-choice puzzle is more fun when every answer is a claim made by one of the
 * story's characters and the player decides whom to trust. The answers themselves are not
 * touched: the choice ids, the texts, the order and the right answer are exactly the puzzle's,
 * and right or wrong still comes only from `validateMultipleChoice`. This file only gives each
 * choice a speaker (deterministically, so a puzzle shows the same voices every time and the
 * right answer does not always sit with the same character) and the few words of chrome the
 * council needs in the story's language. Pure functions, no React.
 *
 * The story blueprint carries no language field, so `detectLanguage` guesses it from the puzzle's
 * own text (Indonesian function words), and falls back to English.
 */

import type { CastId } from "@/lib/ascii/figure";
import { stableHash } from "@/lib/contracts/hash";
import type { CastAllocation } from "@/lib/cast/cast-mapping";
import type { Character } from "@/lib/types/campaign";
import type { Puzzle } from "@/lib/types/puzzle";

export type Voice = {
  choiceId: string;
  /** The claim: the choice text. */
  text: string;
  characterId: string;
  name: string;
  role: string;
  castId: CastId;
};

/** Literal classes so Tailwind can see them. Cloth colours are for characters only. */
export const VOICE_NAME_CLASS: Record<CastId, string> = {
  eldric: "text-cloth-eldric",
  mira: "text-cloth-mira",
  hazel: "text-cloth-hazel",
  varr: "text-cloth-varr",
  nyx: "text-cloth-nyx",
};

const MAX_VOICES = 4;

/**
 * One voice per choice (the first four), or `[]` when fewer than two different characters can
 * speak (then the puzzle keeps its plain answer buttons).
 */
export function assignVoices(
  puzzle: Pick<Puzzle, "puzzle_id" | "choices">,
  characters: readonly Character[],
  cast: ReadonlyMap<string, CastAllocation>,
  storyCharacterIds?: readonly string[],
): Voice[] {
  const inStory = storyCharacterIds
    ? characters.filter((c) => storyCharacterIds.includes(c.character_id))
    : [];
  const pool = (inStory.length >= 2 ? inStory : characters).flatMap((c) => {
    const castId = cast.get(c.character_id)?.castId;
    return castId ? [{ character: c, castId }] : [];
  });
  // One speaker per cast member, in campaign order.
  const speakers = pool.filter((p, i) => pool.findIndex((q) => q.castId === p.castId) === i);
  if (speakers.length < 2 || puzzle.choices.length < 2) return [];

  const hash = parseInt(stableHash(puzzle.puzzle_id), 36);
  const offset = (Number.isFinite(hash) ? hash : 0) % speakers.length;
  return puzzle.choices.slice(0, MAX_VOICES).map((choice, i) => {
    const speaker = speakers[(i + offset) % speakers.length];
    return {
      choiceId: choice.choice_id,
      text: choice.text,
      characterId: speaker.character.character_id,
      name: speaker.character.name,
      role: speaker.character.role,
      castId: speaker.castId,
    };
  });
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

export type CouncilLanguage = "en" | "id";

/** Common Indonesian function words that are not English words. */
const INDONESIAN_WORDS = new Set([
  "yang", "dan", "di", "ke", "dari", "untuk", "dengan", "adalah", "ini", "itu", "tidak", "apa",
  "bagaimana", "jika", "maka", "pada", "atau", "kita", "kamu", "kau", "akan", "oleh", "dalam",
  "karena", "sebuah", "satu", "hanya", "siapa", "mana", "saja", "bisa", "harus", "ada", "sudah",
]);

/** `id` when the texts read as Indonesian (at least two function words and 8% of the words), else `en`. */
export function detectLanguage(texts: readonly string[]): CouncilLanguage {
  const words = texts
    .join(" ")
    .toLowerCase()
    .split(/[^a-zà-ÿ]+/)
    .filter(Boolean);
  if (words.length === 0) return "en";
  const hits = words.filter((w) => INDONESIAN_WORDS.has(w)).length;
  return hits >= 2 && hits / words.length >= 0.08 ? "id" : "en";
}

export function puzzleLanguage(puzzle: Puzzle): CouncilLanguage {
  return detectLanguage([puzzle.narrative_context, puzzle.question, ...puzzle.choices.map((c) => c.text)]);
}

export type CouncilText = {
  title: string;
  pickOne: string;
  trust: (name: string) => string;
};

const COUNCIL_TEXT: Record<CouncilLanguage, CouncilText> = {
  en: { title: "VOICE COUNCIL", pickOne: "PICK ONE VOICE", trust: (name) => `Trust ${name}` },
  id: { title: "DEWAN SUARA", pickOne: "PILIH SATU SUARA", trust: (name) => `Percayai ${name}` },
};

export function councilText(language: CouncilLanguage): CouncilText {
  return COUNCIL_TEXT[language];
}
