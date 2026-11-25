"""Campaign Planner engine: deterministic structure of a campaign (Layer 2).

Why: port of `frontend/src/lib/ai/campaign-planner-engine.ts`. The model cannot be trusted with
IDs and ordering, so the app owns them: `build_campaign_blueprint` turns materials and options
into a candidate campaign where one material is exactly one story, stories are ordered by
cross-material concept prerequisites (stable topological sort, ties by input order), and IDs are
`story_01`, `outcome_story_01_success`, and the fixed Kit cast ids (`eldric`, `mira`, ...).
Gemini only rewrites the creative text on top (see `app.ai.campaign_planner`). Same input gives
the same output; inputs are never changed.

The blueprint is returned as a plain dict, not a validated model: like the TypeScript engine it
may still hold a value the schema rejects (for example `tone: ""` from the options), and the
output parser is the one place that decides. Expected failures come back as `EngineError`.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from typing import Any

from app.ai.campaign_templates import BASE_EXPRESSIONS, GENRE_TEMPLATES
from app.ai.contracts.material import MaterialBlueprint
from app.ai.contracts.requests import CampaignPlannerOptions
from app.ai.validation import validation_error


@dataclass(frozen=True)
class EngineSuccess:
    """A candidate blueprint plus non-blocking planning warnings."""

    blueprint: dict[str, Any]
    warnings: list[dict[str, str]] = field(default_factory=list)
    ok: bool = True


@dataclass(frozen=True)
class EngineError:
    """Unusable planning input; `code` is one of the planner's semantic codes."""

    code: str
    message: str
    detail: Any = None
    ok: bool = False


EngineResult = EngineSuccess | EngineError


def _utf16_key(text: str) -> bytes:
    """Sort key that orders strings by UTF-16 code unit, like JavaScript's default sort."""
    return text.encode("utf-16-be", errors="surrogatepass")


def js_replace_first(text: str, token: str, replacement: str) -> str:
    """`text.replace(token, replacement)` as JavaScript does it for a string pattern.

    JavaScript reads `$$`, `$&`, `` $` `` and `$'` in the replacement as special. A material
    title such as "Cost in $$" must give the same result here as in the Next.js route.
    """
    index = text.find(token)
    if index < 0:
        return text
    before, after = text[:index], text[index + len(token) :]
    out: list[str] = []
    i = 0
    while i < len(replacement):
        ch = replacement[i]
        nxt = replacement[i + 1] if i + 1 < len(replacement) else ""
        if ch == "$" and nxt == "$":
            out.append("$")
            i += 2
        elif ch == "$" and nxt == "&":
            out.append(token)
            i += 2
        elif ch == "$" and nxt == "`":
            out.append(before)
            i += 2
        elif ch == "$" and nxt == "'":
            out.append(after)
            i += 2
        else:
            out.append(ch)
            i += 1
    return before + "".join(out) + after


def _derive_material_edges(
    materials: list[MaterialBlueprint], provenance: dict[str, str]
) -> dict[str, set[str]]:
    """material_id -> materials that must come before it (cross-material prerequisites only)."""
    edges: dict[str, set[str]] = {m.material_id: set() for m in materials}
    for material in materials:
        deps = edges[material.material_id]
        for concept in material.concepts:
            for prerequisite in concept.prerequisites:
                owner = provenance.get(prerequisite)
                if owner is not None and owner != material.material_id:
                    deps.add(owner)
    return edges


def _topo_sort_materials(
    materials: list[MaterialBlueprint], edges: dict[str, set[str]]
) -> list[MaterialBlueprint] | None:
    """Kahn's algorithm; among ready materials the earliest in input order goes first.

    Returns None when the dependencies contain a cycle.
    """
    by_id = {m.material_id: m for m in materials}
    input_order = {m.material_id: i for i, m in enumerate(materials)}
    dependents: dict[str, list[str]] = {}
    remaining: dict[str, int] = {}
    for material in materials:
        deps = edges[material.material_id]
        remaining[material.material_id] = len(deps)
        for dep in deps:
            dependents.setdefault(dep, []).append(material.material_id)

    # A heap on input position instead of re-sorting a list: same order, but O(n log n), so a
    # request with thousands of independent materials cannot stall the event loop.
    available: list[tuple[int, str]] = []
    for material_id, count in remaining.items():
        if count == 0:
            heapq.heappush(available, (input_order[material_id], material_id))

    ordered: list[MaterialBlueprint] = []
    while available:
        _, next_id = heapq.heappop(available)
        ordered.append(by_id[next_id])
        for dependent_id in dependents.get(next_id, []):
            remaining[dependent_id] -= 1
            if remaining[dependent_id] == 0:
                heapq.heappush(available, (input_order[dependent_id], dependent_id))

    return ordered if len(ordered) == len(materials) else None


def _pad(n: int) -> str:
    return f"{n:02d}"


def build_campaign_blueprint(
    materials: list[MaterialBlueprint], options: CampaignPlannerOptions
) -> EngineResult:
    """Build a candidate CampaignBlueprint from materials and options."""
    # 1. Duplicate material_id
    seen_material_ids: set[str] = set()
    for material in materials:
        if material.material_id in seen_material_ids:
            return EngineError(
                "DUPLICATE_MATERIAL_ID",
                f'Duplicate material_id "{material.material_id}" in planner request.',
            )
        seen_material_ids.add(material.material_id)

    # 2. Global concept_id uniqueness
    provenance: dict[str, str] = {}
    for material in materials:
        for concept in material.concepts:
            owner = provenance.get(concept.concept_id)
            if owner is not None:
                return EngineError(
                    "DUPLICATE_CONCEPT_ID",
                    f'concept_id "{concept.concept_id}" is defined by both "{owner}" and '
                    f'"{material.material_id}". Concept IDs must be globally unique across '
                    "all materials.",
                )
            provenance[concept.concept_id] = material.material_id

    # 3. Unresolved prerequisite references
    for material in materials:
        for concept in material.concepts:
            for prerequisite in concept.prerequisites:
                if prerequisite not in provenance:
                    return EngineError(
                        "INVALID_PREREQUISITE_REF",
                        f'Concept "{concept.concept_id}" in material "{material.material_id}" '
                        f'references unknown prerequisite "{prerequisite}".',
                    )

    # 4-5. Cross-material edges and a stable topological order
    edges = _derive_material_edges(materials, provenance)
    ordered = _topo_sort_materials(materials, edges)
    if ordered is None:
        summary = "; ".join(
            f"{m.material_id}: []"
            if not edges[m.material_id]
            else f"{m.material_id}: [{', '.join(sorted(edges[m.material_id], key=_utf16_key))}]"
            for m in materials
        )
        return EngineError(
            "PREREQUISITE_CYCLE",
            "Cross-material prerequisite dependencies form a cycle and cannot be ordered.",
            {"edges": summary},
        )

    # 6. Campaign-level framing
    genre = options.genre
    template = GENRE_TEMPLATES[genre]
    campaign_id = options.campaign_id if options.campaign_id is not None else "campaign_001"
    tone = options.tone if options.tone is not None else template.tone
    setting = options.setting if options.setting is not None else template.setting

    domain_titles = [m.title for m in ordered]
    premise = template.premise
    if domain_titles:
        journey = " \u2192 ".join(domain_titles)
        premise += f" The journey spans: {journey}."
    last_title = domain_titles[-1] if domain_titles else "the material"
    main_conflict = (
        f"The campaign's central problem can only be resolved by mastering {last_title}."
    )

    # 7. Story sequence
    warnings: list[dict[str, str]] = []
    story_sequence: list[dict[str, Any]] = []
    for index, material in enumerate(ordered):
        story_number = index + 1
        earlier = {m.material_id for m in ordered[:index]}
        required_knowledge: list[str] = []
        for concept in material.concepts:
            for prerequisite in concept.prerequisites:
                owner = provenance[prerequisite]
                if owner in earlier and prerequisite not in required_knowledge:
                    required_knowledge.append(prerequisite)

        # Unlocking needs `demonstrated`, earned by a puzzle answered right on the first try.
        # Layer 3 decides the puzzles, so every derived prerequisite is only "pending" here.
        for prerequisite in required_knowledge:
            warnings.append(
                validation_error(
                    "PREREQUISITE_TESTABILITY_PENDING",
                    f'Story {_pad(story_number)} requires concept "{prerequisite}". Layer 3 '
                    "must provide a puzzle testing this concept in an earlier story, or the "
                    "story cannot be unlocked.",
                    f"story_sequence[story_{_pad(story_number)}].required_knowledge",
                )
            )

        # `??` in the TypeScript: only a missing objective falls back, an empty string stays.
        objectives = material.learning_objectives
        first_objective = objectives[0] if objectives else material.summary
        story_sequence.append(
            {
                "story_id": f"story_{_pad(story_number)}",
                "material_id": material.material_id,
                "title": material.title,
                "purpose": f"Introduce and apply: {first_objective}",
                "main_conflict": js_replace_first(
                    template.main_conflict_template, "{topic}", material.title
                ),
                "required_knowledge": required_knowledge,
                "outcomes": [
                    {
                        "outcome_id": f"outcome_story_{_pad(story_number)}_success",
                        "description": "The story's central problem is fully resolved.",
                        "world_state_changes": {"stability": 10 + (story_number - 1) * 5},
                    }
                ],
            }
        )

    # 8. Assemble
    blueprint: dict[str, Any] = {
        "campaign_id": campaign_id,
        "title": f"{template.characters[0].name}'s Campaign: "
        f"{domain_titles[0] if domain_titles else 'Learning Journey'}",
        "genre": genre,
        "tone": tone,
        "premise": premise,
        "main_conflict": main_conflict,
        "setting": setting,
        "characters": [
            {
                "character_id": char.character_id,
                "name": char.name,
                "role": char.role,
                "description": f"{char.description} (campaign {campaign_id})",
                "expressions": dict(BASE_EXPRESSIONS),
            }
            for char in template.characters
        ],
        "world_rules": list(template.world_rules),
        "story_sequence": story_sequence,
    }
    return EngineSuccess(blueprint, warnings)
