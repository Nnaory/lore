"""Campaign Planner (Layer 2): Gemini provider and service.

Why: port of `frontend/src/lib/ai/campaign-planner.ts` and
`providers/gemini-campaign-planner-provider.ts`. Structure comes from the engine
(`build_campaign_blueprint`: story order, IDs, required_knowledge, outcomes). Gemini only
rewrites the creative fields: campaign title, premise, setting, tone, world rules, character
descriptions (names and roles are the fixed Kit cast), and each story's title, purpose and
conflict. If Gemini fails or answers
with something unusable, the engine's template text is kept and a `CREATIVE_FALLBACK` warning is
added, so planning never fails because of the creative step (model reported as
"deterministic-template"). `plan_campaign` returns `AiOk | AiError` for the shared pipeline.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import AfterValidator, Field, Strict, StringConstraints, ValidationError

from app.ai.campaign_output_parser import (
    CandidateCampaign,
    parse_campaign_provider_result,
)
from app.ai.campaign_planner_engine import EngineError, build_campaign_blueprint
from app.ai.contracts.campaign import CampaignBlueprint
from app.ai.contracts.requests import PlanCampaignRequest, utf16_length
from app.ai.envelope import AiError, AiOk, AiResult
from app.ai.gemini_client import GeminiOk, GeminiRequest
from app.ai.prompts.campaign_planner import SYSTEM_PROMPT, build_campaign_prompt
from app.ai.runtime import AiContext
from app.ai.validation import validation_error
from app.ai.zod_compat import ZodModel

PROVIDER_ID = "google"
TEMPLATE_MODEL = "deterministic-template"
_MAX_OUTPUT_TOKENS = 2_000
_TEMPERATURE = 0.9


def _bounded(max_length: int) -> Any:
    """Zod `z.string().trim().min(1).max(n)`: trimmed, 1..n UTF-16 code units."""

    def check(value: str) -> str:
        if not 1 <= utf16_length(value) <= max_length:
            raise ValueError(f"text must be 1 to {max_length} characters")
        return value

    return Annotated[str, Strict(), StringConstraints(strip_whitespace=True), AfterValidator(check)]


Text600 = _bounded(600)
Text60 = _bounded(60)


class CreativeCharacter(ZodModel):
    # name and role are accepted but ignored: the Kit cast's are locked in merge_creative_fields
    name: Text60 | None = None
    role: Text60 | None = None
    description: Text600


class CreativeStory(ZodModel):
    story_id: Annotated[str, Strict()]
    title: Text600 | None = None
    purpose: Text600 | None = None
    main_conflict: Text600 | None = None


class Creative(ZodModel):
    """The creative fields Gemini may write. Every field is optional."""

    title: Text600 | None = None
    premise: Text600 | None = None
    setting: Text600 | None = None
    tone: Text60 | None = None
    main_conflict: Text600 | None = None
    world_rules: Annotated[list[Text600], Field(max_length=6)] | None = None
    characters: list[CreativeCharacter] | None = None
    stories: list[CreativeStory] | None = None


def merge_creative_fields(skeleton: dict[str, Any], creative: Creative) -> dict[str, Any]:
    """Overlay the valid creative fields on the engine's blueprint; structure is untouched."""
    story_by_id = {s.story_id: s for s in creative.stories or []}
    written_characters = creative.characters or []

    def pick(value: str | None, fallback: str) -> str:
        return fallback if value is None else value

    characters: list[dict[str, Any]] = []
    for i, character in enumerate(skeleton["characters"]):
        written = written_characters[i] if i < len(written_characters) else None
        characters.append(
            character
            if written is None
            else {
                **character,
                # name and role are the Kit cast's and stay locked; only the text is creative
                "description": written.description,
            }
        )

    stories: list[dict[str, Any]] = []
    for entry in skeleton["story_sequence"]:
        written_story = story_by_id.get(entry["story_id"])
        stories.append(
            entry
            if written_story is None
            else {
                **entry,
                "title": pick(written_story.title, entry["title"]),
                "purpose": pick(written_story.purpose, entry["purpose"]),
                "main_conflict": pick(written_story.main_conflict, entry["main_conflict"]),
            }
        )

    return {
        **skeleton,
        "title": pick(creative.title, skeleton["title"]),
        "premise": pick(creative.premise, skeleton["premise"]),
        "setting": pick(creative.setting, skeleton["setting"]),
        "tone": pick(creative.tone, skeleton["tone"]),
        "main_conflict": pick(creative.main_conflict, skeleton["main_conflict"]),
        "world_rules": creative.world_rules if creative.world_rules else skeleton["world_rules"],
        "characters": characters,
        "story_sequence": stories,
    }


def _is_valid_blueprint(raw: dict[str, Any]) -> bool:
    try:
        CampaignBlueprint.model_validate(raw)
    except ValidationError:
        return False
    return True


async def generate_candidate(
    request: PlanCampaignRequest, ctx: AiContext
) -> CandidateCampaign | AiError:
    """Engine skeleton plus Gemini's creative text. Only unusable input is an error."""
    started = ctx.runtime.monotonic()
    engine = build_campaign_blueprint(request.materials, request.options)
    if isinstance(engine, EngineError):
        return AiError(engine.code, engine.message, engine.detail)

    warnings = list(engine.warnings)
    blueprint = engine.blueprint
    model = TEMPLATE_MODEL

    result = await ctx.generate_json(
        GeminiRequest(
            system=SYSTEM_PROMPT,
            prompt=build_campaign_prompt(engine.blueprint, request),
            max_output_tokens=_MAX_OUTPUT_TOKENS,
            temperature=_TEMPERATURE,
        )
    )

    creative: Creative | None = None
    if isinstance(result, GeminiOk):
        try:
            creative = Creative.model_validate(result.json)
        except ValidationError:
            creative = None
    if isinstance(result, GeminiOk) and creative is not None:
        merged = merge_creative_fields(engine.blueprint, creative)
        if _is_valid_blueprint(merged):
            blueprint = merged
            model = result.model

    if model == TEMPLATE_MODEL:
        reason = (
            "The AI world design was unusable; template campaign text was used."
            if isinstance(result, GeminiOk)
            else f"The AI provider was unavailable ({result.code}); "
            "template campaign text was used."
        )
        warnings.append(validation_error("CREATIVE_FALLBACK", reason, "campaign"))

    latency_ms = round((ctx.runtime.monotonic() - started) * 1000)
    return CandidateCampaign(blueprint, PROVIDER_ID, model, latency_ms, warnings)


async def plan_campaign(request: PlanCampaignRequest, ctx: AiContext) -> AiResult:
    """Plan a campaign: engine + Gemini -> parser/validator -> envelope data."""
    candidate = await generate_candidate(request, ctx)
    parsed = parse_campaign_provider_result(candidate, request.materials)
    if isinstance(parsed, AiError):
        return parsed
    return AiOk({"blueprint": parsed.blueprint.dump(), "meta": parsed.meta})
