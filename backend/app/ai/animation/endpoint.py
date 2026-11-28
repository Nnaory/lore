"""Animation_Endpoint and Animation_Reader: the two HTTP doors of the animation feature.

`POST /api/v1/ai/animations` starts an animation run (`create_animation`, below); `GET
/api/v1/animations/{animation_id}` gives the owner back what a finished run published
(`get_animation`, `animations_router`; design 6.12). `animation_health` is the fragment that
`/health/ai` adds (design 6.14).

Why: this is where the pieces of the feature meet (design 6.10, order G9). The door in front of
Gemini is the shared `pipeline.entry_guard`; what is specific to animations is decided here, in an
order that makes the cheapest and the most final answers come first and that never spends a
concurrency slot, a daily quota unit, Gemini, the verifier or S3 on a request that will be refused.
The module only wires: the agent, the stream and the registry do their own work and have their own
tests, so the rules below can be read in one place.

The order of checks (Requirement 15.6). Each one stops at the first failure and answers with a
JSON envelope (`Cache-Control: no-store`), never `text/event-stream`, and leaves
`AiLimiter.in_flight()` where it was (Requirement 15.15):

1. `pipeline.entry_guard` with `app.state.animation_limiter` and `ANIMATION_BODY_BYTES`: per-minute
   rate (429), body cap (413), JSON (400), `CreateAnimationRequest` (400), Gemini ready (503
   `PROVIDER_NOT_CONFIGURED`). The guard is called through the `pipeline` module, with keyword
   arguments, so a test can spy on it (Requirement 15.5).
2. `ANIMATION_NOT_CONFIGURED` (503): `ANIMATION_ENABLED` true, bucket, verifier function and region
   set, a database engine, and a valid animation contract (`config_ready`; Requirements 15.6, 16.4,
   2.15, 36.5). Nothing past this point runs when it fails, so the flag off costs one env read.
3. `ensure_runtime`: the S3 store and the Lambda client are built on the first request that gets
   here. Building them loads no AWS package (the clients import `boto3` on first use), and
   `configure_boto_logging()` runs now, before any AWS call (Requirement 32.15).
4. `canonical_hash`, then `registry.find` in a worker thread. A row is an Idempotent_Hit: the stream
   carries `started` (`cached: true`) and `done` only, from the row, with no slot, no daily quota,
   no Gemini, no verifier and no S3 write (Requirements 18.3, 18.7).
5. `registry.count` against `app.state.animation_limits.owner_max_animations`: 422
   `ANIMATION_QUOTA_EXCEEDED` (Requirement 20.5).
6. `limiter.try_acquire` (429 `concurrency-*`), then `limiter.check_daily` (429 `daily`, with the
   slot given back). From here on a `SlotLease` owns the slot (Requirement 16.8, 16.14).
7. The stream: `RunHandle` and `AnimationStreamResponse` from `sse.py`, running
   `run_agent(run, graph=build_graph())`.

Anything unexpected before the stream is a 500 `UNKNOWN` with a fixed message and a log line that
holds only the exception class and place (Requirement 15.10). A registry failure before the stream
is a 503 `ANIMATION_STORAGE_FAILED` (Requirement 20.7). After the stream has started the run handle
and the agent own every failure (one final event, Requirement 17.4).

The slot. `try_acquire` and `SlotLease(...)` have no `await` between them, so a slot is always
owned by a lease. The lease is released by whichever of these happens: the daily quota refuses, the
response could not be built, the stream ends, the client leaves, or the response is never iterated
(`AnimationStreamResponse` and `stream` both call `RunHandle.close()`). The `finally` of
`_start_run` is the only code here that frees a slot, and it does so through the handle when there
is one, so the cancel flag and the `animation.end` line are not forgotten.

One cancel flag and one log per run. A single `asyncio.Event` goes to `RunContext.create` and to
`RunHandle`, and a single `RunLog` goes to both, so the client leaving stops a thread inside
`store.publish` at its next S3 call and `animation.start` and `animation.end` are written once.
`run.emit` is the handle's queue.

Blocking calls. `registry.find`, `registry.count`, `registry.register` (through `_BoundRegistry`,
called by the agent in a thread) and the compilation of the graph run in worker threads, so the
event loop keeps answering other requests (Requirements 15.8, 15.17).

Lazy loading (Requirement 41.1). This module imports no `langgraph` or `boto3`. `build_graph()`
imports `langgraph` and is called only when a run really starts, so an Idempotent_Hit never loads
it; the clients import `boto3` on their first AWS call. The flag off therefore leaves both out of
`sys.modules`.

The Reader (design 6.12, Requirement 21). One GET per animation, checked in this order, stopping at
the first failure, and `Cache-Control: no-store` on every answer it builds:

1. `projects.limit_ip` (a dependency, so it runs before the handler): 429
   `{"detail": "rate limit exceeded"}`. It shares its counter with the projects endpoints.
2. `reader_config_ready` (flag, bucket, region, engine; not the verifier function, Requirement
   21.12): 503 `ANIMATION_NOT_CONFIGURED` for every id, a malformed one included, with no query.
3. The id must be a lowercase UUID: otherwise 404 `{"detail": "animation not found"}`, no query.
4. `registry.get(engine, owner, id)` in a worker thread: no row, or a row of another owner, is the
   same 404 byte for byte, so an id cannot be probed for existence. Then `store.presign` in a worker
   thread. Only here is the runtime created, so a Reader call that is refused earlier loads nothing.

The id is one path segment (`{animation_id}`). A path with a slash or with nothing after the
prefix is not a Reader URL at all and gets the router's own 404. The route deliberately does not use
the `:path` converter: its regex is `.*`, which stops at a newline, so `<uuid>%0A` would reach the
handler as a valid `<uuid>`. A registry or signing failure is 503 `ANIMATION_STORAGE_FAILED`,
anything else 500 `UNKNOWN`; neither message holds a detail. The Reader never logs a URL or a body
(Requirement 21.6): the only line it can write is the class and place of an unexpected exception.

Test seams, all on the application and none a patch of a module global:
`app.state.animation_limiter` and `app.state.animation_limits` (main.py), `app.state.ai_runtime`
(the Gemini transport, shared with the JSON endpoints), `app.state.db_engine`, and
`app.state.animation_runtime`, an `AnimationRuntime` whose store, verifier, registry functions and
graph factory a test replaces. A graph factory that returns `None` makes `run_agent` use its plain
driver, so endpoint tests need no `langgraph`. The environment (`ANIMATION_*`, `AWS_REGION`) is
read on each request.
"""

from __future__ import annotations

import asyncio
import logging
import re
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import Engine

from app.ai import pipeline
from app.ai.animation import registry as registry_api
from app.ai.animation.agent import (
    AgentPublished,
    AgentResult,
    RunContext,
    StorePort,
    build_graph,
    run_agent,
)
from app.ai.animation.contract import AnimationContract, ContractOk, load_contract
from app.ai.animation.limits import (
    AnimationEnv,
    AnimationLimits,
    animation_env_from_env,
    config_ready,
    reader_config_ready,
)
from app.ai.animation.logging_ import RunLog, configure_boto_logging
from app.ai.animation.models import (
    UUID_LOWER,
    AnimationRow,
    CreateAnimationRequest,
    MainMeta,
    RuntimeVersion,
    StartedEvent,
    canonical_hash,
    reference_from_row,
)
from app.ai.animation.registry import NewRow, QuotaExceeded, Registered, RegistryError
from app.ai.animation.sse import ERROR_MESSAGES, AnimationStreamResponse, RunHandle, SlotLease
from app.ai.animation.store import PRESIGN_EXPIRES_S, S3AnimationStore, StoreError
from app.ai.animation.verifier_client import LambdaVerifierClient, VerifierPort
from app.ai.envelope import NO_STORE, AiError, AiOk, to_response, unknown_error
from app.ai.limits import ANIMATION_BODY_BYTES, AiLimiter, denied_to_error
from app.ai.runtime import AiContext, AiRuntime
from app.ai.settings import animation_models_from_env
from app.owner import get_owner_id
from app.projects import limit_ip

logger = logging.getLogger("lore.ai")

# Fixed sentences of the pre-stream refusals that the stream's `ERROR_MESSAGES` does not cover
# (design 11.1). The others come from `ERROR_MESSAGES`, so a code has one sentence everywhere.
ANIMATION_NOT_CONFIGURED_MESSAGE = "Animations are not available on this server."

# The body of every "no such animation" answer: an id that is not a UUID, a row that does not exist
# and a row of another owner must be indistinguishable (Requirement 21.4, 21.10).
ANIMATION_NOT_FOUND_DETAIL = "animation not found"

_UUID_LOWER = re.compile(UUID_LOWER)


def not_configured_error() -> AiError:
    """503 `ANIMATION_NOT_CONFIGURED`; the Reader uses the same envelope (Requirement 21.5)."""
    return AiError("ANIMATION_NOT_CONFIGURED", ANIMATION_NOT_CONFIGURED_MESSAGE)


def storage_failed_error() -> AiError:
    """503 `ANIMATION_STORAGE_FAILED`, for a registry failure before the stream (Req. 20.7)."""
    return AiError("ANIMATION_STORAGE_FAILED", ERROR_MESSAGES["ANIMATION_STORAGE_FAILED"])


def quota_exceeded_error() -> AiError:
    """422 `ANIMATION_QUOTA_EXCEEDED` before the stream (Requirement 20.5)."""
    return AiError("ANIMATION_QUOTA_EXCEEDED", ERROR_MESSAGES["ANIMATION_QUOTA_EXCEEDED"])


class RegistryApi(Protocol):
    """The registry functions the endpoint calls; `app.ai.animation.registry` fits as it is.

    Synchronous, meant for `asyncio.to_thread`, raising `RegistryError` on a database failure.
    """

    def find(self, engine: Engine, owner: uuid.UUID, request_hash: str) -> AnimationRow | None: ...

    def count(self, engine: Engine, owner: uuid.UUID) -> int: ...

    def get(self, engine: Engine, owner: uuid.UUID, animation_id: str) -> AnimationRow | None: ...

    def register(
        self, engine: Engine, row: NewRow, limits: AnimationLimits
    ) -> Registered | QuotaExceeded: ...


@dataclass
class AnimationRuntime:
    """The collaborators of a run that talk to AWS or to the database, built once per application.

    `store` and `verifier` are the real S3 and Lambda clients in production; both create their
    boto3 client on first use. `registry` is the registry module itself. `graph` returns the object
    handed to `run_agent(graph=...)`: `build_graph` in production, and a function returning `None`
    in tests, which makes the agent walk its nodes with the plain driver. The Reader uses `store`
    (`presign`) and `registry` (`get`) of the same runtime.
    """

    store: StorePort
    verifier: VerifierPort
    registry: RegistryApi = field(default=registry_api)
    graph: Callable[[], Any] = field(default=build_graph)


@dataclass(frozen=True)
class _BoundRegistry:
    """`RegistryPort` for the agent: `registry.register` with this request's engine and limits."""

    api: RegistryApi
    engine: Engine
    limits: AnimationLimits

    def register(self, row: NewRow) -> Registered | QuotaExceeded:
        return self.api.register(self.engine, row, self.limits)


def ensure_runtime(application: FastAPI, env: AnimationEnv) -> AnimationRuntime:
    """The application's `AnimationRuntime`, created on the first call (Requirement 41.1).

    Call it only after the configuration checks passed, so the bucket, the function and the region
    are set. Creating it loads no AWS package. It also holds the AWS loggers at WARNING before any
    AWS call can be made. No `await` happens here, so two first requests cannot both create it.
    """
    runtime = getattr(application.state, "animation_runtime", None)
    if runtime is None:
        configure_boto_logging()
        runtime = AnimationRuntime(
            store=S3AnimationStore(env.bucket, env.region),
            verifier=LambdaVerifierClient(env.verifier_function, env.region),
        )
        application.state.animation_runtime = runtime
    return runtime


def engine_of(application: FastAPI) -> Engine | None:
    """The application's database engine, or `None` when there is none (not configured)."""
    engine = getattr(application.state, "db_engine", None)
    return engine if isinstance(engine, Engine) else None


def _where(exc: BaseException) -> str:
    """`ExceptionClass at file:line in function`; never the message (it may quote user data)."""
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return type(exc).__name__
    last = frames[-1]
    return f"{type(exc).__name__} at {last.filename}:{last.lineno} in {last.name}"


async def create_animation(request: Request) -> Response:
    """Answer `POST /api/v1/ai/animations`: a JSON refusal or the SSE stream of one run.

    Never raises: an unexpected exception before the stream is a 500 `UNKNOWN` (Requirement 15.10).
    """
    try:
        return await _create(request)
    except Exception as exc:  # the last line of defence; never leak internals
        logger.error("animation endpoint failed: %s", _where(exc))
        return to_response(unknown_error())


async def _create(request: Request) -> Response:
    application = request.app
    limiter: AiLimiter = application.state.animation_limiter

    accepted = await pipeline.entry_guard(
        request,
        limiter=limiter,
        request_model=CreateAnimationRequest,
        body_limit=ANIMATION_BODY_BYTES,
    )
    if isinstance(accepted, AiError):
        return to_response(accepted)

    env = animation_env_from_env()
    engine = engine_of(application)
    loaded = load_contract()
    if not config_ready(env, engine is not None, isinstance(loaded, ContractOk)):
        return to_response(not_configured_error())
    assert engine is not None and isinstance(loaded, ContractOk)  # what `config_ready` just said
    contract = loaded.contract

    runtime = ensure_runtime(application, env)
    limits: AnimationLimits = application.state.animation_limits
    request_hash = canonical_hash(accepted.model, contract.contract_version)

    try:
        row = await asyncio.to_thread(runtime.registry.find, engine, accepted.owner, request_hash)
        owned = 0
        if row is None:
            owned = await asyncio.to_thread(runtime.registry.count, engine, accepted.owner)
    except RegistryError:
        return to_response(storage_failed_error())

    started = StartedEvent(
        max_attempts=env.max_attempts, deadline_ms=env.deadline_ms, cached=row is not None
    )
    if row is not None:
        return _cached_response(accepted.model, row, started)
    if owned >= limits.owner_max_animations:
        return to_response(quota_exceeded_error())

    return await _start_run(
        request,
        accepted=accepted,
        env=env,
        contract=contract,
        runtime=runtime,
        engine=engine,
        limits=limits,
        request_hash=request_hash,
        started=started,
    )


def _cached_response(
    model: CreateAnimationRequest, row: AnimationRow, started: StartedEvent
) -> Response:
    """The stream of an Idempotent_Hit: `started` and `done` from the row, and nothing else.

    No slot (there is no lease), no daily quota, no Gemini, no verifier, no S3 write. The work is
    an `AgentPublished` built from the row with `calls=0`, so the log says `attempts: 0` while
    `done.attempts` is the value recorded on the row (Requirement 17.12, design G13).
    """
    reference = reference_from_row(row)

    async def work() -> AgentResult:
        return AgentPublished(reference=reference, row=row, calls=0, model=row.model)

    handle = RunHandle(started=started, work=work, lease=None, log=RunLog(model.kind, True))
    return AnimationStreamResponse(handle)


async def _start_run(
    request: Request,
    *,
    accepted: pipeline.Accepted[CreateAnimationRequest],
    env: AnimationEnv,
    contract: AnimationContract,
    runtime: AnimationRuntime,
    engine: Engine,
    limits: AnimationLimits,
    request_hash: str,
    started: StartedEvent,
) -> Response:
    """Take the slot and the daily quota, then build the run and its stream response."""
    application = request.app
    limiter: AiLimiter = application.state.animation_limiter
    ip = accepted.ip

    denied = limiter.try_acquire(ip)
    if denied is not None:
        return to_response(denied_to_error(denied))
    lease = SlotLease(limiter, ip)  # no await since `try_acquire`: the slot always has an owner
    handle: RunHandle | None = None
    response: Response | None = None
    try:
        denied = limiter.check_daily(ip)
        if denied is not None:
            return to_response(denied_to_error(denied))

        graph = await asyncio.to_thread(runtime.graph)
        cancelled = asyncio.Event()
        log = RunLog(accepted.model.kind, False)
        run = RunContext.create(
            accepted.model,
            contract=contract,
            owner_id=accepted.owner,
            request_hash=request_hash,
            ai=AiContext(accepted.config, _ai_runtime(application)),
            models=animation_models_from_env(),
            verifier=runtime.verifier,
            store=runtime.store,
            registry=_BoundRegistry(runtime.registry, engine, limits),
            max_attempts=env.max_attempts,
            deadline_ms=env.deadline_ms,
            cancelled=cancelled,
            log=log,
        )

        async def work() -> AgentResult:
            return await run_agent(run, graph=graph)

        handle = RunHandle(started=started, work=work, lease=lease, log=log, cancelled=cancelled)
        run.emit = handle.emit
        response = AnimationStreamResponse(handle)
        return response
    finally:
        if response is None:  # refused, failed or cancelled before a response owned the lease
            if handle is not None:
                handle.close()
            else:
                lease.release()


def _ai_runtime(application: FastAPI) -> AiRuntime:
    """The shared Gemini runtime (`app.state.ai_runtime`), where tests inject the transport."""
    runtime: AiRuntime = application.state.ai_runtime
    return runtime


# --- Animation_Reader ----------------------------------------------------------------------------

# Not in the OpenAPI document, like the POST route: the feature is behind a flag.
animations_router = APIRouter(prefix="/api/v1/animations", tags=["animations"])


def not_found_response() -> JSONResponse:
    """The one 404 of the Reader: same status, body and headers for every kind of miss.

    It is built here and not with `HTTPException` so `Cache-Control: no-store` is certain
    (Requirement 21.11); the body is what FastAPI would have written for
    `HTTPException(404, "animation not found")`.
    """
    return JSONResponse({"detail": ANIMATION_NOT_FOUND_DETAIL}, 404, headers=NO_STORE)


def _reader_data(row: AnimationRow, urls: dict[str, str]) -> dict[str, Any]:
    """The `data` of a successful Reader answer (design 10.7), taken from the row and the URLs.

    `animation` comes from `reference_from_row`, the function the `done` event and the agent use,
    so the three cannot differ and `pause_at_frame` is absent unless the row has one. `manifest` is
    the summary of Requirement 21.2: eight columns of the row and nothing else (no `checks`,
    `warnings`, `request_hash` or `created_at`). `meta` and `runtime_version` pass through their
    models so the answer has the documented shape whatever the stored JSON holds.
    """
    return {
        "animation": reference_from_row(row).dump(),
        "manifest": {
            "contract_version": row.contract_version,
            "runtime_version": RuntimeVersion.model_validate(row.runtime_version).dump(),
            "source_bytes": row.source_bytes,
            "bundle_bytes": row.bundle_bytes,
            "meta": MainMeta.model_validate(row.meta).dump(),
            "verifier_version": row.verifier_version,
            "model": row.model,
            "attempts": row.attempts,
        },
        "urls": {"bundle": urls["bundle"], "manifest": urls["manifest"]},
        "expires_in": PRESIGN_EXPIRES_S,
    }


async def _read(animation_id: str, request: Request) -> Response:
    application = request.app
    env = animation_env_from_env()
    engine = engine_of(application)
    if not reader_config_ready(env, engine is not None):
        return to_response(not_configured_error())
    assert engine is not None  # what `reader_config_ready` just said
    if _UUID_LOWER.fullmatch(animation_id) is None:
        return not_found_response()

    runtime = ensure_runtime(application, env)
    owner = get_owner_id(request)
    try:
        row = await asyncio.to_thread(runtime.registry.get, engine, owner, animation_id)
        if row is None:
            return not_found_response()
        urls = await asyncio.to_thread(runtime.store.presign, row.source_sha256)
    except (RegistryError, StoreError):
        return to_response(storage_failed_error())
    return to_response(AiOk(_reader_data(row, urls)))


@animations_router.get("/{animation_id}", include_in_schema=False, dependencies=[Depends(limit_ip)])
async def get_animation(animation_id: str, request: Request) -> Response:
    """Animation_Reader: the owner's animation as a reference, a manifest summary and two URLs.

    Never raises: an unexpected exception is a 500 `UNKNOWN` whose log line holds only the class
    and place of the exception, never the URLs or the body (Requirement 21.6).
    """
    try:
        return await _read(animation_id, request)
    except Exception as exc:  # the last line of defence; never leak internals
        logger.error("animation reader failed: %s", _where(exc))
        return to_response(unknown_error())


# --- health --------------------------------------------------------------------------------------


def animation_health(application: FastAPI) -> dict[str, bool]:
    """The `animation` part of `/health/ai` (design 6.14, Requirement 16.9, 16.12).

    `enabled` is the flag. `configured` is `config_ready`, the same check that lets the POST
    endpoint run: the flag, bucket, verifier function and region, a database engine and a valid
    contract. It only reads the environment and the cached contract: no Gemini call, no AWS call,
    no runtime is created.
    """
    env = animation_env_from_env()
    contract_ok = isinstance(load_contract(), ContractOk)
    return {
        "enabled": env.enabled,
        "configured": config_ready(env, engine_of(application) is not None, contract_ok),
    }
