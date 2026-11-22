import { describe, expect, it } from 'vitest';
import { SceneBlueprintSchema, type ChoiceBeat } from '../src/lib/schemas/visual';
import { brewReducer, initialBrewState, keptConcepts, toggleConcept, type BrewEvent } from '../src/lib/schemas/brew';
import { conceptOutcomes, weakest } from '../src/lib/story/result';
import { t, UI, detectUiLang } from '../src/lib/i18n/ui';

const rune = {
  kind: 'choice', speaker: 'arion', prompt: 'Mana penulisan vektor baris yang benar?', concept: 'vektor baris',
  options: [
    { id: 'a', label: 'AB = 7', correct: false, why: 'skalar', preview: { kind: 'scalar', value: 7, caption: 'satu bilangan' } },
    { id: 'b', label: 'AB = [3, 4]', correct: true, why: 'baris', preview: { kind: 'vector2d', x: 3, y: 4, caption: '1 baris × 2 kolom' } },
    { id: 'c', label: 'AB = [[3], [4], [0]]', correct: false, why: 'kolom', preview: { kind: 'matrix', rows: [[3], [4], [0]], caption: '3 baris × 1 kolom' } },
  ],
};

describe('visual contract', () => {
  it('accepts a rune question and defaults mode/reaction/language', () => {
    const r = SceneBlueprintSchema.parse({
      scene: { biome: 'city_gate', seed: 7, title: 'Reruntuhan Kuil Langit' },
      cast: [{ id: 'arion', name: 'Arion', role: 'Sang Pemandu', function: 'guide', look: 'hazel' }],
      beats: [{ kind: 'line', speaker: 'arion', text: 'Segel ini menunggu.' }, rune],
    });
    const beat = r.beats[1] as ChoiceBeat;
    expect(beat.mode).toBe('rune');
    expect(beat.reaction).toEqual({ correct: 'smile', wrong: 'worried' });
    expect(r.language).toBe('en');
  });

  it('rejects two correct answers, council without voices, and invented parts', () => {
    const base = { scene: { biome: 'city_gate', seed: 7, title: 'x' }, cast: [{ id: 'arion', name: 'A', role: 'r', function: 'guide', look: 'hazel' }] };
    const two = { ...rune, options: rune.options.map((o) => ({ ...o, correct: true })) };
    expect(SceneBlueprintSchema.safeParse({ ...base, beats: [two] }).success).toBe(false);
    expect(SceneBlueprintSchema.safeParse({ ...base, beats: [{ ...rune, mode: 'council' }] }).success).toBe(false);
    expect(SceneBlueprintSchema.safeParse({ ...base, cast: [{ id: 'bob', name: 'B', role: 'r', function: 'guide', look: { hat: 'top-hat' } }], beats: [rune] }).success).toBe(false);
  });
});

describe('brew reducer', () => {
  it('follows the SSE stream, pauses for review, and finishes', () => {
    const ev: BrewEvent[] = [
      { type: 'start', file: '2611.21885v2.pdf', pages: 63, genre: 'fantasy', chapters: 3, language: 'id' },
      { type: 'concept', label: 'vektor' }, { type: 'concept', label: 'besaran' }, { type: 'concept', label: 'vektor' },
      { type: 'awaiting_review' },
    ];
    let s = initialBrewState;
    ev.forEach((e, i) => (s = brewReducer(s, e, 1000 * i)));
    expect(s.step).toBe('review');
    expect(s.concepts).toEqual(['vektor', 'besaran']);
    s = toggleConcept(s, 'besaran');
    expect(keptConcepts(s)).toEqual(['vektor']);
    s = brewReducer(s, { type: 'step', step: 'world' }, 9000);
    s = brewReducer(s, { type: 'world', kind: 'place', label: 'Valoria' }, 9500);
    s = brewReducer(s, { type: 'step', step: 'writing' }, 12000);
    s = brewReducer(s, { type: 'chapter', title: 'Bab 1 · Segel Dasar' }, 13000);
    s = brewReducer(s, { type: 'done', storyId: 's1', chapters: 3, characters: 4 }, 20000);
    expect(s.step).toBe('done');
    expect(s.endedAt.reading).toBe(4000);
    expect(s.endedAt.writing).toBe(20000);
  });
});

describe('ending recap', () => {
  it('classifies first / retry / weak and picks the weakest concept', () => {
    const beat = (concept: string) => ({ ...rune, concept, mode: 'rune', reaction: { correct: 'smile', wrong: 'worried' } }) as ChoiceBeat;
    const b1 = beat('vektor baris'), b2 = beat('besaran'), b3 = beat('vektor kolom');
    const out = conceptOutcomes([
      { beat: b1, optionId: 'b', correct: true },
      { beat: b2, optionId: 'a', correct: false }, { beat: b2, optionId: 'b', correct: true },
      { beat: b3, optionId: 'a', correct: false },
    ]);
    expect(out).toEqual([
      { label: 'vektor baris', outcome: 'first' }, { label: 'besaran', outcome: 'retry' }, { label: 'vektor kolom', outcome: 'weak' },
    ]);
    expect(weakest(out)).toBe('vektor kolom');
  });
});

describe('i18n', () => {
  it('has the same keys in id and en, and interpolates', () => {
    expect(Object.keys(UI.id).sort()).toEqual(Object.keys(UI.en).sort());
    expect(t('id', 'council.trust', { name: 'Mira' })).toBe('Percayai Mira');
    expect(t('en', 'brew.proceed', { n: 7 })).toBe('Stir again · 7 concepts →');
    expect(detectUiLang(null, 'id-ID')).toBe('id');
    expect(detectUiLang('en', 'id-ID')).toBe('en');
  });
});
