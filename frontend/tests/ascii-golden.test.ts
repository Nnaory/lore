/**
 * Parity test: the TypeScript generators must output EXACTLY what the design canvas renders.
 * The fixture was exported from the canvas generators. If this fails, the web no longer
 * matches the design — fix the code, do not regenerate the fixture (unless the design changed).
 */
import { describe, expect, it } from 'vitest';
import golden from './fixtures/ascii-golden.json';
import { CAST, EXPRESSIONS, cauldron, figure, jackMouth, MOUTH_PRESETS, pumpkin, scene, SCENE_LAYOUTS, wordmark, type CastId } from '../src/lib/ascii';

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

  it('cauldron frames 0–3', () => {
    for (let f = 0; f < 4; f++) expect(cauldron(f)).toEqual(golden.cauldron[f]);
  });

  it('scene, credits (desktop + phone)', () => {
    expect(scene({ ...SCENE_LAYOUTS.credits, moon: [...SCENE_LAYOUTS.credits.moon], seed: 7 })).toEqual(golden.scene.credits);
    expect(scene({ ...SCENE_LAYOUTS.creditsPhone, moon: [...SCENE_LAYOUTS.creditsPhone.moon], seed: 7 })).toEqual(golden.scene.creditsPhone);
  });

  it('wordmark', () => {
    expect(wordmark()).toEqual(golden.wordmark);
  });
});

