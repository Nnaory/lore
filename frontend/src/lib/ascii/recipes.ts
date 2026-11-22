/**
 * Recipe → pixels. The backend (LangGraph) only ever sends recipes (see lib/schemas/visual.ts);
 * this file turns them into layers. Adding a biome or a part = add it here + in the schemas,
 * then add a golden case.
 */
import { cropRows, type Layer } from './core';
import { CAST, figure, type CastId, type CharacterSpec, type Expression } from './figure';
import { SCENE_LAYOUTS, scene } from './scene';

export type Biome = 'city_gate';
export type SceneLayout = keyof typeof SCENE_LAYOUTS;

/** Biome → which landmark columns to use. Only `city_gate` exists today. */
const BIOMES: Record<Biome, (layout: SceneLayout) => { beaconCol: number; gateCol: number }> = {
  city_gate: (layout) => ({ beaconCol: SCENE_LAYOUTS[layout].beaconCol, gateCol: SCENE_LAYOUTS[layout].gateCol }),
};

const sceneCache = new Map<string, Layer[]>();
export function renderScene(recipe: { biome: Biome; seed: number }, layout: SceneLayout): Layer[] {
  const key = `${recipe.biome}:${recipe.seed}:${layout}`;
  const hit = sceneCache.get(key);
  if (hit) return hit;
  const base = SCENE_LAYOUTS[layout];
  const ls = scene({ ...base, ...BIOMES[recipe.biome](layout), moon: base.moon ? [...base.moon] : undefined, seed: recipe.seed });
  sceneCache.set(key, ls);
  return ls;
}

/** A speaker is either a built-in cast id or a full custom spec from the story agent. */
export type CharacterRef = CastId | CharacterSpec;

const figureCache = new Map<string, Layer[]>();
export function renderCharacter(ref: CharacterRef, expression: Expression = 'calm'): Layer[] {
  const spec = typeof ref === 'string' ? CAST[ref] : ref;
  const key = JSON.stringify([spec, expression]);
  const hit = figureCache.get(key);
  if (hit) return hit;
  const ls = figure(spec, expression);
  figureCache.set(key, ls);
  return ls;
}

/** Bust crop used on the Cast board and phone screens (31 rows). */
export const BUST_FROM: Record<CastId, number> = { eldric: 0, mira: 6, hazel: 0, varr: 0, nyx: 6 };
export function renderBust(id: CastId, expression: Expression = 'calm'): Layer[] {
  const from = BUST_FROM[id];
  return cropRows(renderCharacter(id, expression), from, from + 31);
}
