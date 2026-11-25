"""Router for /api/v1/ai/*: the AI layers behind one public prefix.

Why: replaces the Next.js `/api/ai/*` route handlers one layer at a time with identical
contracts. Each route is a one-liner over `handle_ai_request`; add the next layer by defining an
`AiEndpoint` and a route here. The cookie middleware in `app.owner` covers this prefix, so every
response carries the `lore_device` cookie used for the per-owner limit.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.ai.campaign_planner import plan_campaign
from app.ai.contracts.requests import (
    AnalyzeMaterialRequest,
    GenerateStoryRequest,
    PlanCampaignRequest,
)
from app.ai.limits import (
    ANALYZE_MATERIAL_BODY_BYTES,
    GENERATE_STORY_BODY_BYTES,
    PLAN_CAMPAIGN_BODY_BYTES,
)
from app.ai.material_intelligence import analyze_material
from app.ai.pipeline import AiEndpoint, handle_ai_request
from app.ai.story_generator import generate_story

router = APIRouter(prefix="/api/v1/ai", tags=["ai"])

ANALYZE_MATERIAL = AiEndpoint(
    name="analyze-material",
    request_model=AnalyzeMaterialRequest,
    body_limit=ANALYZE_MATERIAL_BODY_BYTES,
    run=analyze_material,
)

PLAN_CAMPAIGN = AiEndpoint(
    name="plan-campaign",
    request_model=PlanCampaignRequest,
    body_limit=PLAN_CAMPAIGN_BODY_BYTES,
    run=plan_campaign,
)

GENERATE_STORY = AiEndpoint(
    name="generate-story",
    request_model=GenerateStoryRequest,
    body_limit=GENERATE_STORY_BODY_BYTES,
    run=generate_story,
)


# No body parameter: FastAPI would read the whole body before our cap runs.
@router.post("/analyze-material", include_in_schema=False)
async def analyze_material_route(request: Request) -> JSONResponse:
    """Material Intelligence (Layer 1): material text -> MaterialBlueprint."""
    return await handle_ai_request(request, ANALYZE_MATERIAL)


@router.post("/plan-campaign", include_in_schema=False)
async def plan_campaign_route(request: Request) -> JSONResponse:
    """Campaign Planner (Layer 2): MaterialBlueprint[] + options -> CampaignBlueprint."""
    return await handle_ai_request(request, PLAN_CAMPAIGN)


@router.post("/generate-story", include_in_schema=False)
async def generate_story_route(request: Request) -> JSONResponse:
    """Story Generator (Layer 3): campaign + one story entry + material -> StoryBlueprint."""
    return await handle_ai_request(request, GENERATE_STORY)
