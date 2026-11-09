/**
 * Material Blueprint Types
 *
 * Represents the structured output of Layer 1 (Material Intelligence).
 * Contains extracted learning concepts from raw user-provided material.
 */

/** A single learning concept extracted from source material. */
export type Concept = {
  concept_id: string;
  name: string;
  definition: string;
  principles: string[];
  /** Step-by-step methods or procedures related to this concept. */
  methods: string[];
  /** IDs of concepts that must be understood before this one. */
  prerequisites: string[];
  /** Common misunderstandings about this concept. */
  misconceptions: string[];
  /** Verbatim or paraphrased passages from the source material as evidence. */
  source_evidence: string[];
};

/**
 * The structured blueprint produced by Layer 1 (Material Intelligence).
 * Represents one unit of learning material.
 */
export type MaterialBlueprint = {
  material_id: string;
  title: string;
  summary: string;
  learning_objectives: string[];
  concepts: Concept[];
  /** Topics or claims that are outside the scope of the provided material. */
  scope_limitations: string[];
};
