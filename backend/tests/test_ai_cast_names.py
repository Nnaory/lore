"""Kit cast names in the AI pipeline: no other character names come from backend code.

Why: spec ui-redesign (R16) fixed the campaign cast to Eldric, Mira, Hazel, Varr and Nyx. A user
reported other names in stories made from material. Backend-side, the names can only come from the
templates, the engine's own text, or free text Gemini writes. These tests cover the first two for
every genre and check that both prompts tell Gemini to use the given names only. Text Gemini
writes freely cannot be checked here.
"""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from app.ai.campaign_templates import CAST_IDS, GENRE_TEMPLATES
from app.ai.contracts.requests import GenerateStoryRequest
from app.ai.prompts.story_generator import build_story_prompt
from app.ai.story_generator_engine import StoryEngineSuccess, build_story_blueprint
from tests.ai_support import load_fixture

KIT_NAMES = {"eldric": "Eldric", "mira": "Mira", "hazel": "Hazel", "varr": "Varr", "nyx": "Nyx"}
# Labels and names of the pre-Kit cast and of the fixtures; none may come from engine or prompt.
OLD_NAMES = ("Lyra", "Maren", "Tobi", "Professor", "Apprentice Keeper", "char_01", "char_02")

CASES = load_fixture("story-parity.snapshot.json")["cases"]


def _kit_characters(genre: str) -> list[dict[str, Any]]:
    template = GENRE_TEMPLATES[genre]
    return [
        {
            "character_id": c.character_id,
            "name": c.name,
            "role": c.role,
            "description": c.description,
            "expressions": {"neutral": "(-_-)", "worried": "(>_<)", "approving": "(^_^)"},
        }
        for c in template.characters
    ]


def _request(genre: str) -> GenerateStoryRequest:
    body = copy.deepcopy(CASES["one"]["request"])
    body["campaign"]["characters"] = _kit_characters(genre)
    body["campaign"]["genre"] = genre
    return GenerateStoryRequest.model_validate(body)


@pytest.mark.parametrize("genre", sorted(GENRE_TEMPLATES))
def test_every_genre_template_uses_exactly_the_kit_cast(genre: str) -> None:
    characters = GENRE_TEMPLATES[genre].characters
    assert [c.character_id for c in characters] == list(CAST_IDS)
    assert [c.name for c in characters] == [KIT_NAMES[i] for i in CAST_IDS]


@pytest.mark.parametrize("genre", sorted(GENRE_TEMPLATES))
def test_story_skeleton_and_prompt_name_only_kit_characters(genre: str) -> None:
    request = _request(genre)
    engine = build_story_blueprint(request)
    assert isinstance(engine, StoryEngineSuccess)
    assert engine.blueprint["character_ids"] == ["eldric", "mira"]
    speakers = {
        block["character_id"]
        for chapter in engine.blueprint["chapters"]
        for scene in chapter["scenes"]
        for block in scene.get("content", [])
        if block["type"] == "dialogue"
    }
    assert speakers <= {"eldric", "mira"}

    # The engine's own text never carries a character label; names only appear through ids.
    skeleton_text = json.dumps(engine.blueprint, ensure_ascii=False)
    for old in OLD_NAMES:
        assert old not in skeleton_text

    prompt = build_story_prompt(request, engine.blueprint)
    assert "Guide character: Eldric (Keeper of the Beacon)" in prompt
    assert "Companion character: Mira (Apprentice Cartographer)" in prompt
    for old in OLD_NAMES:
        assert old not in prompt.replace("Apprentice Cartographer", "")


def test_story_prompt_tells_gemini_to_use_the_given_names_only() -> None:
    request = _request("fantasy")
    engine = build_story_blueprint(request)
    assert isinstance(engine, StoryEngineSuccess)
    prompt = build_story_prompt(request, engine.blueprint)
    rule = next(line for line in prompt.splitlines() if line.startswith("- Characters:"))
    assert "exact name given above" in rule
    assert "do not invent any other named character" in rule
