"""Output parser and validator for the Campaign Planner (Layer 2).

Why: port of `frontend/src/lib/ai/campaign-output-parser.ts`. A candidate campaign is untrusted
until it passes the CampaignBlueprint model and then the planner's semantic rules
(`validate_planned_campaign`). It never repairs or rewrites output: a failure is a
`VALIDATION_FAILED` answer (HTTP 502) whose `detail` is the Zod-style flatten for a schema
failure, or the list of `{code, message, path}` problems for a semantic failure. Provider
failures pass through unchanged. Never raises.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from app.ai.contracts.campaign import CampaignBlueprint
from app.ai.contracts.material import MaterialBlueprint
from app.ai.envelope import AiError
from app.ai.validation.planner import validate_planned_campaign
from app.ai.zod_compat import zod_flatten


@dataclass(frozen=True)
class CandidateCampaign:
    """What the planner provider produced: an unvalidated blueprint plus provenance."""

    blueprint: dict[str, Any]
    provider: str
    model: str
    latency_ms: int
    warnings: list[dict[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class ParsedCampaign:
    """A validated blueprint and the `meta` object of the response."""

    blueprint: CampaignBlueprint
    meta: dict[str, Any]


def parse_campaign_provider_result(
    result: CandidateCampaign | AiError, materials: list[MaterialBlueprint]
) -> ParsedCampaign | AiError:
    """Pass a provider failure through, or validate the candidate."""
    if isinstance(result, AiError):
        return result
    return parse_and_validate_campaign_output(result, materials)


def parse_and_validate_campaign_output(
    candidate: CandidateCampaign, materials: list[MaterialBlueprint]
) -> ParsedCampaign | AiError:
    """Validate a candidate against the schema, then against the planner rules."""
    try:
        blueprint = CampaignBlueprint.model_validate(candidate.blueprint)
    except ValidationError as exc:
        return AiError(
            "VALIDATION_FAILED",
            "Provider output does not match the CampaignBlueprint schema.",
            zod_flatten(exc),
        )

    problems = validate_planned_campaign(blueprint, materials)
    if problems:
        return AiError(
            "VALIDATION_FAILED",
            "Provider output failed planner semantic validation.",
            problems,
        )

    meta = {
        "provider": candidate.provider,
        "model": candidate.model,
        "latencyMs": candidate.latency_ms,
        "warnings": list(candidate.warnings),
    }
    return ParsedCampaign(blueprint, meta)
