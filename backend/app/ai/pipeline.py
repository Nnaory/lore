"""Shared request pipeline for the AI endpoints (limits, body, validation, service, envelope).

Why: analyze-material, plan-campaign and generate-story differ only in their request model,
body cap and service function. Everything around them is the same and security relevant, so it
lives here once: per-IP and per-owner rate limits, a hard body cap enforced while streaming,
JSON and model validation (400, never 500), the "AI not configured" check, daily quota and
concurrency slot (always released in `finally`), and the catch-all that turns a bug into a 500
`UNKNOWN` without leaking internals.

Order of work (cheap and unauthenticated checks first):
rate limit -> read body (413) -> parse JSON (400) -> validate model (400) -> AI configured (503)
-> concurrency slot (429) -> daily quota (429) -> service call.

The first five checks are `entry_guard`, one function that takes the limiter, the request model
and the body cap from its caller. The JSON handler (`_handle`) and the streaming animation
handler both call it, so the door in front of Gemini cannot differ between them. The slot, the
daily quota and the service call stay in `_handle`: a streaming handler holds its slot for the
whole stream and releases it on its own terms.

Logging: only the endpoint name and the exception class and location are logged. Never the
body, the prompt, the exception text (Pydantic puts input values in it) or the API key.

Adding a layer: define an `AiEndpoint` with its model, `body_limit` and async `run`, then
call `handle_ai_request(request, endpoint)` from a route (see `app.ai.routes`).
"""

from __future__ import annotations

import json
import logging
import traceback
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from app.ai.envelope import (
    NOT_CONFIGURED_MESSAGE,
    AiError,
    AiOk,
    AiResult,
    to_response,
    unknown_error,
)
from app.ai.limits import AiLimiter, denied_to_error
from app.ai.runtime import AiContext, AiRuntime
from app.ai.settings import GeminiConfig, ai_provider_ready, gemini_config_from_env
from app.ai.zod_compat import zod_flatten
from app.owner import get_owner_id
from app.projects import client_ip

logger = logging.getLogger("lore.ai")


@dataclass(frozen=True)
class AiEndpoint[M: BaseModel]:
    """Static description of one AI endpoint."""

    name: str
    request_model: type[M]
    body_limit: int
    run: Callable[[M, AiContext], Awaitable[AiResult]]


def invalid_request(message: str, detail: Any = None, status: int | None = None) -> AiError:
    return AiError("INVALID_REQUEST", message, detail, status=status)


async def read_limited_body(request: Request, limit: int) -> bytes | AiError:
    """Read the raw body, refusing early when it exceeds `limit` bytes.

    Content-Length is checked first. A body without it (chunked) is counted while streaming,
    so a missing or lying header cannot bypass the cap.
    """
    too_large = invalid_request("Request body is too large", status=413)
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_size = int(declared)
        except ValueError:
            return invalid_request("Invalid Content-Length header")
        if declared_size < 0:
            return invalid_request("Invalid Content-Length header")
        if declared_size > limit:
            return too_large
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            return too_large
    return bytes(body)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"unsupported JSON constant {name}")


def parse_json_body[M: BaseModel](raw: bytes, model: type[M]) -> M | AiError:
    """Parse JSON (strictly, like JavaScript) and validate it against `model`."""
    try:
        payload = json.loads(raw, parse_constant=_reject_constant)
    except (ValueError, RecursionError):  # includes UnicodeDecodeError and JSONDecodeError
        return invalid_request("Request body must be valid JSON")
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        return invalid_request("Invalid request body", zod_flatten(exc))


def _where(exc: BaseException) -> str:
    """`ExceptionClass at file:line in function` for the innermost frame; no message text."""
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return type(exc).__name__
    last = frames[-1]
    return f"{type(exc).__name__} at {last.filename}:{last.lineno} in {last.name}"


@dataclass(frozen=True)
class Accepted[M: BaseModel]:
    """A request that passed `entry_guard`: its validated model and who is asking.

    `config` is the Gemini config read at the moment the guard confirmed the provider is ready,
    `ip` is the client address and `owner` the device-token UUID the rate limits were charged to.
    """

    model: M
    config: GeminiConfig
    ip: str
    owner: uuid.UUID


async def entry_guard[M: BaseModel](
    request: Request,
    *,
    limiter: AiLimiter,
    request_model: type[M],
    body_limit: int,
) -> Accepted[M] | AiError:
    """Door shared by the JSON and the streaming handlers; stops at the first failing check.

    Order: per-minute rate (429) -> body read with a hard cap (413) -> JSON (400) -> request
    model (400) -> provider ready (503). It uses only the `limiter` it is given, so a caller with
    its own limiter does not touch another endpoint's counters. It takes no concurrency slot and
    no daily quota: those belong to the caller, which knows how long it holds them.
    """
    ip = client_ip(request)
    owner = get_owner_id(request)

    denied = limiter.check_rate(ip, str(owner))
    if denied is not None:
        return denied_to_error(denied)

    raw = await read_limited_body(request, body_limit)
    if isinstance(raw, AiError):
        return raw
    parsed = parse_json_body(raw, request_model)
    if isinstance(parsed, AiError):
        return parsed

    config = gemini_config_from_env() if ai_provider_ready() else None
    if config is None:
        return AiError("PROVIDER_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE)
    return Accepted(parsed, config, ip, owner)


async def _handle[M: BaseModel](request: Request, endpoint: AiEndpoint[M]) -> AiResult:
    limiter: AiLimiter = request.app.state.ai_limiter
    runtime: AiRuntime = request.app.state.ai_runtime

    accepted = await entry_guard(
        request,
        limiter=limiter,
        request_model=endpoint.request_model,
        body_limit=endpoint.body_limit,
    )
    if isinstance(accepted, AiError):
        return accepted

    denied = limiter.try_acquire(accepted.ip)
    if denied is not None:
        return denied_to_error(denied)
    try:
        denied = limiter.check_daily(accepted.ip)
        if denied is not None:
            return denied_to_error(denied)
        return await endpoint.run(accepted.model, AiContext(accepted.config, runtime))
    finally:
        limiter.release(accepted.ip)


async def handle_ai_request[M: BaseModel](
    request: Request, endpoint: AiEndpoint[M]
) -> JSONResponse:
    """Run the full pipeline for one request and build the HTTP response."""
    try:
        result = await _handle(request, endpoint)
    except Exception as exc:  # last line of defence; never leak internals
        logger.error("AI endpoint %s failed: %s", endpoint.name, _where(exc))
        result = unknown_error()
    if not isinstance(result, AiOk | AiError):  # a service returned the wrong thing
        logger.error("AI endpoint %s returned an invalid result", endpoint.name)
        result = unknown_error()
    return to_response(result)
