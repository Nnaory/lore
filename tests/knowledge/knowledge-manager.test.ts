/**
 * Tests — Knowledge Manager (pure logic)
 *
 * No React, no DOM. All tests verify the pure knowledge-manager functions.
 *
 * Tests:
 *   Initial state
 *   1.  createInitialKnowledge starts at not_introduced
 *   2.  getOrCreateKnowledge returns existing record unchanged
 *   3.  getOrCreateKnowledge creates a new record when missing
 *
 *   isHigherStatus
 *   4.  introduced > not_introduced
 *   5.  developing > introduced
 *   6.  demonstrated > developing
 *   7.  Same status is NOT higher
 *   8.  Lower status is NOT higher
 *
 *   recordLearningExposure
 *   9.  Advances status to introduced from not_introduced
 *   10. Does NOT advance past demonstrated
 *   11. Is idempotent for the same scene_id
 *   12. Adds evidence with source "learning_scene"
 *
 *   recordPuzzleSubmission — correct first attempt
 *   13. Advances status to demonstrated
 *   14. Evidence source is "puzzle_correct_first_try"
 *
 *   recordPuzzleSubmission — correct after feedback
 *   15. Advances status to at most developing
 *   16. Does NOT advance to demonstrated
 *   17. Evidence source is "puzzle_correct_after_feedback"
 *
 *   recordPuzzleSubmission — incorrect
 *   18. Advances status to at most developing
 *   19. Does NOT advance to demonstrated
 *   20. Evidence source is "puzzle_incorrect"
 *
 *   Status can only increase
 *   21. demonstrated cannot be reduced to developing by a later incorrect
 *   22. developing cannot be reduced to introduced
 *
 *   Double-counting prevention
 *   23. Same learning_scene recorded twice is idempotent
 *   24. Same puzzle_correct_first_try recorded twice is idempotent
 *
 *   mergeKnowledgeUpdates
 *   25. Updates are merged without overwriting unrelated keys
 *   26. Updated key replaces old value
 *
 *   meetsKnowledgeRequirements
 *   27. Empty required_knowledge always passes
 *   28. Returns false when concept is not_introduced
 *   29. Returns false when concept is introduced
 *   30. Returns false when concept is developing
 *   31. Returns true when concept is demonstrated
 *
 *   getConceptIdsFromScene
 *   32. Extracts concept_ids from learning_info blocks
 *   33. Returns empty array for narrative scene with no learning_info
 *   34. Returns empty array for unknown scene_id
 */

import { describe, it, expect } from "vitest";
import {
  createInitialKnowledge,
  getOrCreateKnowledge,
  isHigherStatus,
  recordLearningExposure,
  recordPuzzleSubmission,
  hasNoPriorPuzzleEvidence,
  mergeKnowledgeUpdates,
  meetsKnowledgeRequirements,
  getConceptIdsFromScene,
} from "@/lib/game/knowledge-manager";
import type { PlayerKnowledge } from "@/lib/types/game";
import { dummyStory } from "@/data/dummy-campaign";

// ── 1–3. Initial state ───────────────────────────────────────────────────────

describe("createInitialKnowledge", () => {
  it("should start at not_introduced", () => {
    const k = createInitialKnowledge("concept_01");
    expect(k.status).toBe("not_introduced");
  });

  it("should have an empty evidence array", () => {
    const k = createInitialKnowledge("concept_01");
    expect(k.evidence).toHaveLength(0);
  });
});

describe("getOrCreateKnowledge", () => {
  it("should return existing record unchanged", () => {
    const existing: PlayerKnowledge = {
      concept_id: "concept_01",
      status: "developing",
      evidence: [],
    };
    const map = { concept_01: existing };
    expect(getOrCreateKnowledge(map, "concept_01")).toBe(existing);
  });

  it("should create a new not_introduced record when missing", () => {
    const map: Record<string, PlayerKnowledge> = {};
    const result = getOrCreateKnowledge(map, "concept_01");
    expect(result.status).toBe("not_introduced");
    expect(result.concept_id).toBe("concept_01");
  });
});

// ── 4–8. isHigherStatus ──────────────────────────────────────────────────────

describe("isHigherStatus", () => {
  it("introduced > not_introduced", () => {
    expect(isHigherStatus("not_introduced", "introduced")).toBe(true);
  });

  it("developing > introduced", () => {
    expect(isHigherStatus("introduced", "developing")).toBe(true);
  });

  it("demonstrated > developing", () => {
    expect(isHigherStatus("developing", "demonstrated")).toBe(true);
  });

  it("same status is not higher", () => {
    expect(isHigherStatus("developing", "developing")).toBe(false);
  });

  it("lower status is not higher", () => {
    expect(isHigherStatus("demonstrated", "developing")).toBe(false);
  });
});

// ── 9–12. recordLearningExposure ─────────────────────────────────────────────

describe("recordLearningExposure", () => {
  it("should advance status to introduced from not_introduced", () => {
    const k = createInitialKnowledge("c1");
    const updated = recordLearningExposure(k, "scene_01");
    expect(updated.status).toBe("introduced");
  });

  it("should not advance past demonstrated", () => {
    const k: PlayerKnowledge = {
      concept_id: "c1",
      status: "demonstrated",
      evidence: [],
    };
    const updated = recordLearningExposure(k, "scene_01");
    expect(updated.status).toBe("demonstrated");
  });

  it("should be idempotent for the same scene_id", () => {
    const k = createInitialKnowledge("c1");
    const first = recordLearningExposure(k, "scene_01");
    const second = recordLearningExposure(first, "scene_01");
    // Same object reference (or at least same shape)
    expect(second.evidence).toHaveLength(1);
    expect(second.status).toBe(first.status);
  });

  it("should add evidence with source 'learning_scene'", () => {
    const k = createInitialKnowledge("c1");
    const updated = recordLearningExposure(k, "scene_01");
    expect(updated.evidence[0].source).toBe("learning_scene");
    expect(updated.evidence[0].reference_id).toBe("scene_01");
  });
});

// ── 13–20. recordPuzzleSubmission ────────────────────────────────────────────
// The new API derives isFirstAttempt from evidence — no external boolean.
// "first attempt" = no prior puzzle evidence for this puzzle in CampaignState.

describe("recordPuzzleSubmission — correct first attempt (no prior evidence)", () => {
  it("should advance status to demonstrated", () => {
    const k = createInitialKnowledge("c1"); // no prior puzzle evidence
    const updated = recordPuzzleSubmission(k, "puzzle_01", true);
    expect(updated.status).toBe("demonstrated");
  });

  it("should use evidence source 'puzzle_correct_first_try'", () => {
    const k = createInitialKnowledge("c1");
    const updated = recordPuzzleSubmission(k, "puzzle_01", true);
    expect(updated.evidence[0].source).toBe("puzzle_correct_first_try");
  });
});

describe("recordPuzzleSubmission — correct after feedback (prior incorrect evidence exists)", () => {
  function makeKnowledgeWithPriorIncorrect(): PlayerKnowledge {
    // Simulate: player answered incorrectly in a prior run
    return recordPuzzleSubmission(createInitialKnowledge("c1"), "puzzle_01", false);
  }

  it("should advance status to at most developing", () => {
    const k = makeKnowledgeWithPriorIncorrect();
    const updated = recordPuzzleSubmission(k, "puzzle_01", true);
    expect(updated.status).toBe("developing");
  });

  it("should NOT advance to demonstrated", () => {
    const k = makeKnowledgeWithPriorIncorrect();
    const updated = recordPuzzleSubmission(k, "puzzle_01", true);
    expect(updated.status).not.toBe("demonstrated");
  });

  it("should use evidence source 'puzzle_correct_after_feedback'", () => {
    const k = makeKnowledgeWithPriorIncorrect();
    const updated = recordPuzzleSubmission(k, "puzzle_01", true);
    expect(updated.evidence.find((e) => e.source === "puzzle_correct_after_feedback")).toBeDefined();
  });
});

describe("recordPuzzleSubmission — incorrect", () => {
  it("should advance status to at most developing", () => {
    const k = createInitialKnowledge("c1");
    const updated = recordPuzzleSubmission(k, "puzzle_01", false);
    expect(updated.status).toBe("developing");
  });

  it("should NOT advance to demonstrated", () => {
    const k = createInitialKnowledge("c1");
    const updated = recordPuzzleSubmission(k, "puzzle_01", false);
    expect(updated.status).not.toBe("demonstrated");
  });

  it("should use evidence source 'puzzle_incorrect'", () => {
    const k = createInitialKnowledge("c1");
    const updated = recordPuzzleSubmission(k, "puzzle_01", false);
    expect(updated.evidence[0].source).toBe("puzzle_incorrect");
  });
});

// ── 21–22. Status can only increase ─────────────────────────────────────────

describe("status cannot decrease", () => {
  it("demonstrated cannot be reduced by a later incorrect submission for a DIFFERENT puzzle", () => {
    // Player got puzzle_01 right on first try → demonstrated
    const afterFirst = recordPuzzleSubmission(createInitialKnowledge("c1"), "puzzle_01", true);
    expect(afterFirst.status).toBe("demonstrated");

    // A wrong answer on a different puzzle_02 should not reduce status
    const afterWrong = recordPuzzleSubmission(afterFirst, "puzzle_02", false);
    expect(afterWrong.status).toBe("demonstrated");
  });

  it("developing cannot be reduced to introduced by another learning exposure", () => {
    const developing: PlayerKnowledge = {
      concept_id: "c1",
      status: "developing",
      evidence: [],
    };
    const updated = recordLearningExposure(developing, "scene_02");
    expect(updated.status).toBe("developing");
  });
});

// ── 23–24. Double-counting prevention ───────────────────────────────────────

describe("double-counting prevention", () => {
  it("same learning_scene recorded twice does not double the evidence", () => {
    const k = createInitialKnowledge("c1");
    const once = recordLearningExposure(k, "scene_01");
    const twice = recordLearningExposure(once, "scene_01");
    expect(twice.evidence).toHaveLength(1);
  });

  it("puzzle_correct_first_try recorded twice does not double the evidence", () => {
    const k = createInitialKnowledge("c1");
    const once = recordPuzzleSubmission(k, "puzzle_01", true);
    const twice = recordPuzzleSubmission(once, "puzzle_01", true);
    const firstTryCount = twice.evidence.filter(
      (e) => e.source === "puzzle_correct_first_try"
    ).length;
    expect(firstTryCount).toBe(1);
  });
});

// ── 25–26. mergeKnowledgeUpdates ─────────────────────────────────────────────

describe("mergeKnowledgeUpdates", () => {
  it("should preserve unrelated concept keys", () => {
    const existing: Record<string, PlayerKnowledge> = {
      c1: { concept_id: "c1", status: "introduced", evidence: [] },
    };
    const update: Record<string, PlayerKnowledge> = {
      c2: { concept_id: "c2", status: "developing", evidence: [] },
    };
    const merged = mergeKnowledgeUpdates(existing, update);
    expect(merged.c1).toBeDefined();
    expect(merged.c2).toBeDefined();
  });

  it("should replace the value for an updated key", () => {
    const existing: Record<string, PlayerKnowledge> = {
      c1: { concept_id: "c1", status: "introduced", evidence: [] },
    };
    const update: Record<string, PlayerKnowledge> = {
      c1: { concept_id: "c1", status: "demonstrated", evidence: [] },
    };
    const merged = mergeKnowledgeUpdates(existing, update);
    expect(merged.c1.status).toBe("demonstrated");
  });
});

// ── 27–31. meetsKnowledgeRequirements ────────────────────────────────────────

describe("meetsKnowledgeRequirements", () => {
  it("empty required_knowledge always passes", () => {
    expect(meetsKnowledgeRequirements([], {})).toBe(true);
  });

  it("returns false when concept has not_introduced status", () => {
    const map = {
      c1: { concept_id: "c1", status: "not_introduced" as const, evidence: [] },
    };
    expect(meetsKnowledgeRequirements(["c1"], map)).toBe(false);
  });

  it("returns false when concept has introduced status", () => {
    const map = {
      c1: { concept_id: "c1", status: "introduced" as const, evidence: [] },
    };
    expect(meetsKnowledgeRequirements(["c1"], map)).toBe(false);
  });

  it("returns false when concept has developing status", () => {
    const map = {
      c1: { concept_id: "c1", status: "developing" as const, evidence: [] },
    };
    expect(meetsKnowledgeRequirements(["c1"], map)).toBe(false);
  });

  it("returns true when concept has demonstrated status", () => {
    const map = {
      c1: { concept_id: "c1", status: "demonstrated" as const, evidence: [] },
    };
    expect(meetsKnowledgeRequirements(["c1"], map)).toBe(true);
  });

  it("returns false if concept is missing from the map entirely", () => {
    expect(meetsKnowledgeRequirements(["c1"], {})).toBe(false);
  });

  it("requires ALL listed concepts to be demonstrated (AND logic)", () => {
    const map = {
      c1: { concept_id: "c1", status: "demonstrated" as const, evidence: [] },
      c2: { concept_id: "c2", status: "developing" as const, evidence: [] },
    };
    expect(meetsKnowledgeRequirements(["c1", "c2"], map)).toBe(false);
  });
});

// ── 32–34. getConceptIdsFromScene ────────────────────────────────────────────

describe("getConceptIdsFromScene", () => {
  it("should extract concept_ids from a learning_info block in a learning scene", () => {
    const ids = getConceptIdsFromScene(dummyStory, "scene_02_learning");
    expect(ids).toContain("concept_linear_combination");
  });

  it("should return empty array for a narrative scene with no learning_info", () => {
    const ids = getConceptIdsFromScene(dummyStory, "scene_01_intro");
    expect(ids).toHaveLength(0);
  });

  it("should return empty array for an unknown scene_id", () => {
    const ids = getConceptIdsFromScene(dummyStory, "scene_NONEXISTENT");
    expect(ids).toHaveLength(0);
  });
});

// ── hasNoPriorPuzzleEvidence ─────────────────────────────────────────────────

describe("hasNoPriorPuzzleEvidence", () => {
  it("returns true when no puzzle evidence exists", () => {
    const k = createInitialKnowledge("c1");
    expect(hasNoPriorPuzzleEvidence(k, "puzzle_01")).toBe(true);
  });

  it("returns false after an incorrect submission", () => {
    const k = recordPuzzleSubmission(createInitialKnowledge("c1"), "puzzle_01", false);
    expect(hasNoPriorPuzzleEvidence(k, "puzzle_01")).toBe(false);
  });

  it("returns false after a correct first-try submission", () => {
    const k = recordPuzzleSubmission(createInitialKnowledge("c1"), "puzzle_01", true);
    expect(hasNoPriorPuzzleEvidence(k, "puzzle_01")).toBe(false);
  });

  it("returns true for a DIFFERENT puzzle even when one puzzle has evidence", () => {
    const k = recordPuzzleSubmission(createInitialKnowledge("c1"), "puzzle_01", false);
    expect(hasNoPriorPuzzleEvidence(k, "puzzle_02")).toBe(true);
  });
});

// ── Cross-run retry behaviour ─────────────────────────────────────────────────
// These tests verify the critical contract: evidence persists across retries.

describe("cross-run retry — evidence-based isFirstAttempt", () => {
  it("incorrect in run 1 → correct in run 2 (after retry) = developing, not demonstrated", () => {
    // Run 1: player answers incorrectly
    const afterRun1 = recordPuzzleSubmission(createInitialKnowledge("c1"), "puzzle_01", false);
    expect(afterRun1.status).toBe("developing");

    // Player retries (StoryState reset, CampaignState persists — pass afterRun1)
    // Run 2: player answers correctly on "first attempt" of the new run,
    // but accumulated evidence shows a prior incorrect → still developing
    const afterRun2 = recordPuzzleSubmission(afterRun1, "puzzle_01", true);
    expect(afterRun2.status).toBe("developing");
    expect(afterRun2.status).not.toBe("demonstrated");
  });

  it("evidence from run 1 remains intact after simulated retry", () => {
    const afterRun1 = recordPuzzleSubmission(createInitialKnowledge("c1"), "puzzle_01", false);
    expect(afterRun1.evidence.some((e) => e.source === "puzzle_incorrect")).toBe(true);

    // Retry: pass the SAME accumulated knowledge (CampaignState is preserved)
    const afterRun2 = recordPuzzleSubmission(afterRun1, "puzzle_01", true);
    // Run 1 evidence must still be present
    expect(afterRun2.evidence.some((e) => e.source === "puzzle_incorrect")).toBe(true);
  });

  it("repeated retries do not inflate evidence", () => {
    let k = createInitialKnowledge("c1");
    // Simulate 3 incorrect attempts across multiple retries
    k = recordPuzzleSubmission(k, "puzzle_01", false);
    k = recordPuzzleSubmission(k, "puzzle_01", false);
    k = recordPuzzleSubmission(k, "puzzle_01", false);
    // Same (puzzleId, source) — deduplicated
    const incorrectCount = k.evidence.filter(
      (e) => e.reference_id === "puzzle_01" && e.source === "puzzle_incorrect"
    ).length;
    expect(incorrectCount).toBe(1); // idempotent
  });

  it("a genuinely independent first attempt (no prior evidence) can still produce demonstrated", () => {
    // Player has never attempted this puzzle at all
    const k = createInitialKnowledge("c1");
    expect(hasNoPriorPuzzleEvidence(k, "puzzle_NEW")).toBe(true);
    const afterCorrect = recordPuzzleSubmission(k, "puzzle_NEW", true);
    expect(afterCorrect.status).toBe("demonstrated");
  });

  it("knowledge status never decreases after retry", () => {
    // Player was at developing
    const base: PlayerKnowledge = {
      concept_id: "c1",
      status: "developing",
      evidence: [
        { source: "puzzle_incorrect", reference_id: "puzzle_01", timestamp: 1 },
      ],
    };

    // Even if somehow recordPuzzleSubmission is called again with the same incorrect
    const after = recordPuzzleSubmission(base, "puzzle_01", false);
    // Status cannot decrease below developing
    expect(after.status).toBe("developing");
  });
});
