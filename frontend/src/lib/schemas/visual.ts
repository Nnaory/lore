/**
 * Visual contract between the AI orchestrator and the frontend.
 * The agent NEVER sends images or coordinates — only these recipes. Mirrors
 * backend/app/schemas/visual.py (keep both in sync; enums are the single source of truth).
 */
import { z } from 'zod';

export const ExpressionSchema = z.enum(['calm', 'smile', 'worried', 'surprised', 'angry']);
export const CastIdSchema = z.enum(['eldric', 'mira', 'hazel', 'varr', 'nyx']);
/** Language of the story. UI labels follow it (lib/i18n/ui.ts). */
export const StoryLanguageSchema = z.enum(['id', 'en']);

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

/**
 * What the canvas draws while an answer option is highlighted (DESIGN-SYSTEM §4.9).
 * `caption` describes the SHAPE of the answer — it must never say whether it is right.
 */
export const PreviewSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vector2d'), x: z.number(), y: z.number(), caption: z.string().max(90) }),
  z.object({ kind: z.literal('scalar'), value: z.number(), caption: z.string().max(90) }),
  z.object({ kind: z.literal('matrix'), rows: z.array(z.array(z.union([z.number(), z.string().max(6)])).min(1).max(4)).min(1).max(4), caption: z.string().max(90) }),
  z.object({ kind: z.literal('text'), text: z.string().max(60), caption: z.string().max(90) }),
]);

export const DialogueBeatSchema = z.object({
  kind: z.literal('line'),
  speaker: z.string(), // CharacterDef.id, or "narrator"
  expression: ExpressionSchema.default('calm'),
  text: z.string().min(1).max(280),
});

export const ChoiceOptionSchema = z.object({
  id: z.string().min(1).max(16),
  /** Text on the rune / menu row, e.g. "AB = [3, 4]". */
  label: z.string().min(1).max(32),
  correct: z.boolean(),
  /** One sentence the speaker says after this option is locked (why right / why wrong). */
  why: z.string().min(1).max(200),
  preview: PreviewSpecSchema.optional(),
  /** Council mode only: which character argues for this option, and how. */
  voice: z
    .object({ speaker: z.string(), expression: ExpressionSchema, mood: z.string().max(16), claim: z.string().max(110) })
    .optional(),
});

export const ChoiceBeatSchema = z
  .object({
    kind: z.literal('choice'),
    /** rune = default answer layer; council = misconception question argued by characters. */
    mode: z.enum(['rune', 'council']).default('rune'),
    speaker: z.string(),
    prompt: z.string().min(1).max(200),
    /** Canvas label, snake_case, e.g. "reruntuhan_kuil_langit · segel_dasar". */
    canvasLabel: z.string().max(48).optional(),
    options: z.array(ChoiceOptionSchema).min(2).max(4),
    reaction: z.object({ correct: ExpressionSchema, wrong: ExpressionSchema }).default({ correct: 'smile', wrong: 'worried' }),
    /** Concept this question checks — feeds the ending recap. */
    concept: z.string().min(1).max(40),
  })
  .superRefine((b, ctx) => {
    if (b.options.filter((o) => o.correct).length !== 1) ctx.addIssue({ code: 'custom', message: 'exactly one option must be correct' });
    if (b.mode === 'council' && b.options.some((o) => !o.voice)) ctx.addIssue({ code: 'custom', message: 'council mode needs a voice on every option' });
  });

export const BeatSchema = z.union([DialogueBeatSchema, ChoiceBeatSchema]);

export const SceneBlueprintSchema = z.object({
  language: StoryLanguageSchema.default('en'),
  scene: SceneRecipeSchema,
  /** Max two speakers on stage at once (left = active speaker on phone). */
  cast: z.array(CharacterDefSchema).min(1).max(5),
  beats: z.array(BeatSchema).min(1),
});

export type CharacterDef = z.infer<typeof CharacterDefSchema>;
export type SceneRecipe = z.infer<typeof SceneRecipeSchema>;
export type PreviewSpec = z.infer<typeof PreviewSpecSchema>;
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;
export type ChoiceBeat = z.infer<typeof ChoiceBeatSchema>;
export type Beat = z.infer<typeof BeatSchema>;
export type SceneBlueprint = z.infer<typeof SceneBlueprintSchema>;
export type StoryLanguage = z.infer<typeof StoryLanguageSchema>;
export type Expression = z.infer<typeof ExpressionSchema>;
