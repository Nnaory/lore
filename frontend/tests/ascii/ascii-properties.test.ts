/**
 * Property tests for the ASCII generators (ui-redesign task 0.7).
 *
 * Why: the golden test pins 40 fixed outputs. These properties cover the whole
 * cast x expression space and the purity/caching guarantees the screens rely on
 * (same input -> same layers, bust = crop of the full figure), without touching
 * the generators or the golden fixture.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import golden from '../fixtures/ascii-golden.json';
import {
  BUST_FROM,
  CAST,
  EXPRESSIONS,
  figure,
  jackMouth,
  MOUTH_PRESETS,
  pumpkin,
  renderBust,
  renderCharacter,
  renderScene,
  scene,
  SCENE_LAYOUTS,
  wordmark,
  type CastId,
  type Expression,
} from '../../src/lib/ascii';

const RUNS = { numRuns: 100 };
const castIds = Object.keys(CAST) as CastId[];
const castArb = fc.constantFrom<CastId>(...castIds);
const exprArb = fc.constantFrom<Expression>(...EXPRESSIONS);
const golFigure = golden.figure as Record<string, unknown>;
const golPumpkin = golden.pumpkin as Record<string, unknown>;

describe('Feature: ui-redesign, Property 18: Generator ASCII identik dengan canvas dan murni', () => {
  it('renderCharacter equals figure(CAST[id]) and the golden fixture, for any id + expression', () => {
    fc.assert(
      fc.property(castArb, exprArb, (id, e) => {
        const out = renderCharacter(id, e);
        expect(out).toEqual(figure(CAST[id], e));
        expect(out).toEqual(golFigure[`${id}:${e}`]);
      }),
      RUNS,
    );
  });

  it('is pure: consecutive calls (including a cached one) return deep-equal results', () => {
    fc.assert(
      fc.property(castArb, exprArb, (id, e) => {
        const first = renderCharacter(id, e);
        const second = renderCharacter(id, e);
        expect(second).toEqual(first);
        expect(figure(CAST[id], e)).toEqual(figure(CAST[id], e));
      }),
      RUNS,
    );
  });

  it('renderBust is always 31 rows, a slice of the same renderCharacter rows', () => {
    fc.assert(
      fc.property(castArb, exprArb, (id, e) => {
        const bust = renderBust(id, e);
        const full = renderCharacter(id, e);
        const from = BUST_FROM[id];
        expect(bust).toHaveLength(full.length);
        bust.forEach((layer, i) => {
          const rows = layer.text.split('\n');
          expect(rows).toHaveLength(31);
          expect(rows).toEqual(full[i].text.split('\n').slice(from, from + 31));
          expect(layer.color).toBe(full[i].color);
          expect(layer.op).toBe(full[i].op);
        });
      }),
      RUNS,
    );
  });

  it('scene output matches the golden fixture for any layout, and is stable per seed', () => {
    const layoutArb = fc.constantFrom('stageDesktop', 'stagePhone' as const);
    fc.assert(
      fc.property(layoutArb, (layout) => {
        const l = SCENE_LAYOUTS[layout];
        const expected = golden.scene[layout];
        expect(scene({ ...l, moon: [...l.moon], seed: 7 })).toEqual(expected);
        expect(renderScene({ biome: 'city_gate', seed: 7 }, layout)).toEqual(expected);
        expect(renderScene({ biome: 'city_gate', seed: 7 }, layout)).toEqual(expected);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff }), fc.constantFrom('stageDesktop', 'stagePhone' as const), (seed, layout) => {
        const a = renderScene({ biome: 'city_gate', seed }, layout);
        expect(renderScene({ biome: 'city_gate', seed }, layout)).toEqual(a);
      }),
      RUNS,
    );
  });

  it('pumpkin output matches the golden fixture for every (width, seed) key', () => {
    const keyArb = fc.constantFrom(...Object.keys(golPumpkin));
    fc.assert(
      fc.property(keyArb, (key) => {
        const [w, s] = key.split(':').map(Number);
        expect(pumpkin(w, s)).toEqual(golPumpkin[key]);
        expect(pumpkin(w, s)).toEqual(pumpkin(w, s));
      }),
      RUNS,
    );
  });

  it('jackMouth and wordmark match the golden fixture on every call', () => {
    fc.assert(
      fc.property(fc.constantFrom('desktop', 'phone' as const), (k) => {
        const p = MOUTH_PRESETS[k];
        expect(jackMouth(p.w, { ...p.opts })).toEqual(golden.jackMouth[k]);
        expect(wordmark()).toEqual(golden.wordmark);
      }),
      RUNS,
    );
  });
});
