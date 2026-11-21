"""Runtime dependencies of an AI call: Gemini config plus injectable I/O.

Why: services need the Gemini config and a way to call Gemini, and tests must replace the
network, the sleep between retries and the clock without patching module globals. `AiRuntime`
lives in `app.state.ai_runtime` (created in `create_app`); tests set `http_client` to an
`httpx2.AsyncClient(transport=httpx2.MockTransport(...))` and `sleep` to a fake. Production leaves
the defaults, so each call opens its own client.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx2

from app.ai.gemini_client import GeminiRequest, GeminiResult, Sleep, generate_json
from app.ai.settings import GeminiConfig


@dataclass
class AiRuntime:
    """Replaceable I/O for AI calls."""

    http_client: httpx2.AsyncClient | None = None
    sleep: Sleep = asyncio.sleep
    monotonic: Callable[[], float] = field(default=time.monotonic)


@dataclass(frozen=True)
class AiContext:
    """What a service needs to call Gemini for one request."""

    config: GeminiConfig
    runtime: AiRuntime

    async def generate_json(self, request: GeminiRequest) -> GeminiResult:
        return await generate_json(
            request,
            self.config,
            client=self.runtime.http_client,
            sleep=self.runtime.sleep,
            monotonic=self.runtime.monotonic,
        )
