/**
 * Dummy Campaign Data — "The Last Beacon"
 *
 * Realistic sample data used for:
 *   - Testing Zod schema validation
 *   - Testing semantic validators
 *   - Driving Milestone 2 Story Viewer development
 *
 * Content: 1 campaign, 2 characters, 1 material blueprint,
 *          1 story, 1 chapter, several scenes, 1 learning scene,
 *          1 puzzle with 3 choices, 1 ending.
 *
 * Learning topic: Linear Combinations (Linear Algebra)
 */

import type { MaterialBlueprint } from "@/lib/types/material";
import type { CampaignBlueprint } from "@/lib/types/campaign";
import type { StoryBlueprint } from "@/lib/types/story";
import type { CampaignState } from "@/lib/types/game";
import type { StoryState } from "@/lib/types/game";

// ---------------------------------------------------------------------------
// Material Blueprint
// ---------------------------------------------------------------------------

export const dummyMaterial: MaterialBlueprint = {
  material_id: "material_01",
  title: "Introduction to Linear Combinations",
  summary:
    "Covers vector scaling and addition, the concept of linear combination, and how to determine whether a target vector can be expressed as a combination of given vectors.",
  learning_objectives: [
    "Understand how vectors can be scaled by scalar coefficients.",
    "Understand how scaled vectors can be combined through addition.",
    "Determine whether a target vector lies within the span of given vectors.",
    "Solve for scalar coefficients that produce a required linear combination.",
  ],
  concepts: [
    {
      concept_id: "concept_linear_combination",
      name: "Linear Combination",
      definition:
        "A linear combination of vectors v₁, v₂, … vₙ is an expression of the form c₁v₁ + c₂v₂ + … + cₙvₙ, where c₁…cₙ are scalar coefficients.",
      principles: [
        "A vector can be scaled by multiplying each of its components by a scalar.",
        "Two scaled vectors can be added component-wise.",
        "Any vector in the span of a set can be expressed as a linear combination.",
      ],
      methods: [
        "Set up a system of equations: c₁ * v₁ + c₂ * v₂ = target.",
        "Solve for c₁ and c₂ using substitution or elimination.",
        "Verify by substituting back into the original equation.",
      ],
      prerequisites: [],
      misconceptions: [
        "Confusing scalar multiplication with dot product.",
        "Assuming all vectors can always be combined to produce any target.",
      ],
      source_evidence: [
        "A linear combination of vectors v₁ and v₂ is defined as c₁v₁ + c₂v₂ for scalars c₁ and c₂.",
        "If a target vector t can be expressed as c₁v₁ + c₂v₂, then t is in the span of {v₁, v₂}.",
      ],
    },
    {
      concept_id: "concept_vector_span",
      name: "Vector Span",
      definition:
        "The span of a set of vectors is the set of all possible linear combinations of those vectors.",
      principles: [
        "Two non-parallel vectors in ℝ² span the entire plane.",
        "Parallel vectors only span a single line.",
      ],
      methods: [
        "Determine if a target vector can be written as a linear combination.",
        "Check whether the coefficient system has a consistent solution.",
      ],
      prerequisites: ["concept_linear_combination"],
      misconceptions: [
        "Assuming more vectors always produce a larger span.",
        "Confusing span with the set of vectors themselves.",
      ],
      source_evidence: [
        "The span of {v₁, v₂} is the set {c₁v₁ + c₂v₂ | c₁, c₂ ∈ ℝ}.",
      ],
    },
  ],
  scope_limitations: [
    "This material does not cover vector spaces with more than two dimensions.",
    "Matrix notation and operations are not covered.",
  ],
};

// ---------------------------------------------------------------------------
// Campaign Blueprint
// ---------------------------------------------------------------------------

export const dummyCampaign: CampaignBlueprint = {
  campaign_id: "campaign_001",
  title: "The Last Beacon",
  genre: "fantasy",
  tone: "mysterious",
  premise:
    "A world where ancient beacons are the only things keeping reality stable. One by one, they are going dark.",
  main_conflict:
    "The final and most powerful beacon at the heart of the Veiled City is losing its power. Without it, the world will fragment.",
  setting: "The Veiled City — an ancient metropolis built around a network of magical beacons.",
  characters: [
    {
      character_id: "eldric",
      name: "Eldric",
      role: "Keeper of the Beacon",
      description:
        "An aging scholar who has dedicated his life to maintaining the beacons. He speaks in measured tones but hides deep worry behind his calm exterior.",
      expressions: {
        neutral: "(-_-)",
        worried: "(>_<)",
        thinking: "(¬_¬)",
        surprised: "(O_O)",
        approving: "(^_^)",
        stern: "(ಠ_ಠ)",
      },
    },
    {
      character_id: "lyra",
      name: "Lyra",
      role: "Apprentice Keeper",
      description:
        "A sharp and curious apprentice who understands the theory but has never faced a real crisis. She tends to think out loud.",
      expressions: {
        neutral: "(-_-)",
        curious: "(o_o)",
        excited: "(^o^)",
        nervous: "(._. )",
        focused: "(>.<)",
        relieved: "(^_^;)",
      },
    },
  ],
  world_rules: [
    "Beacons operate on principles of vector resonance — they require precise harmonic combinations to function.",
    "Incorrect resonance combinations cause energy drain rather than amplification.",
    "The Veiled City's stability is directly tied to the combined output of all active beacons.",
  ],
  story_sequence: [
    {
      story_id: "story_01",
      material_id: "material_01",
      title: "The Fading Light",
      purpose:
        "Introduce the concept of linear combination through the beacon resonance system.",
      main_conflict:
        "The primary beacon is destabilising. The correct resonance combination must be found before it goes dark.",
      required_knowledge: [],
      outcomes: [
        {
          outcome_id: "outcome_beacon_restored",
          description: "The beacon is successfully restored.",
          world_state_changes: { stability: 20, beacon_power: 50 },
        },
        {
          outcome_id: "outcome_beacon_partial",
          description: "The beacon is stabilised but not fully restored.",
          world_state_changes: { stability: 10, beacon_power: 25 },
        },
      ],
    },
    {
      story_id: "story_02",
      material_id: "material_01",
      title: "The Outer Districts",
      purpose:
        "Apply the concept of vector span to determine which areas of the city can still be reached.",
      main_conflict:
        "The outer district beacons are failing. The path forward depends on which resonance combinations are still viable.",
      required_knowledge: ["concept_linear_combination"],
      outcomes: [
        {
          outcome_id: "outcome_districts_secured",
          description: "The outer districts are secured.",
          world_state_changes: { stability: 15, beacon_power: 20 },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Story Blueprint
// ---------------------------------------------------------------------------

export const dummyStory: StoryBlueprint = {
  story_id: "story_01",
  material_id: "material_01",
  title: "The Fading Light",
  summary:
    "The player arrives at the Veiled City's primary beacon just as it begins to fail. By working with Eldric and Lyra, they must understand the resonance system and find the correct crystal combination to restore the beacon.",
  character_ids: ["eldric", "lyra"],
  chapters: [
    {
      chapter_id: "chapter_01",
      title: "The Fading Light",
      scenes: [
        // ── Scene 1: Narrative introduction ──────────────────────────────
        {
          scene_id: "scene_01_intro",
          type: "narrative",
          location: "The Beacon Antechamber",
          characters_present: ["eldric"],
          content: [
            {
              type: "narration",
              text: "The stone corridor smells of old smoke. At the far end, a faint amber glow pulses like a dying heartbeat. Each pulse is a little weaker than the last.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "worried",
              text: "You arrived just in time. Or perhaps just too late. I haven't decided which.",
            },
            {
              type: "narration",
              text: "The old keeper does not look up from the diagrams scattered across the stone floor.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "thinking",
              text: "The beacon requires a specific harmonic resonance. Without the correct combination, it will simply… stop.",
            },
          ],
          next_scene_id: "scene_02_learning",
        },

        // ── Scene 2: Learning scene ───────────────────────────────────────
        {
          scene_id: "scene_02_learning",
          type: "learning",
          location: "The Beacon Antechamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "curious",
              text: "The resonance works through crystal vectors. Think of each crystal type as a direction and magnitude of energy.",
            },
            {
              type: "learning_info",
              title: "Crystal Vector Resonance",
              body: "Each crystal contributes energy in the form of a vector — a quantity with both direction and magnitude. Crystal A provides a resonance of (2, 1): two units of vertical energy and one unit of lateral energy. Crystal B provides a resonance of (1, 2): one unit vertical and two lateral. To reach the beacon's required resonance, you must combine crystals using scalar multiples and add the results. For example, using two Crystal A and one Crystal B gives: 2×(2,1) + 1×(1,2) = (4,2) + (1,2) = (5,4). This technique is called a linear combination.",
              concept_ids: ["concept_linear_combination"],
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "The beacon requires a target resonance of exactly (5, 4). Any deviation will accelerate the collapse.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "focused",
              text: "We have crystals available. We need to figure out how many of each type to use.",
            },
          ],
          next_scene_id: "scene_03_puzzle",
        },

        // ── Scene 3: Puzzle scene ─────────────────────────────────────────
        {
          scene_id: "scene_03_puzzle",
          type: "puzzle",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          puzzle_id: "puzzle_01",
          next_scene_id: "scene_04_consequence",
        },

        // ── Scene 4: Consequence scene ────────────────────────────────────
        {
          scene_id: "scene_04_consequence",
          type: "consequence",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "The moment the correct crystals are placed, the beacon pulses — once, twice — and then erupts in a steady warm light that fills the entire chamber.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "approving",
              text: "The resonance holds. You've bought us time.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "relieved",
              text: "That was the right combination. Two Crystal A and one Crystal B — the linear combination that reaches the target (5,4).",
            },
          ],
          next_scene_id: "scene_05_ending",
        },

        // ── Scene 5: Ending scene ─────────────────────────────────────────
        {
          scene_id: "scene_05_ending",
          type: "ending",
          location: "The Beacon Antechamber",
          characters_present: ["eldric", "lyra"],
          ending_id: "ending_beacon_restored",
        },
      ],
    },
  ],

  puzzles: [
    {
      puzzle_id: "puzzle_01",
      concept_ids: ["concept_linear_combination"],
      narrative_context:
        "The beacon's resonance system is failing. Eldric's diagrams show the required target resonance is (5, 4). Crystal A has a resonance vector of (2, 1) and Crystal B has a resonance vector of (1, 2). You must choose the correct combination of crystals to restore the beacon.",
      question:
        "Which combination of Crystal A and Crystal B produces the required resonance of (5, 4)?",
      choices: [
        {
          choice_id: "choice_A",
          text: "Use one Crystal A and one Crystal B. → 1×(2,1) + 1×(1,2) = (3,3)",
        },
        {
          choice_id: "choice_B",
          text: "Use two Crystal A and one Crystal B. → 2×(2,1) + 1×(1,2) = (5,4)",
        },
        {
          choice_id: "choice_C",
          text: "Use one Crystal A and two Crystal B. → 1×(2,1) + 2×(1,2) = (4,5)",
        },
      ],
      correct_choice_id: "choice_B",
      explanation:
        "The correct answer is 2×Crystal A + 1×Crystal B. Computing: 2×(2,1) = (4,2) and 1×(1,2) = (1,2). Adding them gives (4+1, 2+2) = (5,4), which is exactly the required resonance. This is a linear combination c₁v₁ + c₂v₂ where c₁=2, c₂=1, v₁=(2,1), v₂=(1,2).",
      incorrect_feedback:
        "The resonance did not match the target (5,4). Check your calculation: multiply each crystal's vector by the number of crystals used, then add the results component-wise.",
      correct_feedback:
        "Correct! The beacon resonates perfectly. 2×(2,1) + 1×(1,2) = (4,2) + (1,2) = (5,4).",
      retry_allowed: true,
    },
  ],

  endings: [
    {
      ending_id: "ending_beacon_restored",
      type: "success",
      title: "The Beacon Holds",
      narration:
        "The Veiled City breathes again. The beacon's light extends outward, reconnecting with the network of smaller beacons across the districts. For now, the city is safe. But Eldric's expression does not entirely relax — somewhere in the distance, another beacon flickers.",
      world_state_changes: { stability: 20, beacon_power: 50 },
      relationship_changes: { eldric: 15, lyra: 10 },
    },
  ],

  continuity_summary: null,

  knowledge_mapping: [
    {
      concept_id: "concept_linear_combination",
      introduced_in_scene_id: "scene_02_learning",
      tested_in_puzzle_id: "puzzle_01",
    },
  ],
};

// ---------------------------------------------------------------------------
// Story 2 Blueprint — "The Outer Districts"
// A minimal second story used for campaign progression testing.
// ---------------------------------------------------------------------------

export const dummyStory2: StoryBlueprint = {
  story_id: "story_02",
  material_id: "material_01",
  title: "The Outer Districts",
  summary:
    "With the primary beacon restored, the team turns to the failing outer district beacons. The span of the available resonance vectors determines what can still be saved.",
  character_ids: ["eldric", "lyra"],
  chapters: [
    {
      chapter_id: "chapter_02_01",
      title: "The Districts",
      scenes: [
        {
          scene_id: "s2_scene_01",
          type: "narrative",
          location: "The Outer Ward",
          characters_present: ["lyra"],
          content: [
            {
              type: "narration",
              text: "The outer ward is quieter than before. The beacons here pulse with an unsteady rhythm.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "focused",
              text: "We have two resonance types available. We need to determine which districts we can still reach.",
            },
          ],
          next_scene_id: "s2_scene_02_ending",
        },
        {
          scene_id: "s2_scene_02_ending",
          type: "ending",
          location: "The Outer Ward",
          characters_present: ["eldric", "lyra"],
          ending_id: "s2_ending_districts_secured",
        },
      ],
    },
  ],
  puzzles: [],
  endings: [
    {
      ending_id: "s2_ending_districts_secured",
      type: "success",
      title: "The Districts Hold",
      narration:
        "The outer ward beacons stabilise. The Veiled City endures for another day.",
      world_state_changes: { stability: 15, beacon_power: 20 },
      relationship_changes: { lyra: 10 },
    },
  ],
  continuity_summary: null,
  knowledge_mapping: [],
};

// ---------------------------------------------------------------------------
// Initial Campaign State
// ---------------------------------------------------------------------------

export const dummyCampaignState: CampaignState = {
  campaign_id: "campaign_001",
  current_story_id: "story_01",
  completed_stories: [],
  world_state: {
    stability: 50,
    beacon_power: 30,
  },
  relationships: {
    eldric: 50,
    lyra: 50,
  },
  major_decisions: [],
  player_knowledge: {},
  previous_story_summaries: [],
};

// ---------------------------------------------------------------------------
// Initial Story State
// ---------------------------------------------------------------------------

export const dummyStoryState: StoryState = {
  story_id: "story_01",
  current_chapter_id: "chapter_01",
  current_scene_id: "scene_01_intro",
  hp: 5,
  status: "in_progress",
  puzzle_attempts: {},
  story_decisions: [],
};
