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
import type { CampaignPlannerOptions } from "@/lib/ai/campaign-planner-types";

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
    "The player arrives at the Veiled City's primary beacon just as it begins to fail. Working with Eldric and Lyra, they must master crystal vector resonance — a linear combination — to restore the beacon before the city goes dark forever.",
  character_ids: ["eldric", "lyra"],
  chapters: [
    // ══════════════════════════════════════════════════════════════════════
    // Chapter 1 — Arrival
    // ══════════════════════════════════════════════════════════════════════
    {
      chapter_id: "chapter_01",
      title: "Arrival at the Dying Light",
      scenes: [
        // ── Scene 1: Arrival ───────────────────────────────────────────────
        {
          scene_id: "scene_01_arrival",
          type: "narrative",
          location: "The Outer Gate, Veiled City",
          characters_present: ["eldric"],
          content: [
            {
              type: "narration",
              text: "The city of Vel Thyras greets you in silence. Where there should be the hum of a thousand amber lanterns, there is only the scrape of your boots on cold stone.",
            },
            {
              type: "narration",
              text: "The sky above the city's spire flickers — a great, pulsing amber light that skips a beat, then two, then three. Like a heart forgetting how to beat.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "worried",
              text: "You came. Good. I wasn't sure the message would reach the outer roads in time.",
            },
            {
              type: "narration",
              text: "Eldric, Keeper of the Primary Beacon, looks older than the last time you saw him. The lines on his face run deeper. He clutches a rolled diagram to his chest.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "thinking",
              text: "The Primary Beacon is failing. If it goes dark, every district beacon loses its anchor. The whole lattice collapses within the hour.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "We don't have the luxury of caution. Follow me.",
            },
          ],
          next_scene_id: "scene_02_antechamber",
        },

        // ── Scene 2: The Antechamber ───────────────────────────────────────
        {
          scene_id: "scene_02_antechamber",
          type: "narrative",
          location: "The Beacon Antechamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "The antechamber smells of hot copper and old smoke. Lyra, Eldric's apprentice, is already at the stone table, mapping resonance vectors with a piece of chalk.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "You're here. Good. Eldric's been pacing since dawn.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "thinking",
              text: "Every beacon runs on harmonic resonance — a precise combination of crystal energies that must match the beacon's required frequency exactly.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "Too little, and the beacon starves. Too much of the wrong kind, and it inverts — which is considerably worse than simply going dark.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "curious",
              text: "Think of each crystal as a vector — a direction and a magnitude of energy. We scale them and combine them to hit a target.",
            },
            {
              type: "narration",
              text: "She taps the chalk diagram. Two vectors are drawn: one steep, one shallow. A third vector — the target — is marked in gold.",
            },
          ],
          next_scene_id: "scene_03_learning",
        },

        // ── Scene 3: Learning — Linear Combinations ────────────────────────
        {
          scene_id: "scene_03_learning",
          type: "learning",
          location: "The Beacon Antechamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "focused",
              text: "We have two crystal types in the vault. Crystal A resonates at vector (2, 1) — heavy on vertical energy, lighter on lateral. Crystal B resonates at (1, 2) — the reverse.",
            },
            {
              type: "learning_info",
              title: "Crystal Vector Resonance — Linear Combinations",
              body: "Each crystal emits energy as a vector: a quantity with both direction (vertical vs. lateral) and magnitude. Crystal A = (2, 1). Crystal B = (1, 2).\n\nTo produce a target resonance, you scale each crystal by how many you use and add the results component-wise. This is a linear combination:\n\n  c₁ · v₁ + c₂ · v₂ = target\n\nExample — 2 Crystal A and 1 Crystal B:\n  2 × (2, 1) + 1 × (1, 2)\n  = (4, 2) + (1, 2)\n  = (5, 4)  ✓\n\nThe coefficients (c₁ = 2, c₂ = 1) are the scalar multipliers. Change them and you get a different resonance.",
              concept_ids: ["concept_linear_combination"],
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "The Primary Beacon's required resonance is (5, 4). That is what we must produce. Exactly.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "curious",
              text: "What happens if we get it wrong?",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "worried",
              text: "An undersupplied resonance causes the beacon to draw energy from the surrounding districts to compensate. It will strip them dark one by one before it finally fails itself.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "And an oversupplied lateral resonance?",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "thinking",
              text: "… Let us not find out.",
            },
          ],
          next_scene_id: "scene_04_before_puzzle",
        },

        // ── Scene 4: Before the Puzzle ─────────────────────────────────────
        {
          scene_id: "scene_04_before_puzzle",
          type: "narrative",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "The inner chamber opens like a wound in the stone. At its centre, the Primary Beacon — a column of crystal lattice three metres tall — shudders with each failing pulse.",
            },
            {
              type: "narration",
              text: "Along the base of the column, three crystal slots wait. The correct number and type of crystals must be placed before the next pulse cycle begins.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "We have about two minutes before the next cycle. If we haven't stabilised it by then…",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "Then choose carefully. The city is watching — even if it doesn't know it.",
            },
          ],
          next_scene_id: "scene_05_puzzle",
        },

        // ── Scene 5: Puzzle ────────────────────────────────────────────────
        {
          scene_id: "scene_05_puzzle",
          type: "puzzle",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          puzzle_id: "puzzle_01",
          next_scene_id: "scene_06_success_reaction",
          on_incorrect_scene_id: {
            choice_A: "scene_bad_A_start",
            choice_C: "scene_bad_C_start",
          },
        },

        // ── Scene 6: Correct — Reaction ────────────────────────────────────
        {
          scene_id: "scene_06_success_reaction",
          type: "consequence",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "The crystals click into place. For a moment — silence. Then the column ignites.",
            },
            {
              type: "narration",
              text: "A deep, resonant tone fills the chamber, rising in pitch until it settles into a steady, warm hum. The amber light stops flickering. It holds.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "approving",
              text: "It holds. By the old frequencies — it actually holds.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "relieved",
              text: "Two Crystal A, one Crystal B. 2×(2,1) + 1×(1,2) = (5,4). The exact linear combination.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "thinking",
              text: "You've bought the city time. Perhaps enough to reach the outer districts before they fail too.",
            },
          ],
          next_scene_id: "scene_07_chapter1_end",
        },

        // ── Scene 7: Chapter 1 close ───────────────────────────────────────
        {
          scene_id: "scene_07_chapter1_end",
          type: "narrative",
          location: "The Beacon Antechamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "The antechamber feels warmer now. The diagrams on the stone floor are no longer urgent — they are reference material.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "curious",
              text: "The district beacons draw from the same resonance principles. We'll need to know more than just one combination.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "thinking",
              text: "She's right. The question isn't just what we can combine — it's what range of resonances we can even reach with the crystals we have.",
            },
            {
              type: "narration",
              text: "He pauses, spreading a new diagram across the table. This one shows not two vectors — but the entire region they can cover.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "The span of a set of vectors. That is what determines whether a district can be saved.",
            },
          ],
          next_scene_id: "scene_08_ch2_intro",
        },
      ],
    },

    // ══════════════════════════════════════════════════════════════════════
    // Chapter 2 — The Span
    // ══════════════════════════════════════════════════════════════════════
    {
      chapter_id: "chapter_02",
      title: "The Reach of Vectors",
      scenes: [
        // ── Scene 8: Chapter 2 intro ───────────────────────────────────────
        {
          scene_id: "scene_08_ch2_intro",
          type: "narrative",
          location: "The Keeper's Map Room",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "The Map Room is a circular chamber whose walls are covered in overlapping vector diagrams, each annotated in Eldric's cramped handwriting. At the centre is a table-sized topographical map of the Veiled City.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "curious",
              text: "Every district beacon needs a different target resonance. We can't just reuse the same crystal combination everywhere.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "thinking",
              text: "Correct. Each district's beacon was calibrated when the city was built. The Northern Ward needs (3, 3). The Eastern Ward needs (4, 5).",
            },
            {
              type: "narration",
              text: "He sets two crystals on the table. One amber, one deep blue.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "We have new crystal types available here. Crystal C resonates at (1, 1). Crystal D resonates at (2, 3). The question is: which of those district targets can we actually reach?",
            },
          ],
          next_scene_id: "scene_09_span_learning",
        },

        // ── Scene 9: Learning — Span ───────────────────────────────────────
        {
          scene_id: "scene_09_span_learning",
          type: "learning",
          location: "The Keeper's Map Room",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "focused",
              text: "The span of two vectors is the set of every resonance we can possibly produce using those two crystals — any amount, any ratio.",
            },
            {
              type: "learning_info",
              title: "Vector Span — The Set of All Reachable Resonances",
              body: "The span of vectors v₁ and v₂ is the set of all vectors expressible as c₁v₁ + c₂v₂ for any real scalars c₁ and c₂.\n\nIf v₁ and v₂ point in genuinely different directions (non-parallel), their span covers the entire plane — meaning any target is reachable.\n\nIf v₁ and v₂ are parallel (one is a scalar multiple of the other), their span is just a single line.\n\nTo check if a specific target t is in the span of {v₁, v₂}, set up the system:\n  c₁v₁ + c₂v₂ = t\nand solve for c₁ and c₂. If a real solution exists, t is reachable.\n\nCrystal C = (1, 1). Crystal D = (2, 3).\nAre these parallel? (2, 3) = k × (1, 1) would require k = 2 and k = 3 simultaneously — impossible. So they span the full plane.",
              concept_ids: ["concept_vector_span"],
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "excited",
              text: "So Crystal C and Crystal D together can reach any resonance. Including both district targets.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "approving",
              text: "In theory. But we only have enough crystal stock for one district tonight. We must choose the correct combination for the Eastern Ward — resonance (4, 5) — and get it right.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "And if we apply the wrong combination to the Eastern Ward?",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "worried",
              text: "The Eastern Ward's beacon will invert. It will begin drawing resonance from the Northern Ward instead of contributing to it. We'd lose both.",
            },
          ],
          next_scene_id: "scene_10_before_puzzle2",
        },

        // ── Scene 10: Before Puzzle 2 ──────────────────────────────────────
        {
          scene_id: "scene_10_before_puzzle2",
          type: "narrative",
          location: "The Eastern Ward Beacon",
          characters_present: ["lyra"],
          content: [
            {
              type: "narration",
              text: "The Eastern Ward is a residential district — narrow streets, low buildings, lanterns that haven't been lit in two days. The people here have started burning furniture for light.",
            },
            {
              type: "narration",
              text: "The district beacon stands in a small courtyard at the ward's centre. It's smaller than the Primary Beacon, but its failure has felt larger here.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "focused",
              text: "Eldric stayed at the Map Room to monitor the primary. It's just us. We need to find c₁ and c₂ such that c₁ × (1,1) + c₂ × (2,3) = (4,5).",
            },
            {
              type: "narration",
              text: "She lays the crystals out in a row, counting quietly under her breath.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "Take your time. But not too much of it.",
            },
          ],
          next_scene_id: "scene_11_puzzle2",
        },

        // ── Scene 11: Puzzle 2 ─────────────────────────────────────────────
        {
          scene_id: "scene_11_puzzle2",
          type: "puzzle",
          location: "The Eastern Ward Beacon",
          characters_present: ["lyra"],
          puzzle_id: "puzzle_02",
          next_scene_id: "scene_12_success2",
          on_incorrect_scene_id: {
            choice_P: "scene_bad_P_start",
            choice_R: "scene_bad_R_start",
          },
        },

        // ── Scene 12: Success 2 ────────────────────────────────────────────
        {
          scene_id: "scene_12_success2",
          type: "consequence",
          location: "The Eastern Ward Beacon",
          characters_present: ["lyra"],
          content: [
            {
              type: "narration",
              text: "The beacon lights. Not the sputtering amber of a dying flame — a clean, steady gold that pushes the darkness back down the street.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "relieved",
              text: "c₁ = 2, c₂ = 1. Two Crystal C and one Crystal D: 2×(1,1) + 1×(2,3) = (2,2) + (2,3) = (4,5). The Eastern Ward is restored.",
            },
            {
              type: "narration",
              text: "Somewhere above the rooftops, a window opens. A child looks out at the lit street below, surprised. Someone laughs.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "curious",
              text: "One ward at a time. We still have the Northern Ward, the Docks, and whatever Eldric isn't telling us about.",
            },
          ],
          next_scene_id: "scene_13_good_ending",
        },

        // ── Scene 13: Good Ending ──────────────────────────────────────────
        {
          scene_id: "scene_13_good_ending",
          type: "ending",
          location: "The Eastern Ward",
          characters_present: ["eldric", "lyra"],
          ending_id: "ending_city_holds",
        },

        // ══════════════════════════════════════════════════════════════════
        // BAD BRANCH — Choice A (wrong: 1 Crystal A + 1 Crystal B = (3,3))
        // ══════════════════════════════════════════════════════════════════
        {
          scene_id: "scene_bad_A_start",
          type: "consequence",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "You place one Crystal A and one Crystal B into the beacon's base. The column pulses — once, eagerly — and then begins to whine.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "Wait. That's not right. The hum is too low — it's under-resonating.",
            },
            {
              type: "narration",
              text: "1×(2,1) + 1×(1,2) = (3,3). The beacon needs (5,4). The vertical axis is starved by two units, the lateral by one.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "worried",
              text: "It's compensating. Drawing energy from the outer districts to make up the deficit.",
            },
          ],
          next_scene_id: "scene_bad_A_collapse",
        },
        {
          scene_id: "scene_bad_A_collapse",
          type: "consequence",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "The light across the entire lower city goes out in sequence. Ward by ward, the smaller beacons extinguish as the Primary drains them dry.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "The Southern Ward just went dark. The Markets too.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "One Crystal A and one Crystal B gives a resonance of (3,3). We needed (5,4). The combination was insufficient — a correct linear combination requires the right scalar coefficients, not just any combination.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "worried",
              text: "Remove the crystals. Carefully. We may still have time to try again if we're fast.",
            },
          ],
          next_scene_id: "scene_bad_A_ending",
        },
        {
          scene_id: "scene_bad_A_ending",
          type: "ending",
          location: "The Beacon Antechamber",
          characters_present: ["eldric", "lyra"],
          ending_id: "ending_bad_underpowered",
        },

        // ══════════════════════════════════════════════════════════════════
        // BAD BRANCH — Choice C (wrong: 1 Crystal A + 2 Crystal B = (4,5))
        // ══════════════════════════════════════════════════════════════════
        {
          scene_id: "scene_bad_C_start",
          type: "consequence",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "narration",
              text: "You place one Crystal A and two Crystal B into the base. The column ignites — faster than expected, brighter than expected.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "It's too much lateral energy. The vertical axis is a full unit short of the target.",
            },
            {
              type: "narration",
              text: "1×(2,1) + 2×(1,2) = (4,5). The beacon received (4,5) instead of (5,4). The vertical and lateral components are transposed.",
            },
          ],
          next_scene_id: "scene_bad_C_inversion",
        },
        {
          scene_id: "scene_bad_C_inversion",
          type: "consequence",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          content: [
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "worried",
              text: "The resonance is inverted. It's not pulling from the districts yet — but the beacon is already trying to correct itself by reshaping its own lattice.",
            },
            {
              type: "narration",
              text: "A deep crack appears in the lower third of the crystal column. The amber light turns white, then orange, then dims.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "If that lattice fractures, we lose the housing entirely. We'd need a new column, and we don't have one.",
            },
            {
              type: "dialogue",
              character_id: "eldric",
              expression: "stern",
              text: "The resonance (4,5) has the right components — but in the wrong proportions for this beacon. The vertical energy was (5) units; we gave it (4). One Crystal A provides only 2 units of vertical resonance. We needed to scale it up.",
            },
          ],
          next_scene_id: "scene_bad_C_ending",
        },
        {
          scene_id: "scene_bad_C_ending",
          type: "ending",
          location: "The Beacon Chamber",
          characters_present: ["eldric", "lyra"],
          ending_id: "ending_bad_inverted",
        },

        // ══════════════════════════════════════════════════════════════════
        // BAD BRANCH — Puzzle 2, Choice P (wrong: 3 C + 0 D = (3,3) ≠ (4,5))
        // ══════════════════════════════════════════════════════════════════
        {
          scene_id: "scene_bad_P_start",
          type: "consequence",
          location: "The Eastern Ward Beacon",
          characters_present: ["lyra"],
          content: [
            {
              type: "narration",
              text: "Three Crystal C, no Crystal D. The resonance produced is (3,3) — clean, symmetrical, and completely wrong.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "That's not (4,5). The lateral component is short by two and the vertical is short by one.",
            },
            {
              type: "narration",
              text: "The beacon accepts the input and immediately begins to oscillate. The ward lanterns flicker once — then go out entirely as the beacon draws emergency power from the grid.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "Using only Crystal C gives us resonance vectors along the line c₁ × (1,1) — always equal vertical and lateral. We can never reach (4,5) with C alone since 4 ≠ 5.",
            },
          ],
          next_scene_id: "scene_bad_P_ending",
        },
        {
          scene_id: "scene_bad_P_ending",
          type: "ending",
          location: "The Eastern Ward",
          characters_present: ["lyra"],
          ending_id: "ending_bad_eastern_dark",
        },

        // ══════════════════════════════════════════════════════════════════
        // BAD BRANCH — Puzzle 2, Choice R (wrong: 1 C + 2 D = (5,7) ≠ (4,5))
        // ══════════════════════════════════════════════════════════════════
        {
          scene_id: "scene_bad_R_start",
          type: "consequence",
          location: "The Eastern Ward Beacon",
          characters_present: ["lyra"],
          content: [
            {
              type: "narration",
              text: "One Crystal C and two Crystal D. 1×(1,1) + 2×(2,3) = (1,1) + (4,6) = (5,7). The beacon overloads instantly.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "Too much! The resonance is (5,7) — lateral is overdriven by two full units.",
            },
            {
              type: "narration",
              text: "The beacon's housing begins to ring like a struck bell. Lyra grabs the crystals and pulls them free before the structure can fracture.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "focused",
              text: "We needed c₁ × (1,1) + c₂ × (2,3) = (4,5). With c₂ = 2, we get (4,6) from Crystal D alone — already one unit over on the lateral axis.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "nervous",
              text: "We needed c₂ = 1 to keep the lateral component in range. That would have given (2,3) from Crystal D and left (2,2) needed from Crystal C — meaning c₁ = 2.",
            },
          ],
          next_scene_id: "scene_bad_R_ending",
        },
        {
          scene_id: "scene_bad_R_ending",
          type: "ending",
          location: "The Eastern Ward",
          characters_present: ["lyra"],
          ending_id: "ending_bad_eastern_overload",
        },
      ],
    },
  ],

  // ──────────────────────────────────────────────────────────────────────────
  // Puzzles
  // ──────────────────────────────────────────────────────────────────────────
  puzzles: [
    {
      puzzle_id: "puzzle_01",
      concept_ids: ["concept_linear_combination"],
      narrative_context:
        "The Primary Beacon requires a resonance of exactly (5, 4). Crystal A resonates at (2, 1) and Crystal B at (1, 2). You must choose the correct number of each crystal to produce the required combination.",
      question:
        "Which combination of Crystal A and Crystal B produces the required resonance of (5, 4)?",
      choices: [
        {
          choice_id: "choice_A",
          text: "1 Crystal A + 1 Crystal B  →  1×(2,1) + 1×(1,2) = (3, 3)",
        },
        {
          choice_id: "choice_B",
          text: "2 Crystal A + 1 Crystal B  →  2×(2,1) + 1×(1,2) = (5, 4)  ✓",
        },
        {
          choice_id: "choice_C",
          text: "1 Crystal A + 2 Crystal B  →  1×(2,1) + 2×(1,2) = (4, 5)",
        },
      ],
      correct_choice_id: "choice_B",
      explanation:
        "2×(2,1) + 1×(1,2) = (4,2) + (1,2) = (5,4). Coefficient c₁ = 2 and c₂ = 1 produce the exact target. This is a linear combination c₁v₁ + c₂v₂.",
      incorrect_feedback:
        "The resonance did not match (5,4). Multiply each crystal's vector by how many you use, then add component-wise and compare to the target.",
      correct_feedback:
        "Correct. 2×(2,1) + 1×(1,2) = (4,2) + (1,2) = (5,4). The beacon is stable.",
      retry_allowed: true,
    },
    {
      puzzle_id: "puzzle_02",
      concept_ids: ["concept_linear_combination", "concept_vector_span"],
      narrative_context:
        "The Eastern Ward beacon requires resonance (4, 5). Crystal C = (1, 1) and Crystal D = (2, 3). Find the scalar coefficients c₁ and c₂ such that c₁·(1,1) + c₂·(2,3) = (4,5).",
      question:
        "Which combination of Crystal C and Crystal D produces the required resonance of (4, 5)?",
      choices: [
        {
          choice_id: "choice_P",
          text: "3 Crystal C + 0 Crystal D  →  3×(1,1) + 0×(2,3) = (3, 3)",
        },
        {
          choice_id: "choice_Q",
          text: "2 Crystal C + 1 Crystal D  →  2×(1,1) + 1×(2,3) = (4, 5)  ✓",
        },
        {
          choice_id: "choice_R",
          text: "1 Crystal C + 2 Crystal D  →  1×(1,1) + 2×(2,3) = (5, 7)",
        },
      ],
      correct_choice_id: "choice_Q",
      explanation:
        "2×(1,1) = (2,2) and 1×(2,3) = (2,3). Adding gives (4,5). Coefficients c₁ = 2, c₂ = 1 solve the system: c₁ + 2c₂ = 4 and c₁ + 3c₂ = 5.",
      incorrect_feedback:
        "The resonance did not match (4,5). Set up the system c₁(1,1) + c₂(2,3) = (4,5) and solve component-wise.",
      correct_feedback:
        "Correct. 2×(1,1) + 1×(2,3) = (2,2) + (2,3) = (4,5). The Eastern Ward beacon is restored.",
      retry_allowed: true,
    },
  ],

  // ──────────────────────────────────────────────────────────────────────────
  // Endings
  // ──────────────────────────────────────────────────────────────────────────
  endings: [
    // ── Good ending ─────────────────────────────────────────────────────────
    {
      ending_id: "ending_city_holds",
      type: "success",
      title: "The City Holds",
      narration:
        "The Eastern Ward breathes again. Light returns to the streets district by district as the restored beacon lattice finds its equilibrium.\n\nEldric watches the resonance readouts settle and allows himself one slow exhale. \"Two beacons in a single night,\" he says. \"I had begun to think we'd have to choose.\"\n\nLyra is already studying the next diagram. The Northern Ward. The Docks. The city is not saved — but it is, for now, alive.\n\nSomewhere outside, a child laughs at the light.",
      world_state_changes: { stability: 30, beacon_power: 60 },
      relationship_changes: { eldric: 20, lyra: 15 },
    },

    // ── Bad ending A — underpowered ─────────────────────────────────────────
    {
      ending_id: "ending_bad_underpowered",
      type: "failure",
      title: "The City Dims",
      narration:
        "The Primary Beacon cannot sustain the city's demand on a resonance of (3,3). It draws from the outer districts until they have nothing left to give — and then it, too, goes dark.\n\nIn the silence that follows, Eldric does not speak for a long time.\n\n\"The error was in the coefficients,\" he finally says. \"One Crystal A and one Crystal B gives 1×(2,1) + 1×(1,2) = (3,3). We needed (5,4). The scalars were wrong — not the direction, the magnitude.\"\n\nThere is still time to correct it. The crystals are intact.",
      world_state_changes: { stability: -10, beacon_power: -20 },
      relationship_changes: { eldric: -5, lyra: 0 },
    },

    // ── Bad ending C — inverted resonance ───────────────────────────────────
    {
      ending_id: "ending_bad_inverted",
      type: "failure",
      title: "The Fracture",
      narration:
        "The crystal lattice cracks down its centre. The beacon housing can be repaired, but it will take days — days the outer districts do not have.\n\n\"You gave it (4,5) when it needed (5,4),\" Eldric says quietly, running a hand along the fracture. \"One Crystal A and two Crystal B: 1×(2,1) + 2×(1,2) = (2,1) + (2,4) = (4,5). The components were transposed.\"\n\n\"The lateral energy exceeded the target. The vertical fell short. The beacon tried to compensate and tore itself apart doing so.\"\n\nThe mistake can still be learned from.",
      world_state_changes: { stability: -15, beacon_power: -30 },
      relationship_changes: { eldric: -10, lyra: -5 },
    },

    // ── Bad ending P — Eastern Ward stays dark ──────────────────────────────
    {
      ending_id: "ending_bad_eastern_dark",
      type: "failure",
      title: "The Eastern Ward Goes Dark",
      narration:
        "The Eastern Ward beacon cannot hold on (3,3). The ward goes dark within minutes.\n\nLyra sits on the courtyard steps, the unused Crystal D heavy in her pocket.\n\n\"Crystal C alone can only produce resonances of the form c×(1,1) — always equal vertical and lateral. The target was (4,5). Those components are not equal. Crystal C alone can never reach it.\"\n\nShe looks up at the unlit windows above the street. \"We needed Crystal D in the combination. The span of Crystal C alone is just a line through the origin — and (4,5) doesn't lie on that line.\"",
      world_state_changes: { stability: -10, beacon_power: -15 },
      relationship_changes: { eldric: 0, lyra: -5 },
    },

    // ── Bad ending R — Eastern Ward overloads ───────────────────────────────
    {
      ending_id: "ending_bad_eastern_overload",
      type: "failure",
      title: "Overloaded",
      narration:
        "The beacon survives — barely. The overload didn't fracture the housing, but the district's power grid sparked and two buildings on the outer ring caught fire.\n\nBy the time the fires are out, the night is half gone.\n\n\"One Crystal C and two Crystal D,\" Lyra says, more to herself than anyone. \"(1,1) + 2×(2,3) = (1,1) + (4,6) = (5,7). We overshot the lateral axis by two and the vertical by one.\"\n\n\"The correct answer was c₁ = 2, c₂ = 1. I should have solved it systematically — set up the equations, not guessed.\"",
      world_state_changes: { stability: -5, beacon_power: -10 },
      relationship_changes: { eldric: 0, lyra: -8 },
    },
  ],

  continuity_summary: null,

  knowledge_mapping: [
    {
      concept_id: "concept_linear_combination",
      introduced_in_scene_id: "scene_03_learning",
      tested_in_puzzle_id: "puzzle_01",
    },
    {
      concept_id: "concept_vector_span",
      introduced_in_scene_id: "scene_09_span_learning",
      tested_in_puzzle_id: "puzzle_02",
    },
  ],
};

// ---------------------------------------------------------------------------
// Story 2 Blueprint — "The Outer Districts"
// Second story, campaign progression. Minimal — used for lobby/transition testing.
// ---------------------------------------------------------------------------

export const dummyStory2: StoryBlueprint = {
  story_id: "story_02",
  material_id: "material_01",
  title: "The Outer Districts",
  summary:
    "With the Eastern Ward restored, the team moves on the Northern Ward. The span of the remaining crystal types determines whether the district can be saved at all.",
  character_ids: ["eldric", "lyra"],
  chapters: [
    {
      chapter_id: "chapter_02_01",
      title: "The Northern Ward",
      scenes: [
        {
          scene_id: "s2_scene_01",
          type: "narrative",
          location: "The Outer Ward — Northern Gate",
          characters_present: ["lyra"],
          content: [
            {
              type: "narration",
              text: "The Northern Ward is older than the rest of the city. The beacon here was installed before the resonance system was standardised — it has quirks.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "focused",
              text: "Eldric says the Northern Ward needs resonance (3, 3). With Crystal C and Crystal D still on hand, that should be straightforward.",
            },
            {
              type: "narration",
              text: "She frowns at the diagram.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "curious",
              text: "Actually — wait. c₁(1,1) + c₂(2,3) = (3,3). The vertical equation gives c₁ + 2c₂ = 3, and the lateral gives c₁ + 3c₂ = 3. Subtracting: c₂ = 0. And then c₁ = 3.",
            },
            {
              type: "dialogue",
              character_id: "lyra",
              expression: "relieved",
              text: "Three Crystal C, no Crystal D. The Northern Ward is simpler than I thought.",
            },
          ],
          next_scene_id: "s2_scene_02_ending",
        },
        {
          scene_id: "s2_scene_02_ending",
          type: "ending",
          location: "The Northern Ward",
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
        "The Northern Ward beacon ignites with three Crystal C — a clean, symmetric resonance of (3,3).\n\nEldric arrives just as the light stabilises. He looks from the beacon to Lyra to you, and nods once.\n\n\"The Docks next,\" he says. \"And then the Archive. We're not done.\"\n\nBut for the first time tonight, he doesn't look like a man counting down.",
      world_state_changes: { stability: 15, beacon_power: 20 },
      relationship_changes: { lyra: 10, eldric: 5 },
    },
  ],
  continuity_summary: null,
  knowledge_mapping: [],
};

// ---------------------------------------------------------------------------
// Planner Fixtures — M8 Campaign Planner integration tests
//
// These materials are deliberately SEPARATE from `dummyMaterial` because the
// planner enforces global concept_id uniqueness. `dummyMaterial`'s concepts
// ("concept_linear_combination", "concept_vector_span") must not be reused by
// any other material in the same planner request.
//
// `dummyMaterial2` depends on `dummyMaterial` (cross-material prerequisite).
// `dummyMaterial3` is independent — it exists to prove that the planner
// preserves input order when no dependency edge exists.
// ---------------------------------------------------------------------------

/** Second planner material — depends on concept_vector_span from material_01. */
export const dummyMaterial2: MaterialBlueprint = {
  material_id: "material_02",
  title: "Introduction to Matrix Transformations",
  summary:
    "Covers how matrices act on vectors as linear transformations, and how composition corresponds to matrix multiplication.",
  learning_objectives: [
    "Interpret a matrix as a linear transformation of vectors.",
    "Compute the image of a vector under a matrix transformation.",
    "Compose two transformations by multiplying their matrices.",
  ],
  concepts: [
    {
      concept_id: "concept_matrix_transformation",
      name: "Matrix Transformation",
      definition:
        "A matrix A of size m×n defines a linear transformation T(x) = Ax mapping vectors in ℝⁿ to vectors in ℝᵐ.",
      principles: [
        "Matrix-vector multiplication applies the transformation encoded by the matrix.",
        "Linear transformations map the zero vector to the zero vector and preserve scalar sums.",
      ],
      methods: [
        "Multiply each row of the matrix by the input vector and sum the products.",
        "Test linearity by checking T(u + v) = T(u) + T(v) and T(cu) = cT(u).",
      ],
      prerequisites: ["concept_vector_span"],
      misconceptions: [
        "Assuming every vector always has a preimage under a given matrix.",
      ],
      source_evidence: [
        "For a matrix A and vector x, the map x → Ax is linear.",
      ],
    },
  ],
  scope_limitations: [
    "Determinants and eigenvalues are not covered.",
  ],
};

/** Third planner material — independent of material_01 and material_02. */
export const dummyMaterial3: MaterialBlueprint = {
  material_id: "material_03",
  title: "Introduction to Probability Distributions",
  summary:
    "Covers discrete probability distributions, their expected value, and the conditions a valid distribution must satisfy.",
  learning_objectives: [
    "Identify the requirements for a valid discrete probability distribution.",
    "Compute the expected value of a discrete random variable.",
  ],
  concepts: [
    {
      concept_id: "concept_probability_distribution",
      name: "Discrete Probability Distribution",
      definition:
        "A discrete probability distribution assigns a probability p(x) ≥ 0 to each possible value of a discrete random variable, with all probabilities summing to 1.",
      principles: [
        "Probabilities are non-negative and sum to one across all outcomes.",
        "Expected value is the probability-weighted sum of all outcomes.",
      ],
      methods: [
        "Verify that all probabilities sum to exactly 1 before using a distribution.",
        "Compute E[X] = Σ x·p(x) over all outcomes x.",
      ],
      prerequisites: [],
      misconceptions: [
        "Assuming a distribution is valid solely because all probabilities are individually less than 1.",
      ],
      source_evidence: [
        "A valid discrete distribution satisfies p(x) ≥ 0 and Σ p(x) = 1.",
      ],
    },
  ],
  scope_limitations: [
    "Continuous distributions and conditional probability are not covered.",
  ],
};

/** Standard planner options used by M8 integration tests. */
export const dummyPlannerOptions: CampaignPlannerOptions = {
  genre: "fantasy",
  campaignId: "campaign_planned_001",
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
  current_scene_id: "scene_01_arrival",
  hp: 5,
  status: "in_progress",
  puzzle_attempts: {},
  story_decisions: [],
};
