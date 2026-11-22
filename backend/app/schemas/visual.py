"""Visual contract for the LangGraph orchestrator.

Mirrors frontend/src/lib/schemas/visual.ts. The agent outputs ONLY these recipes —
never images, pixel coordinates or colours outside the allowed set. Use these models
as `with_structured_output(SceneBlueprint)` targets so the LLM cannot invent assets.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Expression = Literal["calm", "smile", "worried", "surprised", "angry"]
CastId = Literal["eldric", "mira", "hazel", "varr", "nyx"]
StoryLanguage = Literal["id", "en"]
HexColor = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]


class CharacterSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cloth: HexColor | None = None
    outfit: Literal["robe", "coat", "armor", "dress", "cloak"] | None = None
    prop: Literal["lantern", "book", "spear", "orb", "broom"] | None = None
    hat: Literal["pointed", "witch", "helmet", "hood"] | None = None
    hair: Literal["sides", "long", "buns"] | None = None
    beard: Literal["long", "mustache"] | None = None
    eyes: Literal["o2", "g2", "k"] | None = None
    face: Literal["void"] | None = None
    faceR: float | None = Field(default=None, ge=3.6, le=4.6)
    faceTall: float | None = Field(default=None, ge=1.0, le=1.2)
    mouthY: int | None = Field(default=None, ge=21, le=22)
    blush: bool | None = None
    clasp: bool | None = None


class CharacterDef(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,23}$")
    name: str = Field(min_length=1, max_length=24)
    role: str = Field(min_length=1, max_length=48)
    function: Literal["guide", "peer", "practice", "examiner", "rival"]
    look: CastId | CharacterSpec


class SceneRecipe(BaseModel):
    biome: Literal["city_gate"]
    seed: int = Field(ge=1, le=9999)
    title: str = Field(max_length=60)


class PreviewVector2D(BaseModel):
    kind: Literal["vector2d"] = "vector2d"
    x: float
    y: float
    caption: str = Field(max_length=90)


class PreviewScalar(BaseModel):
    kind: Literal["scalar"] = "scalar"
    value: float
    caption: str = Field(max_length=90)


class PreviewMatrix(BaseModel):
    kind: Literal["matrix"] = "matrix"
    rows: list[list[float | Annotated[str, Field(max_length=6)]]] = Field(
        min_length=1, max_length=4
    )
    caption: str = Field(max_length=90)


class PreviewText(BaseModel):
    kind: Literal["text"] = "text"
    text: str = Field(max_length=60)
    caption: str = Field(max_length=90)


PreviewSpec = Annotated[
    PreviewVector2D | PreviewScalar | PreviewMatrix | PreviewText, Field(discriminator="kind")
]
"""What the canvas draws while an option is highlighted. `caption` describes the SHAPE only —
it must never reveal whether the option is correct."""


class DialogueBeat(BaseModel):
    kind: Literal["line"] = "line"
    speaker: str
    expression: Expression = "calm"
    text: str = Field(min_length=1, max_length=280)


class Voice(BaseModel):
    speaker: str
    expression: Expression
    mood: str = Field(max_length=16)
    claim: str = Field(max_length=110)


class ChoiceOption(BaseModel):
    id: str = Field(min_length=1, max_length=16)
    label: str = Field(min_length=1, max_length=32)
    correct: bool
    why: str = Field(min_length=1, max_length=200)
    preview: PreviewSpec | None = None
    voice: Voice | None = None


class Reaction(BaseModel):
    correct: Expression = "smile"
    wrong: Expression = "worried"


class ChoiceBeat(BaseModel):
    kind: Literal["choice"] = "choice"
    mode: Literal["rune", "council"] = "rune"
    speaker: str
    prompt: str = Field(min_length=1, max_length=200)
    canvasLabel: str | None = Field(default=None, max_length=48)
    options: list[ChoiceOption] = Field(min_length=2, max_length=4)
    reaction: Reaction = Reaction()
    concept: str = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def _check(self) -> ChoiceBeat:
        if sum(o.correct for o in self.options) != 1:
            raise ValueError("exactly one option must be correct")
        if self.mode == "council" and any(o.voice is None for o in self.options):
            raise ValueError("council mode needs a voice on every option")
        return self


Beat = Annotated[DialogueBeat | ChoiceBeat, Field(discriminator="kind")]


class SceneBlueprint(BaseModel):
    language: StoryLanguage = "en"
    scene: SceneRecipe
    cast: list[CharacterDef] = Field(min_length=1, max_length=5)
    beats: list[Beat] = Field(min_length=1)
