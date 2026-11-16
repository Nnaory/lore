/**
 * Test fixture — linear stories
 *
 * Small, stable StoryBlueprints used by engine and UI tests. They are kept
 * separate from the demo content in `src/data/dummy-campaign.ts`, which is
 * written for players and changes over time.
 *
 * `linearStory` shape (relied on by tests):
 *   - 1 chapter, 5 scenes: scene_01_intro (4 blocks) → scene_02_learning →
 *     scene_03_puzzle → scene_04_consequence → scene_05_ending
 *   - puzzle_01: choice_A / choice_C are wrong, choice_B is correct.
 *     No `on_incorrect_scene_id`, so wrong answers use inline feedback.
 *   - Characters are the ones from `dummyCampaign` (eldric, lyra).
 *
 * `linearStory2` is a minimal second story (no puzzles) for campaign
 * progression tests.
 *
 * Content copied from the demo story as of commit 8d0d691.
 */

import type { StoryBlueprint } from "@/lib/types/story";

export const linearStory: StoryBlueprint = {
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

export const linearStory2: StoryBlueprint = {
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
