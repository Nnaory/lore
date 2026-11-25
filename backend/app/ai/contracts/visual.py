"""Lesson visual contract: vectors | plot | diagram | table | formula.

Why: mirrors `frontend/src/lib/contracts/schemas/visual.schema.ts`. Limits keep every primitive
legible on the 1280x720 canvas and cross-field checks reject specs the canvas cannot draw. The
story generator (Layer 3) drops an invalid visual and keeps the lesson; `parse_lesson_visual`
returns a union instead of raising so callers can do that and record a warning.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BeforeValidator,
    Field,
    Strict,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from app.ai.zod_compat import ZodModel, zod_flatten

# Coordinates are bounded so a stray 1e9 cannot squash the plane.
Coord = Annotated[float, Strict(), Field(ge=-1000, le=1000, allow_inf_nan=False)]
Vec2 = tuple[Coord, Coord]
Tone = Literal["primary", "secondary", "result", "muted"]


def _label(max_length: int) -> Any:
    return Annotated[
        str,
        Strict(),
        StringConstraints(strip_whitespace=True, min_length=1, max_length=max_length),
    ]


Label16 = _label(16)
Label24 = _label(24)
Label32 = _label(32)
Label40 = _label(40)
Label70 = _label(70)
Label80 = _label(80)
Label120 = _label(120)
Caption = _label(160)
Cell = Annotated[str, Strict(), StringConstraints(strip_whitespace=True, max_length=40)]


def _whole_number(value: object) -> object:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


RowIndex = Annotated[int, BeforeValidator(_whole_number), Strict(), Field(ge=0)]


def _check_range(value: Vec2) -> Vec2:
    if not value[0] < value[1]:
        raise ValueError("range must be [min, max] with min < max")
    return value


Range = Annotated[Vec2, AfterValidator(_check_range)]


class Vector(ZodModel):
    from_: Vec2 = Field(alias="from")
    to: Vec2
    label: Label24 | None = None
    tone: Tone | None = None


class Point(ZodModel):
    at: Vec2
    label: Label24 | None = None


def _vectors_have_length(vectors: list[Vector]) -> list[Vector]:
    if any(v.from_ == v.to for v in vectors):
        raise ValueError("a vector must have length")
    return vectors


class VectorsVisual(ZodModel):
    kind: Literal["vectors"]
    x_range: Range | None = None
    y_range: Range | None = None
    vectors: Annotated[
        list[Vector], Field(min_length=1, max_length=6), AfterValidator(_vectors_have_length)
    ]
    points: Annotated[list[Point], Field(max_length=6)] | None = None
    caption: Caption | None = None


class Series(ZodModel):
    label: Label24 | None = None
    points: Annotated[list[Vec2], Field(min_length=2, max_length=60)]
    tone: Tone | None = None


class PlotVisual(ZodModel):
    kind: Literal["plot"]
    x_label: Label24 | None = None
    y_label: Label24 | None = None
    series: Annotated[list[Series], Field(min_length=1, max_length=3)]
    caption: Caption | None = None


class DiagramNode(ZodModel):
    id: Label40
    label: Label32
    detail: Label70 | None = None


class DiagramEdge(ZodModel):
    from_: Label40 = Field(alias="from")
    to: Label40
    label: Label24 | None = None


class DiagramVisual(ZodModel):
    kind: Literal["diagram"]
    layout: Literal["flow", "tree", "cycle"]
    nodes: Annotated[list[DiagramNode], Field(min_length=2, max_length=8)]
    # Boxes without arrows (e.g. two side-by-side cases) are a valid diagram.
    edges: Annotated[list[DiagramEdge], Field(max_length=12)] = Field(default_factory=list)
    caption: Caption | None = None

    @model_validator(mode="after")
    def _edges_reference_nodes(self) -> DiagramVisual:
        ids: set[str] = set()
        for node in self.nodes:
            if node.id in ids:
                raise ValueError(f'duplicate node id "{node.id}"')
            ids.add(node.id)
        for edge in self.edges:
            if edge.from_ not in ids or edge.to not in ids:
                raise ValueError("edge must connect existing nodes")
            if edge.from_ == edge.to:
                raise ValueError("edge must connect two different nodes")
        return self


class TableVisual(ZodModel):
    kind: Literal["table"]
    headers: Annotated[list[Label24], Field(min_length=1, max_length=6)]
    # Cells wrap onto two lines on the canvas, so short phrases fit.
    rows: Annotated[list[list[Cell]], Field(min_length=1, max_length=10)]
    highlight_rows: Annotated[list[RowIndex], Field(max_length=10)] | None = None
    caption: Caption | None = None

    @model_validator(mode="after")
    def _rows_match_headers(self) -> TableVisual:
        if any(len(row) != len(self.headers) for row in self.rows):
            raise ValueError("every row needs one cell per header")
        if any(r >= len(self.rows) for r in self.highlight_rows or []):
            raise ValueError("highlighted row does not exist")
        return self


class FormulaTerm(ZodModel):
    symbol: Label16
    meaning: Label80


class FormulaVisual(ZodModel):
    kind: Literal["formula"]
    expression: Label80
    terms: Annotated[list[FormulaTerm], Field(min_length=1, max_length=5)]
    example: Label120 | None = None
    caption: Caption | None = None


LessonVisual = Annotated[
    VectorsVisual | PlotVisual | DiagramVisual | TableVisual | FormulaVisual,
    Field(discriminator="kind"),
]
_ADAPTER: TypeAdapter[Any] = TypeAdapter(LessonVisual)


@dataclass(frozen=True)
class VisualOk:
    visual: VectorsVisual | PlotVisual | DiagramVisual | TableVisual | FormulaVisual
    ok: Literal[True] = True


@dataclass(frozen=True)
class VisualInvalid:
    detail: dict[str, Any]
    ok: Literal[False] = False


def parse_lesson_visual(raw: object) -> VisualOk | VisualInvalid:
    """Validate a visual spec. Never raises; an invalid spec comes back as `VisualInvalid`."""
    try:
        return VisualOk(_ADAPTER.validate_python(raw))
    except ValidationError as exc:
        return VisualInvalid(zod_flatten(exc))
