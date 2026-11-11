/**
 * Story Generator Engine — Deterministic Story Construction (Layer 3, M9)
 *
 * Pure, deterministic transformation:
 *   StoryGenerationContext → StoryBlueprint
 *
 * Ownership split (see docs §4.5 "AI Content vs Game Execution"):
 *   - CONTENT (narrative text, dialogue lines, puzzle wording, feedback) is
 *     what a future real provider would generate. Here it is templated
 *     deterministically from the material's own text.
 *   - STRUCTURE (IDs, scene chain, learning→puzzle→result ordering, knowledge
 *     mappings, ending selection) is engine-owned and never provider-controlled.
 *
 * Guarantees:
 *   - Deterministic: no Date.now(), Math.random(), network, or React.
 *   - Pure: inputs are never mutated.
 *   - Linear scene chain: intro → (learning → puzzle → result)* → ending.
 *   - Exactly one ending scene (the UI applies the first ending scene found).
 *   - Every material concept gets exactly one learning scene and one puzzle,
 *     so every concept is demonstrable and every required_knowledge reference
 *     from a later story is testable.
 *   - Puzzle correctness is expressed only as data (correct_choice_id); the
 *     game engine remains the sole evaluator.
 *
 * Error model:
 *   Expected failures return EngineError; nothing throws except genuinely
 *   unreachable invariants.
 */

import type {
  StoryBlueprint,
  Chapter,
  KnowledgeMappingEntry,
} from "@/lib/types/story";
import type {
  Scene,
  SceneContent,
  Ending,
} from "@/lib/types/scene";
import type { Puzzle, PuzzleChoice } from "@/lib/types/puzzle";
import type { Concept } from "@/lib/types/material";
import type { Character } from "@/lib/types/campaign";
import type { ValidationError } from "@/lib/validation/story-validator";
import type {
  GenerateStoryRequest,
  StoryGeneratorErrorCode,
  StoryGeneratorOptions,
} from "@/lib/ai/story-generator-types";

// ---------------------------------------------------------------------------
// Engine result
// ---------------------------------------------------------------------------

export interface StoryEngineSuccess {
  ok: true;
  blueprint: StoryBlueprint;
  /** Non-blocking generation warnings. */
  warnings: ValidationError[];
}

export interface StoryEngineError {
  ok: false;
  code: StoryGeneratorErrorCode;
  message: string;
  detail?: unknown;
}

export type StoryEngineResult = StoryEngineSuccess | StoryEngineError;

// ---------------------------------------------------------------------------
// Expression selection
// ---------------------------------------------------------------------------

/** Preferred expression keys, in priority order, when the character has them. */
const PREFERRED_EXPRESSIONS = [
  "neutral",
  "thinking",
  "worried",
  "approving",
  "surprised",
  "stern",
  "focused",
  "curious",
  "relieved",
  "happy",
  "sad",
  "serious",
];

/**
 * Resolve an expression key that the given character actually owns.
 * Falls back to the character's first expression key, then to "neutral".
 */
function pickExpression(character: Character | undefined, preference: string): string {
  const keys = character ? Object.keys(character.expressions) : [];
  if (keys.length === 0) return "neutral";
  if (preference && keys.includes(preference)) return preference;
  for (const key of PREFERRED_EXPRESSIONS) {
    if (keys.includes(key)) return key;
  }
  return keys[0];
}

// ---------------------------------------------------------------------------
// Deterministic ordering of concepts within a material
// ---------------------------------------------------------------------------

/**
 * Stable intra-material topological order of concepts.
 * A concept's prerequisites that live in another material are ignored here —
 * cross-material ordering is the campaign planner's job (M8).
 * Ties break by original material order.
 */
function orderConcepts(concepts: Concept[]): Concept[] {
  const byId = new Map(concepts.map((c) => [c.concept_id, c]));
  const inputOrder = new Map(concepts.map((c, i) => [c.concept_id, i] as const));
  const deps = new Map<string, Set<string>>();

  for (const c of concepts) {
    const local = new Set<string>();
    for (const prereq of c.prerequisites) {
      if (byId.has(prereq) && prereq !== c.concept_id) local.add(prereq);
    }
    deps.set(c.concept_id, local);
  }

  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const c of concepts) {
    const local = deps.get(c.concept_id)!;
    remaining.set(c.concept_id, local.size);
    for (const dep of local) {
      const list = dependents.get(dep) ?? [];
      list.push(c.concept_id);
      dependents.set(dep, list);
    }
  }

  const available = concepts
    .filter((c) => (remaining.get(c.concept_id) ?? 0) === 0)
    .map((c) => c.concept_id)
    .sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));

  const sorted: Concept[] = [];
  while (available.length > 0) {
    const id = available.shift()!;
    const concept = byId.get(id);
    if (concept) sorted.push(concept);
    for (const dependentId of dependents.get(id) ?? []) {
      const count = (remaining.get(dependentId) ?? 0) - 1;
      remaining.set(dependentId, count);
      if (count === 0) {
        available.push(dependentId);
        available.sort(
          (a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0)
        );
      }
    }
  }

  // Any concepts still unresolved form an intra-material cycle. Append them in
  // input order so generation stays total; the generator validator reports it.
  if (sorted.length !== concepts.length) {
    const placed = new Set(sorted.map((c) => c.concept_id));
    for (const c of concepts) {
      if (!placed.has(c.concept_id)) sorted.push(c);
    }
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Text templates
// ---------------------------------------------------------------------------

function introNarration(
  campaignTitle: string,
  setting: string,
  entryTitle: string,
  conflict: string
): string {
  return `In ${setting}, the tale of ${campaignTitle} continues. The struggle that defines "${entryTitle}" begins now: ${conflict}`;
}

function learningBody(concept: Concept): string {
  const parts: string[] = [concept.definition.trim()];
  if (concept.principles.length > 0) {
    parts.push(concept.principles.join(" "));
  }
  if (concept.source_evidence.length > 0) {
    parts.push(`As the records put it: "${concept.source_evidence[0]}"`);
  }
  return parts.join(" ");
}

function distractorTexts(concept: Concept): string[] {
  if (concept.misconceptions.length > 0) return [...concept.misconceptions];
  // Deterministic fallback: negate the first principle, then a generic trap.
  const fallbacks: string[] = [];
  if (concept.principles.length > 0) {
    fallbacks.push(`The opposite of: ${concept.principles[0]}`);
  }
  fallbacks.push(`Any rule applies to ${concept.name} as long as it sounds plausible.`);
  return fallbacks;
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build a StoryBlueprint for a single campaign story entry.
 *
 * Deterministic: identical requests produce identical output (deep-equal).
 * Pure: the request object is never mutated.
 */
export function buildStoryBlueprint(
  request: GenerateStoryRequest
): StoryEngineResult {
  const { campaign, story: entry, material } = request;
  const options: StoryGeneratorOptions = request.options ?? {};
  const previousSummaries = request.previousSummaries ?? [];
  const warnings: ValidationError[] = [];

  // ── 1. Semantic guards on the request ───────────────────────────────────
  const entryInCampaign = campaign.story_sequence.some(
    (s) => s.story_id === entry.story_id
  );
  if (!entryInCampaign) {
    return {
      ok: false,
      code: "STORY_NOT_IN_CAMPAIGN",
      message: `Story "${entry.story_id}" is not part of campaign "${campaign.campaign_id}".`,
    };
  }

  if (entry.material_id !== material.material_id) {
    return {
      ok: false,
      code: "MATERIAL_MISMATCH",
      message: `Story "${entry.story_id}" references material "${entry.material_id}" but material "${material.material_id}" was supplied.`,
    };
  }

  if (material.concepts.length === 0) {
    return {
      ok: false,
      code: "CONCEPT_COVERAGE",
      message: `Material "${material.material_id}" defines no concepts, so no story can be generated.`,
    };
  }

  // ── 2. Concept ordering ─────────────────────────────────────────────────
  const orderedConcepts = orderConcepts([...material.concepts]);

  // ── 3. Character selection ──────────────────────────────────────────────
  const guide: Character | undefined = campaign.characters[0];
  const companion: Character | undefined = campaign.characters[1];
  const cast: Character[] = companion ? [guide, companion].filter(Boolean) as Character[] :
    (guide ? [guide] : []);
  const characterIds = cast.map((c) => c.character_id);
  const presentIds = characterIds;

  // ── 4. Scene IDs ────────────────────────────────────────────────────────
  const storyTag = entry.story_id;
  const introSceneId = `scene_${storyTag}_intro`;
  const endingSceneId = `scene_${storyTag}_ending`;
  const sceneIdFor = (index: number, kind: string) =>
    `scene_${storyTag}_c${pad(index)}_${kind}`;
  const puzzleIdFor = (index: number) => `puzzle_${storyTag}_c${pad(index)}`;

  // ── 5. Puzzles + per-concept scenes ─────────────────────────────────────
  const puzzles: Puzzle[] = [];
  const knowledgeMapping: KnowledgeMappingEntry[] = [];
  const scenes: Scene[] = [];

  scenes.push({
    scene_id: introSceneId,
    type: "narrative",
    location: campaign.setting,
    characters_present: presentIds,
    content: [
      { type: "narration", text: introNarration(campaign.title, campaign.setting, entry.title, entry.main_conflict) },
      ...(guide
        ? [
            {
              type: "dialogue" as const,
              character_id: guide.character_id,
              expression: pickExpression(guide, "worried"),
              text: `We are here because of ${entry.purpose.replace(/^Introduce and apply: /, "")}. Nothing about that is optional.`,
            },
          ]
        : []),
      ...(previousSummaries.length > 0
        ? [
            {
              type: "narration" as const,
              text: `What came before still shapes this moment: ${previousSummaries[previousSummaries.length - 1].outcome_description || previousSummaries[previousSummaries.length - 1].title}.`,
            },
          ]
        : []),
    ],
    next_scene_id: null, // wired below
  });

  orderedConcepts.forEach((concept, rawIndex) => {
    const index = rawIndex + 1;
    const learningSceneId = sceneIdFor(index, "learning");
    const puzzleSceneId = sceneIdFor(index, "puzzle");
    const resultSceneId = sceneIdFor(index, "result");
    const puzzleId = puzzleIdFor(index);

    // ── Learning scene ────────────────────────────────────────────────────
    const learningContent: SceneContent[] = [
      {
        type: "learning_info",
        title: concept.name,
        body: learningBody(concept),
        concept_ids: [concept.concept_id],
      },
    ];
    if (companion) {
      learningContent.unshift({
        type: "dialogue",
        character_id: companion.character_id,
        expression: pickExpression(companion, "curious"),
        text: `Before we go further, we need to be precise about ${concept.name}.`,
      });
    }

    scenes.push({
      scene_id: learningSceneId,
      type: "learning",
      location: campaign.setting,
      characters_present: presentIds,
      content: learningContent,
      next_scene_id: puzzleSceneId,
    });

    // ── Puzzle ────────────────────────────────────────────────────────────
    const distractors = distractorTexts(concept);
    if (concept.misconceptions.length === 0) {
      warnings.push({
        code: "PUZZLE_DISTRACTOR_SUBSTITUTED",
        message: `Concept "${concept.concept_id}" has no recorded misconceptions; deterministic fallback distractors were used.`,
        path: `puzzles[${puzzleId}].choices`,
      });
    }

    const correctChoiceId = `choice_${storyTag}_c${pad(index)}_a`;
    const choices: PuzzleChoice[] = [
      { choice_id: correctChoiceId, text: concept.definition },
      ...distractors.slice(0, 2).map((text, i) => ({
        choice_id: `choice_${storyTag}_c${pad(index)}_${String.fromCharCode(98 + i)}`,
        text,
      })),
    ];

    puzzles.push({
      puzzle_id: puzzleId,
      concept_ids: [concept.concept_id],
      narrative_context: `${entry.main_conflict} To move forward, ${concept.name} must be applied correctly.`,
      question: `Which statement correctly describes ${concept.name}?`,
      choices,
      correct_choice_id: correctChoiceId,
      explanation:
        concept.principles.length > 0
          ? `${concept.definition} This follows from: ${concept.principles.join(" ")}`
          : concept.definition,
      incorrect_feedback: `That is a common misunderstanding. Re-read the material on ${concept.name} and try again.`,
      correct_feedback: `Correct. ${concept.name} is exactly as stated, and the story can continue.`,
      retry_allowed: true,
    });

    scenes.push({
      scene_id: puzzleSceneId,
      type: "puzzle",
      location: campaign.setting,
      characters_present: presentIds,
      puzzle_id: puzzleId,
      next_scene_id: resultSceneId,
    });

    // ── Result / consequence scene ────────────────────────────────────────
    const resultContent: SceneContent[] = [
      {
        type: "narration",
        text: `With ${concept.name} understood, the obstacle before you gives way. The path through "${entry.title}" opens a little further.`,
      },
    ];
    if (guide) {
      resultContent.push({
        type: "dialogue",
        character_id: guide.character_id,
        expression: pickExpression(guide, "approving"),
        text: `Good. ${concept.name} is secure. We continue.`,
      });
    }

    scenes.push({
      scene_id: resultSceneId,
      type: "consequence",
      location: campaign.setting,
      characters_present: presentIds,
      content: resultContent,
      next_scene_id: null, // wired below
    });

    // ── Knowledge mapping ─────────────────────────────────────────────────
    knowledgeMapping.push({
      concept_id: concept.concept_id,
      introduced_in_scene_id: learningSceneId,
      tested_in_puzzle_id: puzzleId,
    });
  });

  // ── 6. Ending ───────────────────────────────────────────────────────────
  const endingId = `ending_${storyTag}_success`;
  const outcome = entry.outcomes[0];
  const ending: Ending = {
    ending_id: endingId,
    type: "success",
    title: `${entry.title} — Resolved`,
    narration: `The conflict of "${entry.title}" is settled: ${
      outcome?.description ?? "the central problem is fully resolved."
    } The knowledge gained here will matter in what comes next.`,
    world_state_changes: outcome ? { ...outcome.world_state_changes } : {},
    relationship_changes: Object.fromEntries(
      characterIds.map((id) => [id, 10] as const)
    ),
  };

  scenes.push({
    scene_id: endingSceneId,
    type: "ending",
    location: campaign.setting,
    characters_present: presentIds,
    ending_id: endingId,
  });

  // ── 7. Wire the linear chain ────────────────────────────────────────────
  const contentScenes = scenes.filter(
    (s): s is Extract<Scene, { next_scene_id: string | null }> =>
      s.type !== "ending"
  );
  for (let i = 0; i < contentScenes.length; i++) {
    const next = i + 1 < contentScenes.length ? contentScenes[i + 1].scene_id : endingSceneId;
    contentScenes[i].next_scene_id = next;
  }

  // ── 8. Chaptering ───────────────────────────────────────────────────────
  const perChapter = Math.max(
    1,
    Math.min(
      options.conceptsPerChapter ?? orderedConcepts.length,
      orderedConcepts.length
    )
  );
  const chapters: Chapter[] = [];
  const scenesPerConceptRun = 3; // learning + puzzle + result
  const headScenes = scenes.slice(0, 1); // intro
  const middle = scenes.slice(1, scenes.length - 1); // concept runs
  const tailScenes = scenes.slice(scenes.length - 1); // ending

  const groupCount = Math.ceil(middle.length / (perChapter * scenesPerConceptRun));
  for (let g = 0; g < groupCount; g++) {
    const slice = middle.slice(
      g * perChapter * scenesPerConceptRun,
      (g + 1) * perChapter * scenesPerConceptRun
    );
    chapters.push({
      chapter_id:
        groupCount === 1
          ? `chapter_${storyTag}_01`
          : `chapter_${storyTag}_${pad(g + 1)}`,
      title:
        groupCount === 1
          ? entry.title
          : `${entry.title} — Part ${g + 1}`,
      scenes: [
        ...(g === 0 ? headScenes : []),
        ...slice,
        ...(g === groupCount - 1 ? tailScenes : []),
      ],
    });
  }

  // ── 9. Continuity summary ───────────────────────────────────────────────
  const blueprint: StoryBlueprint = {
    story_id: entry.story_id,
    material_id: material.material_id,
    title: entry.title,
    summary: `${entry.purpose} The story covers ${orderedConcepts
      .map((c) => c.name)
      .join(", ")}.`,
    character_ids: characterIds,
    chapters,
    puzzles,
    endings: [ending],
    continuity_summary: {
      story_id: entry.story_id,
      outcome_description: outcome?.description ?? ending.title,
      // The engine has no branching choice scenes, so no decisions are possible.
      key_decisions: [],
      world_state_snapshot: { ...ending.world_state_changes },
      relationship_snapshot: { ...ending.relationship_changes },
    },
    knowledge_mapping: knowledgeMapping,
  };

  // ── 10. Non-blocking context warnings ───────────────────────────────────
  if (entry.required_knowledge.length > 0 && previousSummaries.length === 0) {
    warnings.push({
      code: "CONTINUITY_CONTEXT_MISSING",
      message: `Story "${entry.story_id}" declares required_knowledge but no previous summaries were supplied; continuity framing is minimal.`,
      path: "previousSummaries",
    });
  }

  return { ok: true, blueprint, warnings };
}
