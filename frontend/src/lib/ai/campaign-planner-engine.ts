/**
 * Campaign Planner Engine — Deterministic Planning (Layer 2, M8)
 *
 * Pure, deterministic transformation:
 *   MaterialBlueprint[] + CampaignPlannerOptions → CampaignBlueprint
 *
 * Guarantees:
 *   - One input material produces exactly one story; every material appears
 *     exactly once in story_sequence (planner rule, distinct from legacy
 *     fixtures which may reuse a material).
 *   - Stable IDs: story_01.., char_01.., outcome_story_XX_success.
 *   - Deterministic ordering: materials are topologically sorted by
 *     cross-material concept prerequisite edges. Ties break by input order.
 *   - Deterministic output: no Date.now(), Math.random(), network, or React.
 *   - Inputs are never mutated.
 *
 * Error model:
 *   Expected failures return EngineError; nothing throws except genuinely
 *   unreachable invariants.
 */

import type { MaterialBlueprint } from "@/lib/types/material";
import type {
  CampaignBlueprint,
  Character,
  Genre,
  StoryOutcome,
  StorySummaryEntry,
} from "@/lib/types/campaign";
import type { ValidationError } from "@/lib/validation/story-validator";
import type {
  CampaignPlannerErrorCode,
  CampaignPlannerOptions,
} from "@/lib/ai/campaign-planner-types";

// ---------------------------------------------------------------------------
// Engine result
// ---------------------------------------------------------------------------

export interface EngineSuccess {
  ok: true;
  blueprint: CampaignBlueprint;
  /** Non-blocking planning warnings (e.g. testability-pending notes). */
  warnings: ValidationError[];
}

export interface EngineError {
  ok: false;
  code: CampaignPlannerErrorCode;
  message: string;
  detail?: unknown;
}

export type EngineResult = EngineSuccess | EngineError;

// ---------------------------------------------------------------------------
// Provenance and dependency derivation
// ---------------------------------------------------------------------------

/**
 * Directed edge set: materialId → materials that must come BEFORE it.
 * Edges are derived only from CROSS-MATERIAL prerequisite references.
 * Intra-material prerequisites do not constrain material ordering.
 */
function deriveMaterialEdges(
  materials: MaterialBlueprint[],
  provenance: Map<string, string>
): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const material of materials) {
    edges.set(material.material_id, new Set<string>());
  }
  for (const material of materials) {
    const deps = edges.get(material.material_id)!;
    for (const concept of material.concepts) {
      for (const prereqId of concept.prerequisites) {
        const owner = provenance.get(prereqId);
        if (owner !== undefined && owner !== material.material_id) {
          deps.add(owner);
        }
      }
    }
  }
  return edges;
}

/**
 * Kahn topological sort. Stable: among available nodes, the one earliest in
 * input order is picked first. Returns null when a cycle exists.
 */
function topoSortMaterials(
  materials: MaterialBlueprint[],
  edges: Map<string, Set<string>>
): MaterialBlueprint[] | null {
  const byId = new Map(materials.map((m) => [m.material_id, m]));
  const inputOrder = new Map(
    materials.map((m, idx) => [m.material_id, idx] as const)
  );
  // Reverse adjacency: dep → [materials depending on it]
  const dependents = new Map<string, string[]>();
  const remainingDeps = new Map<string, number>();

  for (const material of materials) {
    const deps = edges.get(material.material_id)!;
    remainingDeps.set(material.material_id, deps.size);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(material.material_id);
      dependents.set(dep, list);
    }
  }

  // Available = zero remaining deps; ordered by input order for stability.
  const available: string[] = [];
  const pushAvailable = (id: string) => {
    available.push(id);
    available.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));
  };
  for (const [id, count] of remainingDeps) {
    if (count === 0) pushAvailable(id);
  }

  const sorted: MaterialBlueprint[] = [];
  while (available.length > 0) {
    const nextId = available.shift()!;
    const next = byId.get(nextId);
    if (next) sorted.push(next);
    for (const dependentId of dependents.get(nextId) ?? []) {
      const count = (remainingDeps.get(dependentId) ?? 0) - 1;
      remainingDeps.set(dependentId, count);
      if (count === 0) pushAvailable(dependentId);
    }
  }

  if (sorted.length !== materials.length) return null; // cycle
  return sorted;
}

// ---------------------------------------------------------------------------
// Deterministic content templates
// ---------------------------------------------------------------------------

/**
 * Genre templates provide deterministic campaign framing. A future real AI
 * provider may replace these creative fields wholesale; the deterministic
 * structural fields (IDs, ordering, required_knowledge) remain engine-owned.
 */
type GenreTemplate = {
  tone: string;
  setting: string;
  premise: string;
  mainConflictTemplate: string;
  worldRules: string[];
  characters: Array<{ name: string; role: string; description: string }>;
};

const BASE_EXPRESSIONS: Record<string, string> = {
  neutral: "(-_-)",
  worried: "(>_<)",
  thinking: "(¬_¬)",
  surprised: "(O_O)",
  approving: "(^_^)",
  stern: "(ಠ_ಠ)",
};

const GENRE_TEMPLATES: Record<Genre, GenreTemplate> = {
  fantasy: {
    tone: "mysterious",
    setting: "an ancient realm held together by fading wards",
    premise:
      "A world whose old safeguards are failing, where only those who truly understand the underlying principles can restore them.",
    mainConflictTemplate: "The central ward is failing, and only knowledge of {topic} can restore it.",
    worldRules: [
      "The world follows consistent, learnable principles; understanding them is the only reliable path forward.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Keeper",
        role: "Guide",
        description: "A patient guardian of the old knowledge who tests understanding rather than obedience.",
      },
      {
        name: "The Apprentice",
        role: "Companion",
        description: "A curious learner who voices the questions the player should be asking.",
      },
    ],
  },
  modern: {
    tone: "grounded",
    setting: "a contemporary city facing a quiet crisis of failing systems",
    premise:
      "Ordinary systems are breaking down, and practical understanding of the material is the only tool available.",
    mainConflictTemplate: "A critical system is failing, and resolving it requires applying {topic}.",
    worldRules: [
      "The world behaves like reality; every problem has a principled solution.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Mentor",
        role: "Guide",
        description: "An experienced professional who frames problems in practical terms.",
      },
      {
        name: "The Colleague",
        role: "Companion",
        description: "A sharp colleague who works through ideas out loud.",
      },
    ],
  },
  science_fiction: {
    tone: "wondrous",
    setting: "a research frontier where theory decides survival",
    premise:
      "At the edge of known space, only rigorous understanding of the material keeps fragile systems alive.",
    mainConflictTemplate: "The station's core process is failing; only {topic} can stabilize it.",
    worldRules: [
      "Technology follows the material's principles exactly; sloppy thinking has visible consequences.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Chief Scientist",
        role: "Guide",
        description: "A rigorous researcher who values correct reasoning over instinct.",
      },
      {
        name: "The Engineer",
        role: "Companion",
        description: "A hands-on engineer who turns theory into working solutions.",
      },
    ],
  },
  mystery: {
    tone: "suspenseful",
    setting: "a place where the truth is hidden behind layered clues",
    premise:
      "Something is wrong, and the only way to the truth is mastering the material's underlying logic.",
    mainConflictTemplate: "The case cannot be closed without a firm grasp of {topic}.",
    worldRules: [
      "Every clue follows the material's logic; conclusions must be earned.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Detective",
        role: "Guide",
        description: "A methodical investigator who models careful reasoning.",
      },
      {
        name: "The Witness",
        role: "Companion",
        description: "An observant witness who notices what others miss.",
      },
    ],
  },
  historical: {
    tone: "reflective",
    setting: "a pivotal moment in history where knowledge changes fate",
    premise:
      "In an era of change, understanding the material determines which future arrives.",
    mainConflictTemplate: "The moment turns on whether anyone can apply {topic} correctly.",
    worldRules: [
      "The era behaves according to its own constraints; the material's principles still hold.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Archivist",
        role: "Guide",
        description: "A keeper of records who connects ideas across time.",
      },
      {
        name: "The Traveler",
        role: "Companion",
        description: "A curious newcomer who asks the questions history forgot.",
      },
    ],
  },
  survival: {
    tone: "tense",
    setting: "a harsh environment where every resource matters",
    premise:
      "Survival depends on applying the material correctly under pressure, with no room for guesswork.",
    mainConflictTemplate: "Supplies are running out; only correct use of {topic} buys more time.",
    worldRules: [
      "Resources are finite and mistakes cost something real.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Scout",
        role: "Guide",
        description: "A pragmatic survivor who plans before acting.",
      },
      {
        name: "The Medic",
        role: "Companion",
        description: "A careful caretaker who values precision under pressure.",
      },
    ],
  },
  horror: {
    tone: "eerie",
    setting: "a place where misunderstanding has a price",
    premise:
      "Something watches, and safety belongs only to those who understand the material's rules.",
    mainConflictTemplate: "The threat recedes only when {topic} is applied correctly.",
    worldRules: [
      "The threat is bound by consistent rules; knowing them is protection.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Warden",
        role: "Guide",
        description: "A wary figure who knows the rules and enforces them quietly.",
      },
      {
        name: "The Sensitive",
        role: "Companion",
        description: "A perceptive companion who senses what the rules imply.",
      },
    ],
  },
  custom: {
    tone: "unspecified",
    setting: "a world shaped by the player's chosen genre",
    premise:
      "A custom-built world where the material's principles drive every challenge.",
    mainConflictTemplate: "The campaign conflict can only be resolved by applying {topic}.",
    worldRules: [
      "The world's custom rules must stay consistent with the material's principles.",
      "Academic accuracy is never sacrificed for narrative flair.",
    ],
    characters: [
      {
        name: "The Guide",
        role: "Guide",
        description: "A steady presence who frames each challenge.",
      },
      {
        name: "The Companion",
        role: "Companion",
        description: "A loyal companion who helps the player reason through problems.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Deterministic ID and text generation
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function storyTitleFor(material: MaterialBlueprint): string {
  return material.title;
}

function storyPurposeFor(material: MaterialBlueprint): string {
  const first = material.learning_objectives[0] ?? material.summary;
  return `Introduce and apply: ${first}`;
}

function storyConflictFor(material: MaterialBlueprint, genre: Genre): string {
  const template = GENRE_TEMPLATES[genre].mainConflictTemplate;
  return template.replace("{topic}", material.title);
}

function storyOutcomesFor(
  storyNumber: number
): StoryOutcome[] {
  const outcomes: StoryOutcome[] = [
    {
      outcome_id: `outcome_story_${pad(storyNumber)}_success`,
      description: "The story's central problem is fully resolved.",
      // Planner-owned world-state key. The engine accumulates deltas; it does
      // not require a fixed key set. Values are deterministic and increasing
      // so later stories still leave a visible mark on the world.
      world_state_changes: { stability: 10 + (storyNumber - 1) * 5 },
    },
  ];
  return outcomes;
}

function charactersFor(
  campaignId: string,
  genre: Genre
): Character[] {
  const template = GENRE_TEMPLATES[genre];
  return template.characters.map((char, idx) => ({
    character_id: `char_${pad(idx + 1)}`,
    name: char.name,
    role: char.role,
    description: `${char.description} (campaign ${campaignId})`,
    expressions: { ...BASE_EXPRESSIONS },
  }));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build a CampaignBlueprint from validated materials and options.
 *
 * Deterministic: identical inputs produce identical output (deep-equal).
 * Pure: inputs are never mutated. No wall-clock, no randomness.
 */
export function buildCampaignBlueprint(
  materials: MaterialBlueprint[],
  options: CampaignPlannerOptions
): EngineResult {
  // ── 1. Duplicate material_id ────────────────────────────────────────────
  const seenMaterialIds = new Set<string>();
  for (const material of materials) {
    if (seenMaterialIds.has(material.material_id)) {
      return {
        ok: false,
        code: "DUPLICATE_MATERIAL_ID",
        message: `Duplicate material_id "${material.material_id}" in planner request.`,
      };
    }
    seenMaterialIds.add(material.material_id);
  }

  // ── 2. Global concept_id uniqueness ────────────────────────────────────
  const provenance = new Map<string, string>(); // concept_id → material_id
  for (const material of materials) {
    for (const concept of material.concepts) {
      const existingOwner = provenance.get(concept.concept_id);
      if (existingOwner !== undefined) {
        return {
          ok: false,
          code: "DUPLICATE_CONCEPT_ID",
          message: `concept_id "${concept.concept_id}" is defined by both "${existingOwner}" and "${material.material_id}". Concept IDs must be globally unique across all materials.`,
        };
      }
      provenance.set(concept.concept_id, material.material_id);
    }
  }

  // ── 3. Unresolved prerequisite references ───────────────────────────────
  for (const material of materials) {
    for (const concept of material.concepts) {
      for (const prereqId of concept.prerequisites) {
        if (!provenance.has(prereqId)) {
          return {
            ok: false,
            code: "INVALID_PREREQUISITE_REF",
            message: `Concept "${concept.concept_id}" in material "${material.material_id}" references unknown prerequisite "${prereqId}".`,
          };
        }
      }
    }
  }

  // ── 4. Cross-material dependency edges ──────────────────────────────────
  const edges = deriveMaterialEdges(materials, provenance);

  // ── 5. Stable topological ordering ───────────────────────────────────────
  const sorted = topoSortMaterials(materials, edges);
  if (sorted === null) {
    const cycleDetail = materials
      .map((m) => {
        const deps = edges.get(m.material_id)!;
        return deps.size === 0
          ? `${m.material_id}: []`
          : `${m.material_id}: [${[...deps].sort().join(", ")}]`;
      })
      .join("; ");
    return {
      ok: false,
      code: "PREREQUISITE_CYCLE",
      message: "Cross-material prerequisite dependencies form a cycle and cannot be ordered.",
      detail: { edges: cycleDetail },
    };
  }

  // ── 6. Campaign-level framing ───────────────────────────────────────────
  const genre: Genre = options.genre;
  const template = GENRE_TEMPLATES[genre];
  const campaignId = options.campaignId ?? "campaign_001";
  const tone = options.tone ?? template.tone;
  const setting = options.setting ?? template.setting;

  const domainTitles = sorted.map((m) => m.title);
  const premise =
    template.premise +
    (domainTitles.length > 0
      ? ` The journey spans: ${domainTitles.join(" → ")}.`
      : "");
  const mainConflict = `The campaign's central problem can only be resolved by mastering ${domainTitles[domainTitles.length - 1] ?? "the material"}.`;

  // ── 7. Story sequence ───────────────────────────────────────────────────
  const warnings: ValidationError[] = [];
  const story_sequence: StorySummaryEntry[] = [];

  sorted.forEach((material, index) => {
    const storyNumber = index + 1;

    // Derive required_knowledge from CROSS-MATERIAL prerequisites only:
    // concepts defined by earlier materials that this material depends on.
    const earlierMaterials = new Set(
      sorted.slice(0, index).map((m) => m.material_id)
    );
    const requiredKnowledge: string[] = [];
    for (const concept of material.concepts) {
      for (const prereqId of concept.prerequisites) {
        const owner = provenance.get(prereqId)!; // existence checked in step 3
        if (earlierMaterials.has(owner) && !requiredKnowledge.includes(prereqId)) {
          requiredKnowledge.push(prereqId);
        }
      }
    }

    // Testability note: knowledge unlocks require `demonstrated`, which is
    // earned only via a puzzle answered correctly on the first attempt. At
    // planner time we cannot know which puzzles Layer 3 will generate, so
    // every derived prerequisite is reported as testability-pending for M9.
    for (const prereqId of requiredKnowledge) {
      warnings.push({
        code: "PREREQUISITE_TESTABILITY_PENDING",
        message: `Story ${pad(storyNumber)} requires concept "${prereqId}". Layer 3 must provide a puzzle testing this concept in an earlier story, or the story cannot be unlocked.`,
        path: `story_sequence[story_${pad(storyNumber)}].required_knowledge`,
      });
    }

    story_sequence.push({
      story_id: `story_${pad(storyNumber)}`,
      material_id: material.material_id,
      title: storyTitleFor(material),
      purpose: storyPurposeFor(material),
      main_conflict: storyConflictFor(material, genre),
      required_knowledge: requiredKnowledge,
      outcomes: storyOutcomesFor(storyNumber),
    });
  });

  // ── 8. Assemble ─────────────────────────────────────────────────────────
  const blueprint: CampaignBlueprint = {
    campaign_id: campaignId,
    title: `${template.characters[0].name}'s Campaign: ${domainTitles[0] ?? "Learning Journey"}`,
    genre,
    tone,
    premise,
    main_conflict: mainConflict,
    setting,
    characters: charactersFor(campaignId, genre),
    world_rules: template.worldRules,
    story_sequence,
  };

  return { ok: true, blueprint, warnings };
}
