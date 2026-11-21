"""Tests for the project envelope models and their NOT NULL guards.

Why: bad denormalized fields must surface as 422 validation errors, never as DB 500s, and the
opaque jsonb parts must round-trip untouched.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.models import CampaignStateUpdate, ProjectCreate

# Provenance: generated once from the frontend fixtures (dummyCampaign, dummyMaterial, linearStory,
# linearStory2; campaign_state from createInitialCampaignState + completeStory).
# frontend/tests/state/project-contract.test.ts checks the same file against the Zod schemas.
FIXTURE = Path(__file__).parent / "fixtures" / "project.json"


@pytest.fixture
def payload() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_validates(payload: dict[str, Any]) -> None:
    project = ProjectCreate.model_validate(payload)
    assert project.id == "p_lk2j_ab12cd"


@pytest.mark.parametrize("key", ["title", "genre"])
@pytest.mark.parametrize("bad", ["missing", "", 5])
def test_campaign_title_and_genre_are_required_strings(
    payload: dict[str, Any], key: str, bad: object
) -> None:
    if bad == "missing":
        del payload["campaign"][key]
    else:
        payload["campaign"][key] = bad
    with pytest.raises(ValidationError, match=f"campaign.{key}"):
        ProjectCreate.model_validate(payload)


def test_story_sequence_must_be_an_array(payload: dict[str, Any]) -> None:
    payload["campaign"]["story_sequence"] = {"a": 1}
    with pytest.raises(ValidationError, match="story_sequence"):
        ProjectCreate.model_validate(payload)


@pytest.mark.parametrize("bad", ["missing", "text", {"a": 1}, [1, 2]])
def test_completed_stories_must_be_array_of_strings_in_create(
    payload: dict[str, Any], bad: object
) -> None:
    if bad == "missing":
        del payload["campaign_state"]["completed_stories"]
    else:
        payload["campaign_state"]["completed_stories"] = bad
    with pytest.raises(ValidationError, match="completed_stories"):
        ProjectCreate.model_validate(payload)


@pytest.mark.parametrize("bad", ["missing", "text", [1]])
def test_completed_stories_must_be_array_of_strings_in_update(bad: object) -> None:
    state: dict[str, Any] = {"completed_stories": ["story_01"]}
    if bad == "missing":
        del state["completed_stories"]
    else:
        state["completed_stories"] = bad
    with pytest.raises(ValidationError, match="completed_stories"):
        CampaignStateUpdate.model_validate({"campaign_state": state, "updated_at": 1})


def test_optional_fields_accept_none(payload: dict[str, Any]) -> None:
    payload["campaign_state"] = None
    payload["id"] = None
    payload["materials"] = None
    project = ProjectCreate.model_validate(payload)
    assert project.campaign_state is None
    assert project.id is None


def test_empty_id_is_rejected(payload: dict[str, Any]) -> None:
    payload["id"] = "  "
    with pytest.raises(ValidationError, match="id"):
        ProjectCreate.model_validate(payload)


def test_opaque_parts_round_trip_unchanged(payload: dict[str, Any]) -> None:
    original = copy.deepcopy(payload)
    dumped = ProjectCreate.model_validate(payload).model_dump()
    for key in ("campaign", "stories", "campaign_state", "materials"):
        assert dumped[key] == original[key]
        assert json.dumps(dumped[key], sort_keys=False) == json.dumps(original[key])
