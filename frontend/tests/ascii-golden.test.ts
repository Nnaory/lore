/**
 * Parity test: the TypeScript generators must output EXACTLY what the design canvas renders.
 * The fixture was exported from the canvas generators. If this fails, the web no longer
 * matches the design — fix the code, do not regenerate the fixture (unless the design changed).
 */
import { describe, expect, it } from 'vitest';
import golden from './fixtures/ascii-golden.json';
import { CAST, EXPRESSIONS, figure, jackMouth, MOUTH_PRESETS, pumpkin, scene, SCENE_LAYOUTS, wordmark, type CastId } from '../src/lib/ascii';
import { SceneBlueprintSchema } from '../src/lib/schemas/visual';

describe('ASCII parity with the design canvas', () => {
  for (const id of Object.keys(CAST) as CastId[]) {
    for (const e of EXPRESSIONS) {
      it(`figure ${id}:${e}`, () => {
        expect(figure(CAST[id], e)).toEqual((golden.figure as Record<string, unknown>)[`${id}:${e}`]);
      });
    }
  }

  it('scene, desktop stage', () => {
    const l = SCENE_LAYOUTS.stageDesktop;
    expect(scene({ ...l, moon: [...l.moon], seed: 7 })).toEqual(golden.scene.stageDesktop);
  });

  it('scene, phone stage', () => {
    const l = SCENE_LAYOUTS.stagePhone;
    expect(scene({ ...l, moon: [...l.moon], seed: 7 })).toEqual(golden.scene.stagePhone);
  });

  for (const key of Object.keys(golden.pumpkin)) {
    it(`pumpkin ${key}`, () => {
      const [w, s] = key.split(':').map(Number);
      expect(pumpkin(w, s)).toEqual((golden.pumpkin as Record<string, unknown>)[key]);
    });
  }

  it('mouth pumpkin, desktop + phone', () => {
    const d = MOUTH_PRESETS.desktop, p = MOUTH_PRESETS.phone;
    expect(jackMouth(d.w, { ...d.opts })).toEqual(golden.jackMouth.desktop);
    expect(jackMouth(p.w, { ...p.opts })).toEqual(golden.jackMouth.phone);
  });

  it('wordmark', () => {
    expect(wordmark()).toEqual(golden.wordmark);
  });
});

describe('visual contract', () => {
  it('accepts a valid blueprint and rejects invented parts', () => {
    const ok = SceneBlueprintSchema.safeParse({
      scene: { biome: 'city_gate', seed: 7, title: 'The Outer Gate, Veiled City' },
      cast: [
        { id: 'eldric', name: 'Eldric', role: 'Keeper of the Beacon', function: 'guide', look: 'eldric' },
        { id: 'hazel', name: 'Hazel', role: 'Witch of the Ember Marsh', function: 'practice', look: 'hazel' },
      ],
      beats: [
        { kind: 'line', speaker: 'eldric', expression: 'calm', text: 'The beacon is cold.' },
        {
          kind: 'choice', speaker: 'hazel', prompt: 'What is the fire missing?',
          options: [{ id: 'o2', label: 'OXYGEN', correct: true }, { id: 'h2o', label: 'WATER', correct: false }],
          onCorrect: { expression: 'smile', text: 'Heat, fuel, and air!' },
          onWrong: { expression: 'worried', text: 'A flame cannot breathe that.' },
        },
      ],
    });
    expect(ok.success).toBe(true);

    const bad = SceneBlueprintSchema.safeParse({
      scene: { biome: 'city_gate', seed: 7, title: 'x' },
      cast: [{ id: 'bob', name: 'Bob', role: 'x', function: 'guide', look: { hat: 'top-hat' } }],
      beats: [{ kind: 'line', speaker: 'bob', text: 'hi' }],
    });
    expect(bad.success).toBe(false);
  });
});
