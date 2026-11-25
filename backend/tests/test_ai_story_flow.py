"""The whole AI flow through the HTTP API: analyze-material -> plan-campaign -> generate-story x2.

Why: each endpoint is tested alone against fixtures, but the product relies on them fitting
together: the browser takes the response of one layer and sends it, unchanged, as the request of
the next, and carries the continuity summary of story 1 into story 2. This test plays the browser
against one app with a scripted Gemini that answers by step (it recognises the step from the
system prompt) and checks that every hand-off is accepted and that story 2 really receives story
1's outcome, both in the request and in what the model is asked and what the intro says.
"""

from __future__ import annotations

import re
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from app.ai.contracts.story import StoryBlueprint
from app.ai.validation.story import validate_story
from tests.ai_support import build_app, gemini_reply, load_fixture

ANALYZE = "/api/v1/ai/analyze-material"
PLAN = "/api/v1/ai/plan-campaign"
STORY = "/api/v1/ai/generate-story"

VECTORS_TEXT = load_fixture("analyze-material.request.json")["material"]
DOT_TEXT = (
    "[Page 1] Dot product\nThe dot product of (a, b) and (c, d) is a*c + b*d.\n"
    "Multiply matching components, then add the products. The result is a single number."
)
DOT_ANALYSIS = {
    "material_id": "m",
    "title": "Dot product",
    "summary": "Introduces the dot product of two vectors.",
    "learning_objectives": ["Compute the dot product of two 2D vectors"],
    "concepts": [
        {
            "concept_id": "c_dot",
            "name": "Dot product",
            "definition": "The dot product of (a, b) and (c, d) is a*c + b*d.",
            "principles": ["The dot product is a single number"],
            "methods": ["Multiply matching components", "Add the products"],
            "prerequisites": [],
            "misconceptions": ["The dot product is a vector"],
            "source_evidence": ["Multiply matching components, then add."],
        }
    ],
    "scope_limitations": [],
}
PLAN_CREATIVE = load_fixture("plan-campaign.two-materials.gemini-output.json")


def story_content(prompt: str) -> dict[str, Any]:
    """What Gemini would write for the concepts listed in `prompt`."""
    ids = re.findall(r'"concept_id": "([^"]+)"', prompt)
    return {
        "intro": {"narration": "You arrive as the lanterns gutter.", "guide_line": "Stay close."},
        "concepts": [
            {
                "concept_id": concept_id,
                "companion_line": "Careful now.",
                "lesson_steps": [
                    {"title": "The idea", "body": "What it is and why it matters."},
                    {"title": "How it works", "body": "Apply the rule step by step."},
                ],
                "puzzle": {
                    "narrative_context": "A lantern waits.",
                    "question": "Which statement is correct?",
                    "correct_answer": "The one that follows from the definition.",
                    "wrong_answers": ["A plausible slip.", "A tempting mistake."],
                    "explanation": "It follows from the definition.",
                    "correct_feedback": "Yes.",
                    "incorrect_feedback": "Re-read the lesson.",
                },
                "result_narration": "The lantern steadies.",
                "guide_line": "Good.",
            }
            for concept_id in ids
        ],
        "ending": {"title": "Dawn", "narration": "The harbour is safe."},
    }


def scripted_gemini(request: httpx2.Request) -> httpx2.Response:
    import json

    body = json.loads(request.content)
    system = body["systemInstruction"]["parts"][0]["text"]
    prompt = body["contents"][0]["parts"][0]["text"]
    if "narrative designer" in system:
        return gemini_reply(PLAN_CREATIVE)
    if "visual-novel content" in system:
        return gemini_reply(story_content(prompt))
    if "Dot product" in prompt:
        return gemini_reply(DOT_ANALYSIS)
    return gemini_reply(load_fixture("analyze-material.gemini-output.json"))


def ok_data(response: httpx2.Response) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return body["data"]


def test_analyze_then_plan_then_two_stories_with_continuity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app, gemini, limiter, _ = build_app(monkeypatch, scripted_gemini)
    client = TestClient(app)

    # 1. Layer 1 for two materials.
    first = ok_data(client.post(ANALYZE, json={"material": VECTORS_TEXT}))["blueprint"]
    second = ok_data(client.post(ANALYZE, json={"material": DOT_TEXT}))["blueprint"]
    materials = {m["material_id"]: m for m in (first, second)}
    assert len(materials) == 2

    # 2. Layer 2 takes both blueprints as they came back.
    campaign = ok_data(
        client.post(PLAN, json={"materials": [first, second], "options": {"genre": "fantasy"}})
    )["blueprint"]
    sequence = campaign["story_sequence"]
    assert len(sequence) == 2
    assert {e["material_id"] for e in sequence} == set(materials)

    # 3. Layer 3, story 1: nothing came before.
    entry1, entry2 = sequence
    data1 = ok_data(
        client.post(
            STORY,
            json={
                "campaign": campaign,
                "story": entry1,
                "material": materials[entry1["material_id"]],
            },
        )
    )
    story1 = data1["blueprint"]
    assert story1["story_id"] == entry1["story_id"]
    summary = story1["continuity_summary"]
    assert summary is not None
    prompt1 = _story_prompts(gemini)[0]
    assert "What happened before:" not in prompt1

    # 4. Story 2 gets the continuity of story 1 as a PreviousStorySummary.
    previous = {
        "story_id": summary["story_id"],
        "title": entry1["title"],
        "outcome_description": summary["outcome_description"],
        "world_state_snapshot": summary["world_state_snapshot"],
        "relationship_snapshot": summary["relationship_snapshot"],
    }
    data2 = ok_data(
        client.post(
            STORY,
            json={
                "campaign": campaign,
                "story": entry2,
                "material": materials[entry2["material_id"]],
                "previousSummaries": [previous],
            },
        )
    )
    story2 = data2["blueprint"]
    assert story2["story_id"] == entry2["story_id"]
    assert story2["story_id"] != story1["story_id"]

    outcome = summary["outcome_description"]
    prompt2 = _story_prompts(gemini)[1]
    assert f"What happened before: {outcome}" in prompt2
    intro = story2["chapters"][0]["scenes"][0]["content"]
    # The model rewrites the first narration; the engine's continuity line stays at the end.
    assert intro[0] == {"type": "narration", "text": "You arrive as the lanterns gutter."}
    assert intro[-1] == {
        "type": "narration",
        "text": f"What came before still shapes this moment: {outcome}.",
    }

    # Both stories are valid blueprints for their own material and use the planned characters.
    characters = {c["character_id"] for c in campaign["characters"]}
    for story, entry in ((story1, entry1), (story2, entry2)):
        model = StoryBlueprint.model_validate(story)
        assert validate_story(model) == []
        assert set(story["character_ids"]) <= characters
        concepts = {c["concept_id"] for c in materials[entry["material_id"]]["concepts"]}
        assert {m["concept_id"] for m in story["knowledge_mapping"]} == concepts

    assert limiter.in_flight() == 0
    assert len(gemini.requests) == 5  # 2 analyze + 1 plan + 2 story


def _story_prompts(gemini: Any) -> list[str]:
    prompts = []
    for index in range(len(gemini.requests)):
        sent = gemini.sent_json(index)
        if "visual-novel content" in sent["systemInstruction"]["parts"][0]["text"]:
            prompts.append(sent["contents"][0]["parts"][0]["text"])
    return prompts


def test_the_story_two_request_is_rejected_when_the_summary_is_malformed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The hand-off is validated: a summary missing its title is a 400, not a silent skip.
    app, gemini, *_ = build_app(monkeypatch, scripted_gemini)
    client = TestClient(app)
    request = load_fixture("generate-story.request.json")
    bad = {**request, "previousSummaries": [{"story_id": "story_01", "outcome_description": "x"}]}
    response = client.post(STORY, json=bad)
    assert response.status_code == 400
    assert gemini.requests == []
