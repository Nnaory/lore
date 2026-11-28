"""Async Gemini `generateContent` client with a JSON mode and a plain-text mode.

Why: an async port of `frontend/src/lib/ai/providers/gemini-client.ts` so the backend can call
Gemini with the same behaviour: ordered model fallback, retries with backoff on 429/5xx, code
fence stripping (JSON mode only), and a total deadline. `generate_json` asks for
`application/json` and parses it; `generate_text` asks for `text/plain` and returns the text
as is. Both run the same `_generate` loop, so model order, attempts, backoff, status
classification, deadline and thought-part filtering cannot drift apart. Expected failures are
returned as `GeminiFailure`, never raised. The API key is only sent in the `x-goog-api-key`
header; it never appears in results, details, exceptions or logs, and request bodies are never
logged. This is the only module under `backend/app` that knows the Gemini endpoint.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any, Literal
from urllib.parse import quote

import httpx2

from app.ai.settings import GeminiConfig

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"
_MAX_REASON_CHARS = 200

FailureCode = Literal["PROVIDER_UNAVAILABLE", "OUTPUT_PARSE_FAILED", "RATE_LIMITED", "TIMEOUT"]
ResponseFormat = Literal["json", "text"]


@dataclass(frozen=True)
class GeminiRequest:
    """One generation request.

    `response_format` is set by `generate_json` ("json") and `generate_text` ("text"), so
    callers normally leave the default. It stays the last field so existing positional and
    keyword constructions keep working.
    """

    system: str
    prompt: str
    max_output_tokens: int
    temperature: float | None = None
    response_format: ResponseFormat = "json"


@dataclass(frozen=True)
class GeminiUsage:
    """Token counts reported by Gemini (any may be missing)."""

    prompt_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


@dataclass(frozen=True)
class GeminiOk:
    """Successful generation; `json` is parsed but not validated."""

    json: Any
    model: str
    usage: GeminiUsage
    latency_ms: float
    ok: Literal[True] = True


@dataclass(frozen=True)
class GeminiTextOk:
    """Successful text generation.

    `text` is the non-thought parts joined in order, untouched (no trim, no fence stripping).
    `finish_reason` is Gemini's `finishReason` or "none"; `MAX_TOKENS` is still a success, so
    callers that care about truncation must check it.
    """

    text: str
    model: str
    usage: GeminiUsage
    latency_ms: float
    finish_reason: str
    ok: Literal[True] = True


@dataclass(frozen=True)
class GeminiFailure:
    """Failed generation. `detail` is a list of {model, reason, status?}."""

    code: FailureCode
    message: str
    detail: list[dict[str, Any]]
    ok: Literal[False] = False


GeminiResult = GeminiOk | GeminiFailure
GeminiTextResult = GeminiTextOk | GeminiFailure
Sleep = Callable[[float], Awaitable[object]]


@dataclass(frozen=True)
class _Attempt:
    kind: Literal["ok", "retry", "next-model", "fatal"]
    reason: str = ""
    status: int | None = None
    json: Any = None
    usage: GeminiUsage | None = None
    text: str = ""
    finish_reason: str = "none"


@dataclass(frozen=True)
class _Success:
    """The winning attempt of `_generate`, before it is shaped into a public result."""

    attempt: _Attempt
    model: str
    usage: GeminiUsage
    latency_ms: float


def parse_json_text(text: str) -> Any:
    """Strip ```json fences and parse. Raises ValueError on invalid JSON."""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    return json.loads(cleaned)


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _error_reason(body: dict[str, Any], status: int) -> str:
    error = body.get("error")
    message = error.get("message") if isinstance(error, dict) else None
    if isinstance(message, str):
        return message[:_MAX_REASON_CHARS]
    return f"HTTP {status}"


def _usage_of(body: dict[str, Any]) -> GeminiUsage:
    meta = body.get("usageMetadata")
    meta = meta if isinstance(meta, dict) else {}
    return GeminiUsage(
        prompt_tokens=_int_or_none(meta.get("promptTokenCount")),
        output_tokens=_int_or_none(meta.get("candidatesTokenCount")),
        total_tokens=_int_or_none(meta.get("totalTokenCount")),
    )


async def _attempt_once(
    client: httpx2.AsyncClient,
    model: str,
    request: GeminiRequest,
    config: GeminiConfig,
    timeout_ms: float,
) -> _Attempt:
    is_text = request.response_format == "text"
    generation_config: dict[str, Any] = {
        "responseMimeType": "text/plain" if is_text else "application/json",
        "maxOutputTokens": request.max_output_tokens,
    }
    if request.temperature is not None:
        generation_config["temperature"] = request.temperature
    payload = {
        "systemInstruction": {"parts": [{"text": request.system}]},
        "contents": [{"role": "user", "parts": [{"text": request.prompt}]}],
        "generationConfig": generation_config,
    }
    try:
        response = await client.post(
            f"{ENDPOINT}/{quote(model, safe='')}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": config.api_key},
            content=json.dumps(payload),
            timeout=timeout_ms / 1000,
        )
    except httpx2.TimeoutException:
        # A model that is too slow now is likely to stay slow: try the next one.
        return _Attempt("next-model", "timeout")
    except httpx2.LocalProtocolError:
        # The request could not even be built, almost always because the key is not a valid
        # header value (stray spaces or a mis-pasted line). Retrying cannot help, so stop.
        # The exception text contains the header value, so it is deliberately not used.
        return _Attempt("fatal", "API key is not a valid header value (check GOOGLE_API_KEY)")
    except httpx2.HTTPError:
        return _Attempt("retry", "network error")

    try:
        parsed = response.json()
        if not isinstance(parsed, dict):
            raise ValueError("body is not an object")
        body: dict[str, Any] = parsed
    except ValueError:
        return _Attempt("retry", "unreadable response", response.status_code)

    status = response.status_code
    if not response.is_success:
        reason = _error_reason(body, status)
        if status == 429 or status >= 500:
            return _Attempt("retry", reason, status)
        if status in (400, 404):
            return _Attempt("next-model", reason, status)
        return _Attempt("fatal", reason, status)  # 401/402/403: key, billing or permission

    candidates = body.get("candidates")
    candidate = candidates[0] if isinstance(candidates, list) and candidates else None
    candidate = candidate if isinstance(candidate, dict) else {}
    content = candidate.get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    text = "".join(
        p["text"]
        for p in (parts if isinstance(parts, list) else [])
        if isinstance(p, dict) and not p.get("thought") and isinstance(p.get("text"), str)
    )
    finish = candidate.get("finishReason") or "none"
    # Text mode also treats whitespace-only output as empty; JSON mode keeps its old rule
    # (whitespace-only falls through to the JSON parser and fails there).
    if not (text.strip() if is_text else text):
        return _Attempt("retry", f"empty response (finishReason: {finish})")

    if is_text:
        # No JSON parsing, no trimming, no fence stripping: the caller owns the text.
        return _Attempt("ok", usage=_usage_of(body), text=text, finish_reason=finish)
    try:
        parsed_json = parse_json_text(text)
    except ValueError:
        return _Attempt("retry", f"response was not valid JSON (finishReason: {finish})")
    return _Attempt("ok", json=parsed_json, usage=_usage_of(body))


def _with_format(request: GeminiRequest, response_format: ResponseFormat) -> GeminiRequest:
    """Return `request` in the given format (the same object when it already matches)."""
    if request.response_format == response_format:
        return request
    return replace(request, response_format=response_format)


async def generate_json(
    request: GeminiRequest,
    config: GeminiConfig,
    *,
    client: httpx2.AsyncClient | None = None,
    sleep: Sleep = asyncio.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> GeminiResult:
    """Generate a JSON response, trying each configured model in order.

    `sleep` receives seconds (like `asyncio.sleep`). Returns parsed, unvalidated JSON.
    """
    outcome = await _run(_with_format(request, "json"), config, client, sleep, monotonic)
    if isinstance(outcome, GeminiFailure):
        return outcome
    return GeminiOk(
        json=outcome.attempt.json,
        model=outcome.model,
        usage=outcome.usage,
        latency_ms=outcome.latency_ms,
    )


async def generate_text(
    request: GeminiRequest,
    config: GeminiConfig,
    *,
    client: httpx2.AsyncClient | None = None,
    sleep: Sleep = asyncio.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> GeminiTextResult:
    """Generate plain text, trying each configured model in order.

    Same model order, retries, backoff, status handling and deadline as `generate_json`.
    The text is returned exactly as Gemini sent it. A failure is never `OUTPUT_PARSE_FAILED`,
    because nothing is parsed.
    """
    outcome = await _run(_with_format(request, "text"), config, client, sleep, monotonic)
    if isinstance(outcome, GeminiFailure):
        return outcome
    return GeminiTextOk(
        text=outcome.attempt.text,
        model=outcome.model,
        usage=outcome.usage,
        latency_ms=outcome.latency_ms,
        finish_reason=outcome.attempt.finish_reason,
    )


async def _run(
    request: GeminiRequest,
    config: GeminiConfig,
    client: httpx2.AsyncClient | None,
    sleep: Sleep,
    monotonic: Callable[[], float],
) -> _Success | GeminiFailure:
    """Run `_generate` with the caller's client, or with one opened (and closed) here."""
    if client is not None:
        return await _generate(request, config, client, sleep, monotonic)
    async with httpx2.AsyncClient() as own_client:
        return await _generate(request, config, own_client, sleep, monotonic)


async def _generate(
    request: GeminiRequest,
    config: GeminiConfig,
    client: httpx2.AsyncClient,
    sleep: Sleep,
    monotonic: Callable[[], float],
) -> _Success | GeminiFailure:
    start = monotonic()
    failures: list[dict[str, Any]] = []
    saw_rate_limit = False
    saw_timeout_only = True
    saw_bad_json = False
    is_json = request.response_format == "json"

    def elapsed_ms() -> float:
        return (monotonic() - start) * 1000

    for model in config.models:
        stop_all = False
        for attempt in range(1, config.attempts_per_model + 1):
            remaining = config.deadline_ms - elapsed_ms()
            if remaining <= 0:
                failures.append({"model": model, "reason": "deadline reached"})
                stop_all = True
                break
            result = await _attempt_once(
                client, model, request, config, min(config.timeout_ms, remaining)
            )
            if result.kind == "ok" and result.usage is not None:
                return _Success(
                    attempt=result, model=model, usage=result.usage, latency_ms=elapsed_ms()
                )
            failure: dict[str, Any] = {"model": model, "reason": result.reason}
            if result.status is not None:
                failure["status"] = result.status
            failures.append(failure)
            if result.status == 429:
                saw_rate_limit = True
            if result.reason != "timeout":
                saw_timeout_only = False
            # Only JSON mode can fail to parse. In text mode a provider error message that
            # happens to say "not valid JSON" must not turn into OUTPUT_PARSE_FAILED.
            if is_json and "not valid JSON" in result.reason:
                saw_bad_json = True

            if result.kind == "fatal":
                return GeminiFailure(
                    code="PROVIDER_UNAVAILABLE",
                    message=(
                        "The AI provider rejected the request "
                        "(check the API key, billing, or permissions)."
                    ),
                    detail=failures,
                )
            if result.kind == "next-model":
                break
            if attempt < config.attempts_per_model:
                await sleep(config.backoff_ms * attempt / 1000)
        if stop_all:
            break

    if saw_bad_json and not saw_rate_limit:
        return GeminiFailure(
            code="OUTPUT_PARSE_FAILED",
            message="The AI provider did not return valid JSON.",
            detail=failures,
        )
    code: FailureCode
    if saw_rate_limit:
        code = "RATE_LIMITED"
    elif saw_timeout_only:
        code = "TIMEOUT"
    else:
        code = "PROVIDER_UNAVAILABLE"
    return GeminiFailure(
        code=code,
        message="No configured AI model is available right now. Try again in a moment.",
        detail=failures,
    )
