"""Pydantic envelope models for the projects API.

Why: the server validates only the envelope and the fields that feed NOT NULL columns
(title, genre, story_sequence, completed_stories). Campaign, stories, state and materials stay
opaque dicts; full validation remains on the client with Zod, so a second schema cannot drift
and reject data the client accepts.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, field_validator


def _check_completed_stories(state: dict[str, Any]) -> dict[str, Any]:
    """completed_stories feeds jsonb_array_length; a bad value must be a 422, not a 500."""
    completed = state.get("completed_stories")
    if not isinstance(completed, list):
        raise ValueError("campaign_state.completed_stories is required and must be an array")
    if not all(isinstance(s, str) for s in completed):
        raise ValueError("campaign_state.completed_stories must be an array of strings")
    return state


class SourceModel(BaseModel):
    file_name: str
    file_type: str


class ProjectCreate(BaseModel):
    id: str | None = None
    created_at: int | None = None
    updated_at: int | None = None
    source: SourceModel
    campaign: dict[str, Any]
    stories: dict[str, Any]
    campaign_state: dict[str, Any] | None = None
    materials: list[dict[str, Any]] | None = None

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("id must be a non-empty string when provided")
        return value

    @field_validator("campaign")
    @classmethod
    def validate_denormalized_fields(cls, campaign: dict[str, Any]) -> dict[str, Any]:
        errors: list[str] = []
        for key in ("title", "genre"):
            value = campaign.get(key)
            if not isinstance(value, str) or not value:
                errors.append(f"campaign.{key} is required and must be a non-empty string")
        if not isinstance(campaign.get("story_sequence"), list):
            errors.append("campaign.story_sequence is required and must be an array")
        if errors:
            raise ValueError("; ".join(errors))
        return campaign

    @field_validator("campaign_state")
    @classmethod
    def validate_completed_stories(cls, state: dict[str, Any] | None) -> dict[str, Any] | None:
        return None if state is None else _check_completed_stories(state)


class ProjectResponse(BaseModel):
    id: str
    created_at: int
    updated_at: int
    source: dict[str, Any]
    campaign: dict[str, Any]
    stories: dict[str, Any]
    campaign_state: dict[str, Any] | None = None
    materials: list[dict[str, Any]] | None = None


class ProjectSummaryResponse(BaseModel):
    id: str
    title: str
    genre: str
    source_name: str
    updated_at: int
    stories_total: int
    stories_completed: int


class CampaignStateUpdate(BaseModel):
    campaign_state: dict[str, Any]
    updated_at: int

    @field_validator("campaign_state")
    @classmethod
    def validate_completed_stories(cls, state: dict[str, Any]) -> dict[str, Any]:
        return _check_completed_stories(state)


class ImportRequest(BaseModel):
    projects: list[ProjectCreate]


class ImportResponse(BaseModel):
    imported: int
    skipped: int


class StateConflictResponse(BaseModel):
    detail: str
    stored_updated_at: int
