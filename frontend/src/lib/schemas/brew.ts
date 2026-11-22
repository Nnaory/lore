/**
 * Building World progress, streamed from the orchestrator over SSE (one JSON event per message).
 * The screen (components/brew/BrewingScreen) renders ONLY from `BrewState` produced by
 * `brewReducer` — never from timers or fake progress.
 * Mirrors backend/app/schemas/brew.py.
 */
import { z } from 'zod';

export const BREW_STEPS = ['reading', 'review', 'world', 'writing'] as const;
export const BrewStepSchema = z.enum([...BREW_STEPS, 'done']);
export type BrewStep = z.infer<typeof BrewStepSchema>;

export const BrewEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), file: z.string(), pages: z.number().int().min(1), genre: z.string(), chapters: z.number().int().min(1).max(5), language: z.enum(['id', 'en']) }),
  z.object({ type: z.literal('step'), step: BrewStepSchema }),
  z.object({ type: z.literal('concept'), label: z.string().min(1).max(40) }),
  /** Pipeline pauses here (LangGraph interrupt) until the client POSTs the kept concepts. */
  z.object({ type: z.literal('awaiting_review') }),
  z.object({ type: z.literal('world'), kind: z.enum(['place', 'character']), label: z.string().min(1).max(40) }),
  z.object({ type: z.literal('chapter'), title: z.string().min(1).max(60) }),
  z.object({ type: z.literal('done'), storyId: z.string(), chapters: z.number().int(), characters: z.number().int() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type BrewEvent = z.infer<typeof BrewEventSchema>;

export interface BrewState {
  file: string;
  pages: number;
  genre: string;
  chapters: number;
  language: 'id' | 'en';
  step: BrewStep;
  /** epoch ms when each step started / ended (for the per-step timers). */
  startedAt: Partial<Record<BrewStep, number>>;
  endedAt: Partial<Record<BrewStep, number>>;
  concepts: string[];
  dropped: string[];
  world: { kind: 'place' | 'character'; label: string }[];
  chapterTitles: string[];
  storyId?: string;
  error?: string;
}

export const initialBrewState: BrewState = {
  file: '', pages: 0, genre: '', chapters: 0, language: 'en', step: 'reading',
  startedAt: {}, endedAt: {}, concepts: [], dropped: [], world: [], chapterTitles: [],
};

/** Pure reducer: (state, event, now) → state. Unit-test friendly. */
export function brewReducer(s: BrewState, e: BrewEvent, now: number = Date.now()): BrewState {
  switch (e.type) {
    case 'start':
      return { ...initialBrewState, file: e.file, pages: e.pages, genre: e.genre, chapters: e.chapters, language: e.language, step: 'reading', startedAt: { reading: now } };
    case 'step': {
      if (e.step === s.step) return s;
      return { ...s, step: e.step, endedAt: { ...s.endedAt, [s.step]: now }, startedAt: { ...s.startedAt, [e.step]: now } };
    }
    case 'concept':
      return s.concepts.includes(e.label) ? s : { ...s, concepts: [...s.concepts, e.label] };
    case 'awaiting_review':
      return s.step === 'review' ? s : { ...s, step: 'review', endedAt: { ...s.endedAt, [s.step]: now }, startedAt: { ...s.startedAt, review: now } };
    case 'world':
      return { ...s, world: [...s.world, { kind: e.kind, label: e.label }] };
    case 'chapter':
      return { ...s, chapterTitles: [...s.chapterTitles, e.title] };
    case 'done':
      return { ...s, step: 'done', storyId: e.storyId, endedAt: { ...s.endedAt, [s.step]: now } };
    case 'error':
      return { ...s, error: e.message };
  }
}

/** Client-side toggle during the review step (sent to the backend with "continue"). */
export function toggleConcept(s: BrewState, label: string): BrewState {
  return { ...s, dropped: s.dropped.includes(label) ? s.dropped.filter((x) => x !== label) : [...s.dropped, label] };
}

export function keptConcepts(s: BrewState): string[] {
  return s.concepts.filter((c) => !s.dropped.includes(c));
}
