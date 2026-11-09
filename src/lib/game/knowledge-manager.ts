/**
 * Knowledge Manager
 *
 * Pure, deterministic logic for tracking player learning progress.
 * No React, no side effects — all functions return new state.
 *
 * ─── Knowledge Status Definitions (DOCS.md §11.2) ───────────────────────────
 *
 *   not_introduced  — concept has never been presented to the player.
 *   introduced      — player has seen a learning_info block that covers this concept.
 *   developing      — player has attempted the concept's puzzle but needed feedback
 *                     (answered incorrectly at least once before getting it right).
 *   demonstrated    — player answered the concept's puzzle correctly WITHOUT any
 *                     prior evidence of an incorrect or feedback-assisted attempt
 *                     for that puzzle, across ALL story runs (not just the current one).
 *
 * ─── The Feedback Rule ───────────────────────────────────────────────────────
 *
 *   DOCS.md explicitly states: "Sistem tidak boleh memberikan status `demonstrated`
 *   hanya karena pemain menebak jawaban benar setelah mendapatkan jawaban dan
 *   penjelasan."
 *
 *   "First attempt" means the player's first ever submission for this puzzle
 *   across ALL story runs — not just the current run. If the player answered
 *   incorrectly in a previous run, retried, then answered correctly in the
 *   next run, that correct answer is NOT an independent first attempt and
 *   must NOT produce `demonstrated`.
 *
 *   This is determined by inspecting the accumulated KnowledgeEvidence in
 *   CampaignState, not by a local per-run counter. A retry resets gameplay
 *   state but must NOT erase knowledge assessment history.
 *
 *   Status rules:
 *     - Correct + no prior puzzle evidence for this puzzleId → demonstrated
 *     - Correct + prior incorrect/feedback evidence exists   → developing
 *     - Incorrect (any run, any attempt)                    → developing
 *     - Viewed learning content                             → introduced
 *
 *   Status can only increase, never decrease.
 *
 * ─── required_knowledge unlocking rule ──────────────────────────────────────
 *
 *   `demonstrated` status is the threshold for `required_knowledge` entries.
 *   AND logic: every listed concept must be demonstrated.
 *
 * ─── Double-counting prevention ──────────────────────────────────────────────
 *
 *   Each evidence event is identified by (reference_id, source). Duplicate
 *   (reference_id, source) pairs are silently ignored. This prevents the same
 *   learning scene or puzzle submission from inflating evidence on retry.
 *
 *   For puzzle submissions, all submission types for the same puzzle share the
 *   puzzle_id as reference_id. The source disambiguates outcome type.
 *   Since `puzzle_correct_first_try` is only ever set when there is truly no
 *   prior puzzle evidence, it cannot appear alongside `puzzle_incorrect` for
 *   the same puzzle.
 */

import type { KnowledgeStatus, PlayerKnowledge, KnowledgeEvidence } from "@/lib/types/game";
import type { StoryBlueprint } from "@/lib/types/story";

// ---------------------------------------------------------------------------
// Status ordering (for "can only increase" rule)
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<KnowledgeStatus, number> = {
  not_introduced: 0,
  introduced: 1,
  developing: 2,
  demonstrated: 3,
};

/**
 * Returns true if `next` is a higher status than `current`.
 * Knowledge status can only increase — never decrease.
 */
export function isHigherStatus(
  current: KnowledgeStatus,
  next: KnowledgeStatus
): boolean {
  return STATUS_ORDER[next] > STATUS_ORDER[current];
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/**
 * Build the initial PlayerKnowledge for a concept that has not yet been
 * encountered by the player.
 */
export function createInitialKnowledge(conceptId: string): PlayerKnowledge {
  return {
    concept_id: conceptId,
    status: "not_introduced",
    evidence: [],
  };
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if this (reference_id, source) pair is already recorded.
 * Used to prevent double-counting the same event after retry.
 */
function hasEvidence(
  knowledge: PlayerKnowledge,
  referenceId: string,
  source: string
): boolean {
  return knowledge.evidence.some(
    (e) => e.reference_id === referenceId && e.source === source
  );
}

/**
 * Append evidence to a PlayerKnowledge record.
 * Returns the same object if the evidence already exists (idempotent).
 */
function appendEvidence(
  knowledge: PlayerKnowledge,
  evidence: KnowledgeEvidence
): PlayerKnowledge {
  if (hasEvidence(knowledge, evidence.reference_id, evidence.source)) {
    return knowledge;
  }
  return {
    ...knowledge,
    evidence: [...knowledge.evidence, evidence],
  };
}

/**
 * Update the status of a knowledge record, respecting the "can only increase" rule.
 * If `newStatus` is not higher than current, the record is returned unchanged.
 */
function promoteStatus(
  knowledge: PlayerKnowledge,
  newStatus: KnowledgeStatus
): PlayerKnowledge {
  if (!isHigherStatus(knowledge.status, newStatus)) {
    return knowledge;
  }
  return { ...knowledge, status: newStatus };
}

// ---------------------------------------------------------------------------
// Learning content event
// ---------------------------------------------------------------------------

/**
 * Record that the player encountered a learning_info block for a concept.
 *
 * Effect: advances status to `introduced` if not already higher.
 * Evidence source: "learning_scene".
 *
 * @param knowledge  Current PlayerKnowledge for this concept.
 * @param sceneId    The scene_id containing the learning_info.
 * @param timestamp  Event timestamp (defaults to Date.now()).
 */
export function recordLearningExposure(
  knowledge: PlayerKnowledge,
  sceneId: string,
  timestamp = Date.now()
): PlayerKnowledge {
  const source = "learning_scene";
  // Idempotent: if this scene was already recorded, no change
  if (hasEvidence(knowledge, sceneId, source)) {
    return knowledge;
  }

  const withEvidence = appendEvidence(knowledge, {
    source,
    reference_id: sceneId,
    timestamp,
  });

  return promoteStatus(withEvidence, "introduced");
}

// ---------------------------------------------------------------------------
// Puzzle submission events
// ---------------------------------------------------------------------------

/**
 * Returns true if the player's accumulated evidence for this concept shows
 * that no puzzle submission of any kind has been recorded for `puzzleId`.
 *
 * This is the correct definition of "first attempt" — it checks the full
 * history in CampaignState, not a per-run local counter. A story retry
 * does not erase this history.
 */
export function hasNoPriorPuzzleEvidence(
  knowledge: PlayerKnowledge,
  puzzleId: string
): boolean {
  const puzzleSources = [
    "puzzle_correct_first_try",
    "puzzle_correct_after_feedback",
    "puzzle_incorrect",
  ];
  return !knowledge.evidence.some(
    (e) => e.reference_id === puzzleId && puzzleSources.includes(e.source)
  );
}

/**
 * Record the outcome of a puzzle submission for a concept.
 *
 * The `isFirstAttempt` flag is derived internally from the accumulated
 * evidence — the caller does NOT need to track it. This ensures correctness
 * across story retries, since CampaignState evidence persists while
 * per-run counters reset.
 *
 * Rules:
 *   - No prior puzzle evidence for this puzzleId AND `correct` → demonstrated.
 *   - Prior incorrect/feedback evidence exists AND `correct`   → developing.
 *   - `incorrect` (any run, any attempt)                      → developing.
 *
 * Status can only increase; "developing" cannot overwrite "demonstrated".
 *
 * @param knowledge  Current PlayerKnowledge for this concept (from CampaignState).
 * @param puzzleId   The puzzle_id being answered.
 * @param correct    Whether the submitted answer was correct.
 * @param timestamp  Event timestamp (defaults to Date.now()).
 */
export function recordPuzzleSubmission(
  knowledge: PlayerKnowledge,
  puzzleId: string,
  correct: boolean,
  timestamp = Date.now()
): PlayerKnowledge {
  // Determine isFirstAttempt from accumulated evidence, not a local counter.
  const isFirstAttempt = hasNoPriorPuzzleEvidence(knowledge, puzzleId);

  let source: string;
  let targetStatus: KnowledgeStatus;

  if (correct && isFirstAttempt) {
    source = "puzzle_correct_first_try";
    targetStatus = "demonstrated";
  } else if (correct && !isFirstAttempt) {
    source = "puzzle_correct_after_feedback";
    targetStatus = "developing";
  } else {
    source = "puzzle_incorrect";
    targetStatus = "developing";
  }

  const withEvidence = appendEvidence(knowledge, {
    source,
    reference_id: puzzleId,
    timestamp,
  });

  return promoteStatus(withEvidence, targetStatus);
}

// ---------------------------------------------------------------------------
// Batch update helpers
// ---------------------------------------------------------------------------

/**
 * Merge knowledge event updates into the campaign's full knowledge map.
 *
 * Returns a new map with the updated concept(s). Concepts not mentioned in
 * `updates` are preserved unchanged.
 *
 * @param existingKnowledge  The current player_knowledge map from CampaignState.
 * @param updates            Partial map of concept_id → updated PlayerKnowledge.
 */
export function mergeKnowledgeUpdates(
  existingKnowledge: Record<string, PlayerKnowledge>,
  updates: Record<string, PlayerKnowledge>
): Record<string, PlayerKnowledge> {
  return { ...existingKnowledge, ...updates };
}

/**
 * Get or create a PlayerKnowledge record for a concept.
 * Centralises the "default to not_introduced" behaviour.
 */
export function getOrCreateKnowledge(
  knowledgeMap: Record<string, PlayerKnowledge>,
  conceptId: string
): PlayerKnowledge {
  return knowledgeMap[conceptId] ?? createInitialKnowledge(conceptId);
}

// ---------------------------------------------------------------------------
// required_knowledge prerequisite check
// ---------------------------------------------------------------------------

/**
 * The minimum knowledge status required for a concept to count as a satisfied
 * prerequisite in `required_knowledge`.
 *
 * Rule: the player must have `demonstrated` the concept — i.e., answered the
 * relevant puzzle correctly on the first attempt without prior feedback.
 * See module-level comment for the rationale.
 */
export const REQUIRED_KNOWLEDGE_THRESHOLD: KnowledgeStatus = "demonstrated";

/**
 * Returns true if all `required_knowledge` concept IDs in the story entry
 * meet the REQUIRED_KNOWLEDGE_THRESHOLD in the player's knowledge map.
 *
 * An empty `required_knowledge` array always returns true.
 */
export function meetsKnowledgeRequirements(
  requiredConceptIds: string[],
  knowledgeMap: Record<string, PlayerKnowledge>
): boolean {
  return requiredConceptIds.every((conceptId) => {
    const knowledge = knowledgeMap[conceptId];
    if (!knowledge) return false;
    return STATUS_ORDER[knowledge.status] >= STATUS_ORDER[REQUIRED_KNOWLEDGE_THRESHOLD];
  });
}

// ---------------------------------------------------------------------------
// Learning scene → concept_ids extraction helper
// ---------------------------------------------------------------------------

/**
 * Collect all concept IDs that are introduced in a given scene via
 * `learning_info` content blocks.
 *
 * Returns an empty array if the scene has no learning_info blocks.
 */
export function getConceptIdsFromScene(
  story: StoryBlueprint,
  sceneId: string
): string[] {
  for (const chapter of story.chapters) {
    const scene = chapter.scenes.find((s) => s.scene_id === sceneId);
    if (!scene) continue;
    if (
      scene.type !== "learning" &&
      scene.type !== "narrative" &&
      scene.type !== "interaction" &&
      scene.type !== "consequence"
    ) {
      continue;
    }
    const conceptIds: string[] = [];
    for (const block of scene.content) {
      if (block.type === "learning_info") {
        conceptIds.push(...block.concept_ids);
      }
    }
    return conceptIds;
  }
  return [];
}
