"""Mid-story Q&A service (`POST /api/v1/ai/ask`).

Why: answers a learner's question mid-story in the voice of the addressed character, grounded
in the campaign's full MaterialBlueprint[] and story lessons while never spoiling puzzle answers
or accepting instructions from untrusted text.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Strict, ValidationError

from app.ai.contracts.ask import AskQuestionRequest
from app.ai.contracts.requests import utf16_length
from app.ai.envelope import AiError, AiOk, AiResult
from app.ai.gemini_client import GeminiFailure, GeminiRequest
from app.ai.prompts.ask_question import (
    ALLOWED_EXPRESSIONS,
    build_ask_prompt,
    build_ask_system_prompt,
    resolve_speaker,
)
from app.ai.runtime import AiContext
from app.ai.validation import validation_error
from app.ai.zod_compat import js_trim, zod_flatten

PROVIDER_ID = "google"
_MAX_OUTPUT_TOKENS = 1_200
_TEMPERATURE = 0.4
MAX_REPLY_CHARS = 1_000


def _trimmed_nonempty() -> Any:
    def prepare(value: object) -> object:
        return js_trim(value) if isinstance(value, str) else value

    def check(value: str) -> str:
        if utf16_length(value) < 1:
            raise ValueError("answer must not be empty")
        return value

    return Annotated[str, BeforeValidator(prepare), Strict(), AfterValidator(check)]


class _RawAskReply(BaseModel):
    model_config = ConfigDict(extra="ignore")

    answer: _trimmed_nonempty()
    expression: str | None = None
    referenced_concept_ids: list[str] | None = None
    out_of_scope: bool | None = None


def _validate_scene_context(request: AskQuestionRequest) -> AiError | None:
    for chapter in request.story.chapters:
        for scene in chapter.scenes:
            if scene.scene_id == request.context.scene_id:
                if scene.type in ("puzzle", "ending"):
                    return AiError(
                        "ASK_NOT_ALLOWED_IN_SCENE",
                        f'Questions cannot be asked during "{scene.type}" scenes.',
                    )
                return None
    return AiError(
        "SCENE_NOT_IN_STORY",
        f'Scene "{request.context.scene_id}" does not exist in story "{request.story.story_id}".',
    )


def _normalize_expression(raw: str | None) -> tuple[str, bool]:
    if isinstance(raw, str):
        cleaned = raw.strip().lower()
        if cleaned in ALLOWED_EXPRESSIONS:
            return cleaned, False
    return "calm", raw is not None


def _known_concept_ids(request: AskQuestionRequest) -> set[str]:
    known = {m.concept_id for mat in request.materials for m in mat.concepts}
    known.update(entry.concept_id for entry in request.story.knowledge_mapping)
    return known


def _cap_answer(text: str) -> tuple[str, bool]:
    """Keep answers concise enough for DialogueBox pagination without breaking Unicode."""
    if utf16_length(text) <= MAX_REPLY_CHARS:
        return text, False
    budget = MAX_REPLY_CHARS - 1
    chars: list[str] = []
    used = 0
    for ch in text:
        units = 2 if ord(ch) > 0xFFFF else 1
        if used + units > budget:
            break
        chars.append(ch)
        used += units
    clipped = "".join(chars).rstrip()
    cut = clipped.rfind(" ")
    if cut >= len(clipped) // 2:
        clipped = clipped[:cut].rstrip()
    return f"{clipped}…", True


def _normalize_reply(
    raw: _RawAskReply, request: AskQuestionRequest
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    warnings: list[dict[str, str]] = []
    answer, clipped = _cap_answer(raw.answer)
    if clipped:
        warnings.append(
            validation_error(
                "ANSWER_TRUNCATED",
                f"Answer exceeded {MAX_REPLY_CHARS} characters and was trimmed.",
                "reply.answer",
            )
        )

    expression, fell_back = _normalize_expression(raw.expression)
    if fell_back:
        warnings.append(
            validation_error(
                "EXPRESSION_FALLBACK",
                'Expression was unsupported and defaulted to "calm".',
                "reply.expression",
            )
        )

    known = _known_concept_ids(request)
    referenced: list[str] = []
    for cid in raw.referenced_concept_ids or []:
        if isinstance(cid, str) and cid in known and cid not in referenced:
            referenced.append(cid)

    return (
        {
            "answer": answer,
            "expression": expression,
            "referenced_concept_ids": referenced,
            "out_of_scope": bool(raw.out_of_scope),
        },
        warnings,
    )


async def ask_question(request: AskQuestionRequest, ctx: AiContext) -> AiResult:
    """Answer a mid-story learner question grounded in materials and story lessons."""
    invalid = _validate_scene_context(request)
    if invalid is not None:
        return invalid

    speaker = resolve_speaker(request)
    result = await ctx.generate_json(
        GeminiRequest(
            system=build_ask_system_prompt(speaker),
            prompt=build_ask_prompt(request, speaker),
            max_output_tokens=_MAX_OUTPUT_TOKENS,
            temperature=_TEMPERATURE,
        )
    )
    if isinstance(result, GeminiFailure):
        return AiError(result.code, result.message, result.detail)

    try:
        parsed = _RawAskReply.model_validate(result.json)
    except ValidationError as exc:
        return AiError(
            "VALIDATION_FAILED",
            "The AI tutor returned an answer in an unexpected shape.",
            zod_flatten(exc),
        )

    reply, warnings = _normalize_reply(parsed, request)
    meta: dict[str, Any] = {
        "provider": PROVIDER_ID,
        "model": result.model,
        "latencyMs": round(result.latency_ms),
        "warnings": warnings,
    }
    if result.usage.prompt_tokens is not None:
        meta["tokensIn"] = result.usage.prompt_tokens
    if result.usage.output_tokens is not None:
        meta["tokensOut"] = result.usage.output_tokens
    return AiOk({"reply": reply, "meta": meta})
