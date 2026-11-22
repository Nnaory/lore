/**
 * Ending recap (credits + end card), computed on the client from the answers the player gave.
 * No new backend call is needed.
 */
import type { CharacterDef, ChoiceBeat } from '@/lib/schemas/visual';

export type ConceptOutcome = 'first' | 'retry' | 'weak';

/** One locked answer, in the order the player locked them. */
export interface AnswerRecord {
  beat: ChoiceBeat;
  optionId: string;
  correct: boolean;
}

export interface CastCredit {
  def: CharacterDef;
  /** Credits line after the verb, e.g. "arah dan besaran sebuah vektor" — the concepts of the
   *  questions this character asked, joined by the story language's "and". */
  lesson: string;
  /** questions this character asked (speaker of a choice beat, or voice in council mode) */
  questions: number;
  firstTry: number;
  /** rival only: wrong answers the player locked on this character's claims */
  trapsWon: number;
  trapsBroken: number;
}

export interface StoryResult {
  title: string;
  subtitle: string;
  chapters: number;
  sourceFile: string;
  pages: number;
  world: string;
  hp: number;
  hpMax: number;
  /** correct on the first lock / number of questions */
  firstTryCorrect: number;
  questions: number;
  minutes: number;
  concepts: { label: string; outcome: ConceptOutcome }[];
  cast: CastCredit[];
}

/** first = first lock correct · retry = correct after ≥1 wrong lock · weak = never correct. */
export function conceptOutcomes(answers: AnswerRecord[]): { label: string; outcome: ConceptOutcome }[] {
  const byConcept = new Map<string, AnswerRecord[]>();
  for (const a of answers) {
    const list = byConcept.get(a.beat.concept) ?? [];
    list.push(a);
    byConcept.set(a.beat.concept, list);
  }
  return [...byConcept.entries()].map(([label, list]) => {
    // group per beat (a concept may be asked several times); take the worst outcome
    const perBeat = new Map<ChoiceBeat, AnswerRecord[]>();
    for (const a of list) perBeat.set(a.beat, [...(perBeat.get(a.beat) ?? []), a]);
    let outcome: ConceptOutcome = 'first';
    for (const tries of perBeat.values()) {
      const o: ConceptOutcome = tries[0].correct ? 'first' : tries.some((t) => t.correct) ? 'retry' : 'weak';
      if (o === 'weak' || (o === 'retry' && outcome === 'first')) outcome = o;
    }
    return { label, outcome };
  });
}

/** Weakest concepts first: the end card's primary button retries the first 'weak' one. */
export function weakest(concepts: { label: string; outcome: ConceptOutcome }[]): string | undefined {
  return concepts.find((c) => c.outcome === 'weak')?.label ?? concepts.find((c) => c.outcome === 'retry')?.label;
}
