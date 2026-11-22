"""Prompt builder for the Campaign Planner's creative step (Layer 2).

Why: copied from `buildPrompt` in `providers/gemini-campaign-planner-provider.ts` of the frontend
so the backend asks Gemini exactly what the Next.js route does. The structure (stories, IDs,
order) is already fixed by the engine; the prompt only asks for names, premise, rules and story
titles. Kept apart from the service so the wording can change without touching code.
"""

from __future__ import annotations

import json
from typing import Any

from app.ai.campaign_templates import GENRE_LABEL
from app.ai.contracts.requests import PlanCampaignRequest

SYSTEM_PROMPT = "You are a narrative designer for educational games. Respond with JSON only."


def build_campaign_prompt(skeleton: dict[str, Any], request: PlanCampaignRequest) -> str:
    """Build the user prompt from the engine's skeleton and the request."""
    materials = {m.material_id: m for m in request.materials}
    stories: list[dict[str, Any]] = []
    for entry in skeleton["story_sequence"]:
        material = materials.get(entry["material_id"])
        story: dict[str, Any] = {"story_id": entry["story_id"]}
        if material is not None:  # JSON.stringify omits undefined values
            story["material_title"] = material.title
            story["learning_objectives"] = material.learning_objectives
            story["concepts"] = [c.name for c in material.concepts]
        stories.append(story)
    options = request.options
    language = "Indonesian" if options.language == "id" else "English"
    genre = skeleton["genre"]
    cast = [f"{c['character_id']} ({c['name']}, {c['role']})" for c in skeleton["characters"]]
    lines = [
        "Design the world for an interactive learning story. "
        f"Genre: {GENRE_LABEL.get(genre, genre)}.",
        f"Write every field in {language}.",
        (
            f"Player's wishes (follow them unless unsafe): {options.custom_instructions}"
            if options.custom_instructions
            else ""
        ),
        "",
        "Stories (one per learning material, in this order):",
        json.dumps(stories, indent=2, ensure_ascii=False),
        "",
        f"Characters: exactly {len(cast)}, the fixed cast, in this order: {'; '.join(cast)}. "
        "Do not rename them or change their roles, and do not add other characters. "
        "Eldric is the guide who explains and gives hints; Mira is a peer who asks questions "
        "(sometimes wrong); Hazel turns theory into practice; Varr is the examiner who tests "
        "before the player passes; Nyx is the rival who plants misconceptions. Write each "
        "description to fit that role.",
        "",
        "Return JSON with this shape:",
        '{"title": string, "premise": string (2-3 sentences), "setting": string (one phrase), '
        '"tone": string (one or two words),',
        ' "main_conflict": string (one sentence), "world_rules": string[] (2-4 rules; '
        "the world's logic must match the material),",
        ' "characters": [{"description": string (one per cast member, same order)}],',
        ' "stories": [{"story_id": string (copy from above), "title": string, '
        '"purpose": string (one sentence), "main_conflict": string (one sentence, '
        "where the concepts are needed to solve it)}]}",
        "",
        "Rules: the learning content must stay academically correct; the world only frames it. "
        "Keep names original (no existing franchises). The five cast members are the only named "
        "characters: when any field mentions one, use the exact name given above, and do not "
        "invent other named people.",
    ]
    return "\n".join(line for line in lines if line != "")
