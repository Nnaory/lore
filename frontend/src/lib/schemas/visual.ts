/**
 * Visual contract between the AI orchestrator and the frontend.
 * The agent NEVER sends images or coordinates — only these recipes. Mirrors
 * backend/app/schemas/visual.py (keep both in sync; enums are the single source of truth).
 */
import { z } from 'zod';

export const ExpressionSchema = z.enum(['calm', 'smile', 'worried', 'surprised', 'angry']);
export const CastIdSchema = z.enum(['eldric', 'mira', 'hazel', 'varr', 'nyx']);

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** A custom character built from the part library (for new speakers in a story). */
export const CharacterSpecSchema = z
  .object({
    cloth: hex.optional(),
    outfit: z.enum(['robe', 'coat', 'armor', 'dress', 'cloak']).optional(),
    prop: z.enum(['lantern', 'book', 'spear', 'orb', 'broom']).optional(),
    hat: z.enum(['pointed', 'witch', 'helmet', 'hood']).optional(),
    hair: z.enum(['sides', 'long', 'buns']).optional(),
    beard: z.enum(['long', 'mustache']).optional(),
    eyes: z.enum(['o2', 'g2', 'k']).optional(),
    face: z.literal('void').optional(),
    faceR: z.number().min(3.6).max(4.6).optional(),
    faceTall: z.number().min(1).max(1.2).optional(),
    mouthY: z.number().int().min(21).max(22).optional(),
    blush: z.boolean().optional(),
    clasp: z.boolean().optional(),
  })
  .strict();

export const CharacterDefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,23}$/),
  name: z.string().min(1).max(24),
  role: z.string().min(1).max(48),
  /** Learning function in the story (docs/DESIGN-SYSTEM.md §6). */
  function: z.enum(['guide', 'peer', 'practice', 'examiner', 'rival']),
  /** Either a built-in cast member or a custom spec. */
  look: z.union([CastIdSchema, CharacterSpecSchema]),
});

export const SceneRecipeSchema = z.object({
  biome: z.enum(['city_gate']),
  seed: z.number().int().min(1).max(9999),
  title: z.string().max(60),
});

export const DialogueBeatSchema = z.object({
  kind: z.literal('line'),
  speaker: z.string(), // CharacterDef.id, or "narrator"
  expression: ExpressionSchema.default('calm'),
  text: z.string().min(1).max(280),
});

export const ChoiceBeatSchema = z.object({
  kind: z.literal('choice'),
  speaker: z.string(),
  prompt: z.string().max(200),
  options: z.array(z.object({ id: z.string(), label: z.string().max(24), correct: z.boolean() })).min(2).max(4),
  onCorrect: z.object({ expression: ExpressionSchema, text: z.string().max(280) }),
  onWrong: z.object({ expression: ExpressionSchema, text: z.string().max(280) }),
});

export const BeatSchema = z.discriminatedUnion('kind', [DialogueBeatSchema, ChoiceBeatSchema]);

export const SceneBlueprintSchema = z.object({
  scene: SceneRecipeSchema,
  /** Max two speakers on stage at once (left = active speaker on phone). */
  cast: z.array(CharacterDefSchema).min(1).max(5),
  beats: z.array(BeatSchema).min(1),
});

export type CharacterDef = z.infer<typeof CharacterDefSchema>;
export type SceneRecipe = z.infer<typeof SceneRecipeSchema>;
export type Beat = z.infer<typeof BeatSchema>;
export type SceneBlueprint = z.infer<typeof SceneBlueprintSchema>;
