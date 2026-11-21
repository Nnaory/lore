/**
 * Prompt Builder — Material Analysis (Layer 1)
 *
 * Constructs the prompt for Material Intelligence.
 * Used by the Gemini provider.
 * Kept separate to enable prompt iteration without touching provider code.
 */

import type { AnalyzeMaterialRequest } from "@/lib/ai/types";

/** System prompt defining the Material Intelligence task. */
export const MATERIAL_ANALYSIS_SYSTEM_PROMPT = `You are an expert learning engineer. Your task is to analyze raw learning material and extract a structured blueprint of its educational content.

Output MUST be valid JSON matching the MaterialBlueprint schema exactly. No extra commentary, no markdown formatting.

Schema:
{
  "material_id": "string (unique, e.g. material_01)",
  "title": "string (concise title for the material)",
  "summary": "string (2-3 sentences summarizing the material)",
  "learning_objectives": ["string", ...] (at least 1, measurable objectives),
  "concepts": [{
    "concept_id": "string (unique, e.g. concept_01)",
    "name": "string (concept name)",
    "definition": "string (clear, precise definition)",
    "principles": ["string", ...] (underlying principles),
    "methods": ["string", ...] (step-by-step procedures),
    "prerequisites": ["concept_id", ...] (other concept_ids from this blueprint),
    "misconceptions": ["string", ...] (common student misunderstandings),
    "source_evidence": ["string", ...] (verbatim or paraphrased passages from source),
    "notation": ["string", ...] (symbols, formulas and key terms exactly as the material writes them, each with its meaning, e.g. "‖v‖ = panjang vektor v"; [] if none),
    "examples": ["string", ...] (worked examples or exercises from the material, summarised with their numbers and result; [] if none)
  }, ...] ([] when the material has nothing teachable, see the rules),
  "scope_limitations": ["string", ...] (topics NOT covered by the material)
}

Rules:
- Extract ONLY what is in the source material. Do not hallucinate.
- Every concept must have source_evidence quoting the material.
- notation and examples must come from the material itself — never invent them.
- prerequisites must reference concept_ids from THIS blueprint.
- learning_objectives must be measurable (Bloom's taxonomy: understand, apply, analyze).
- If material covers multiple topics, create separate concepts for each.
- If the material is empty, only a topic name or request (for example "learn vectors"), or otherwise has no teachable content of its own, return "concepts": [] and "learning_objectives": []. Never invent concepts from your own knowledge.
- scope_limitations must be honest about what the material does NOT cover.`;

/** Builds the user prompt with the material and optional context. */
export function buildMaterialAnalysisPrompt(request: AnalyzeMaterialRequest): string {
  const { material, context, genre } = request;

  let prompt = `Analyze the following learning material and produce a MaterialBlueprint.\n\n`;
  prompt += `--- MATERIAL START ---\n${material.trim()}\n--- MATERIAL END ---\n`;

  if (context && Object.keys(context).length > 0) {
    prompt += `\nContext: ${JSON.stringify(context, null, 2)}\n`;
  }

  if (genre) {
    prompt += `\nGenre hint: ${genre} (use only for framing examples, not academic content)\n`;
  }

  prompt += `\nReturn ONLY the JSON MaterialBlueprint.`;

  return prompt;
}
