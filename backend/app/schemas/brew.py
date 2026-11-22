"""Building World progress events, streamed over SSE (one JSON object per message).

Mirrors frontend/src/lib/schemas/brew.ts. Emit them from the LangGraph run in this order:
start → concept* → awaiting_review (interrupt; resume with the kept concepts) →
step(world) → world* → step(writing) → chapter* → done. Never fake progress on the client.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

BrewStep = Literal["reading", "review", "world", "writing", "done"]


class Start(BaseModel):
    type: Literal["start"] = "start"
    file: str
    pages: int = Field(ge=1)
    genre: str
    chapters: int = Field(ge=1, le=5)
    language: Literal["id", "en"]


class Step(BaseModel):
    type: Literal["step"] = "step"
    step: BrewStep


class Concept(BaseModel):
    type: Literal["concept"] = "concept"
    label: str = Field(min_length=1, max_length=40)


class AwaitingReview(BaseModel):
    type: Literal["awaiting_review"] = "awaiting_review"


class World(BaseModel):
    type: Literal["world"] = "world"
    kind: Literal["place", "character"]
    label: str = Field(min_length=1, max_length=40)


class Chapter(BaseModel):
    type: Literal["chapter"] = "chapter"
    title: str = Field(min_length=1, max_length=60)


class Done(BaseModel):
    type: Literal["done"] = "done"
    storyId: str
    chapters: int
    characters: int


class Error(BaseModel):
    type: Literal["error"] = "error"
    message: str


BrewEvent = Annotated[
    Start | Step | Concept | AwaitingReview | World | Chapter | Done | Error,
    Field(discriminator="type"),
]


class ReviewDecision(BaseModel):
    """POST body that resumes the graph after `awaiting_review`."""

    kept: list[str] = Field(min_length=1)
