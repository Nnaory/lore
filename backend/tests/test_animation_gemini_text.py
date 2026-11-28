"""Tests for the Gemini text mode (`generate_text`) and its parity with `generate_json`.

Why: the animation agent needs plain text (TypeScript source) from the same client that already
handles model fallback, retries, deadlines and key hiding for JSON (Requirement 4). The riskiest
part is the shared code path, so these tests pin three things on `httpx2.MockTransport` (no real
network, no DNS): the default JSON request body stays byte-identical, JSON and text mode count
the same POSTs, `sleep` calls and failure codes in every failure scenario (Requirement 4.12),
and a sentinel API key never leaks in text mode (Requirement 4.13). Sleep and the clock are
injected so retries and deadlines run instantly.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx2
import pytest

from app.ai.gemini_client import (
    GeminiFailure,
    GeminiOk,
    GeminiRequest,
    GeminiResult,
    GeminiTextOk,
    GeminiTextResult,
    generate_json,
    generate_text,
)
from app.ai.runtime import AiContext, AiRuntime
from app.ai.settings import DEFAULT_MODELS, GeminiConfig, animation_models_from_env

KEY = "AIza-sentinel-key-4f9c2e71"
SYSTEM = "SYSTEM-SENTINEL"
PROMPT = "PROMPT-SENTINEL"
REQUEST = GeminiRequest(system=SYSTEM, prompt=PROMPT, max_output_tokens=100, temperature=0.5)
APP_DIR = Path(__file__).resolve().parents[1] / "app"

Mode = Literal["json", "text"]
MODES: tuple[Mode, ...] = ("json", "text")
Script = list[httpx2.Response | Exception]


def make_config(**overrides: Any) -> GeminiConfig:
    values: dict[str, Any] = {
        "api_key": KEY,
        "models": ("m1", "m2"),
        "timeout_ms": 10_000,
        "attempts_per_model": 2,
        "backoff_ms": 1_000,
        "deadline_ms": 100_000,
    }
    values.update(overrides)
    return GeminiConfig(**values)


def ok_body(text: str = '{"a": 1}', finish: str | None = "STOP", **extra: Any) -> dict[str, Any]:
    candidate: dict[str, Any] = {"content": {"parts": [{"text": text}]}}
    if finish is not None:
        candidate["finishReason"] = finish
    return {
        "candidates": [candidate],
        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 7},
        **extra,
    }


def parts_body(parts: list[Any], finish: str | None = "STOP") -> dict[str, Any]:
    candidate: dict[str, Any] = {"content": {"parts": parts}}
    if finish is not None:
        candidate["finishReason"] = finish
    return {"candidates": [candidate]}


def reply(status: int, body: Any) -> httpx2.Response:
    return httpx2.Response(status, json=body)


@dataclass
class Outcome:
    """What one call did: the result plus every POST and every `sleep` argument."""

    result: GeminiResult | GeminiTextResult
    requests: list[httpx2.Request]
    sleeps: list[float]

    @property
    def models(self) -> list[str]:
        return [r.url.path.split("/")[-1].split(":")[0] for r in self.requests]

    @property
    def code(self) -> str | None:
        return None if self.result.ok else self.result.code  # type: ignore[union-attr]

    @property
    def detail(self) -> list[dict[str, Any]]:
        assert isinstance(self.result, GeminiFailure)
        return self.result.detail


def run(
    mode: Mode,
    script: Script,
    *,
    request: GeminiRequest = REQUEST,
    config: GeminiConfig | None = None,
    **config_overrides: Any,
) -> Outcome:
    """Run `generate_json` or `generate_text` against a scripted sequence of replies."""
    items = list(script)
    requests: list[httpx2.Request] = []
    sleeps: list[float] = []
    clock = [0.0]

    def handler(req: httpx2.Request) -> httpx2.Response:
        requests.append(req)
        item = items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    async def go() -> GeminiResult | GeminiTextResult:
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as client:
            fn = generate_json if mode == "json" else generate_text
            return await fn(
                request,
                config or make_config(**config_overrides),
                client=client,
                sleep=fake_sleep,
                monotonic=lambda: clock[0],
            )

    return Outcome(asyncio.run(go()), requests, sleeps)


# --- request body ------------------------------------------------------------------------------

GOLDEN_PROMPT = "h\u00e9llo"
# Exactly what the client sent before text mode existed (`json.dumps` defaults, key order).
GOLDEN_JSON_BODY = (
    b'{"systemInstruction": {"parts": [{"text": "sys"}]}, '
    b'"contents": [{"role": "user", "parts": [{"text": "h\\u00e9llo"}]}], '
    b'"generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 100, '
    b'"temperature": 0.5}}'
)
GOLDEN_JSON_BODY_NO_TEMPERATURE = (
    b'{"systemInstruction": {"parts": [{"text": "sys"}]}, '
    b'"contents": [{"role": "user", "parts": [{"text": "h\\u00e9llo"}]}], '
    b'"generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 100}}'
)


def test_response_format_is_the_last_field_and_defaults_to_json() -> None:
    names = [f.name for f in dataclasses.fields(GeminiRequest)]
    assert names == ["system", "prompt", "max_output_tokens", "temperature", "response_format"]
    assert GeminiRequest("s", "p", 5).response_format == "json"
    assert GeminiRequest("s", "p", 5, 0.2).response_format == "json"


@pytest.mark.parametrize(
    ("request_", "golden"),
    [
        (GeminiRequest("sys", GOLDEN_PROMPT, 100, 0.5), GOLDEN_JSON_BODY),
        (GeminiRequest("sys", GOLDEN_PROMPT, 100), GOLDEN_JSON_BODY_NO_TEMPERATURE),
        (GeminiRequest("sys", GOLDEN_PROMPT, 100, 0.5, "json"), GOLDEN_JSON_BODY),
    ],
    ids=["default", "no-temperature", "explicit-json"],
)
def test_generate_json_body_is_byte_identical_to_before(
    request_: GeminiRequest, golden: bytes
) -> None:
    out = run("json", [reply(200, ok_body())], request=request_)
    assert isinstance(out.result, GeminiOk)
    assert out.requests[0].content == golden


def test_generate_text_body_differs_only_in_mime_type() -> None:
    out = run(
        "text", [reply(200, ok_body("hi"))], request=GeminiRequest("sys", GOLDEN_PROMPT, 100, 0.5)
    )
    assert isinstance(out.result, GeminiTextOk)
    sent = out.requests[0]
    assert sent.content == GOLDEN_JSON_BODY.replace(b"application/json", b"text/plain")
    assert json.loads(sent.content)["generationConfig"] == {
        "responseMimeType": "text/plain",
        "maxOutputTokens": 100,
        "temperature": 0.5,
    }
    assert sent.method == "POST"
    assert str(sent.url) == (
        "https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent"
    )
    assert sent.headers["x-goog-api-key"] == KEY
    assert sent.headers["content-type"] == "application/json"


def test_each_public_function_forces_its_own_format() -> None:
    as_text = GeminiRequest("s", "p", 5, response_format="text")
    json_out = run("json", [reply(200, ok_body())], request=as_text)
    assert isinstance(json_out.result, GeminiOk)
    assert json.loads(json_out.requests[0].content)["generationConfig"]["responseMimeType"] == (
        "application/json"
    )
    text_out = run("text", [reply(200, ok_body("x"))], request=GeminiRequest("s", "p", 5))
    assert isinstance(text_out.result, GeminiTextOk)
    assert json.loads(text_out.requests[0].content)["generationConfig"]["responseMimeType"] == (
        "text/plain"
    )


# --- parity between JSON mode and text mode ----------------------------------------------------


@dataclass(frozen=True)
class Scenario:
    id: str
    script: Callable[[], Script]
    posts: int
    models: tuple[str, ...]
    sleeps: tuple[float, ...]
    code: str | None  # None means the call succeeds
    config: dict[str, Any] = field(default_factory=dict)


SCENARIOS = [
    Scenario(
        "429-then-200",
        lambda: [reply(429, {"error": {"message": "slow down"}}), reply(200, ok_body())],
        2,
        ("m1", "m1"),
        (1.0,),
        None,
    ),
    Scenario(
        "500-then-200",
        lambda: [reply(500, {}), reply(200, ok_body())],
        2,
        ("m1", "m1"),
        (1.0,),
        None,
    ),
    Scenario(
        "400",
        lambda: [reply(400, {"error": {"message": "bad"}})] * 2,
        2,
        ("m1", "m2"),
        (),
        "PROVIDER_UNAVAILABLE",
    ),
    Scenario(
        "404",
        lambda: [reply(404, {"error": {"message": "no model"}})] * 2,
        2,
        ("m1", "m2"),
        (),
        "PROVIDER_UNAVAILABLE",
    ),
    Scenario(
        "401",
        lambda: [reply(401, {"error": {"message": "denied"}})],
        1,
        ("m1",),
        (),
        "PROVIDER_UNAVAILABLE",
    ),
    Scenario(
        "403",
        lambda: [reply(403, {"error": {"message": "denied"}})],
        1,
        ("m1",),
        (),
        "PROVIDER_UNAVAILABLE",
    ),
    Scenario(
        "timeout",
        lambda: [httpx2.ReadTimeout("slow"), httpx2.ConnectTimeout("slow")],
        2,
        ("m1", "m2"),
        (),
        "TIMEOUT",
    ),
    Scenario(
        "network-error",
        lambda: [httpx2.ConnectError("boom")] * 4,
        4,
        ("m1", "m1", "m2", "m2"),
        (1.0, 1.0),
        "PROVIDER_UNAVAILABLE",
    ),
    Scenario(
        "deadline-exhausted",
        lambda: [reply(503, {})] * 10,
        2,
        ("m1", "m1"),
        (1.0, 2.0),
        "PROVIDER_UNAVAILABLE",
        {"deadline_ms": 1_500, "attempts_per_model": 3, "backoff_ms": 1_000},
    ),
    Scenario(
        "429-everywhere",
        lambda: [reply(429, {})] * 4,
        4,
        ("m1", "m1", "m2", "m2"),
        (1.0, 1.0),
        "RATE_LIMITED",
    ),
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.id)
def test_json_and_text_modes_do_the_same_work(scenario: Scenario) -> None:
    outcomes = {mode: run(mode, scenario.script(), **scenario.config) for mode in MODES}
    for out in outcomes.values():
        assert len(out.requests) == scenario.posts
        assert out.models == list(scenario.models)
        assert out.sleeps == list(scenario.sleeps)
        assert out.code == scenario.code
    json_out, text_out = outcomes["json"], outcomes["text"]
    if scenario.code is None:
        assert isinstance(json_out.result, GeminiOk)
        assert isinstance(text_out.result, GeminiTextOk)
        assert json_out.result.model == text_out.result.model
        assert json_out.result.usage == text_out.result.usage
    else:
        assert isinstance(json_out.result, GeminiFailure)
        assert isinstance(text_out.result, GeminiFailure)
        assert json_out.result.message == text_out.result.message
        assert json_out.detail == text_out.detail


def test_json_mode_keeps_treating_whitespace_only_text_as_bad_json() -> None:
    # Only text mode trims before the emptiness check; JSON mode must behave as it always did.
    out = run("json", [reply(200, ok_body("  \n"))] * 4)
    assert isinstance(out.result, GeminiFailure)
    assert out.code == "OUTPUT_PARSE_FAILED"
    assert out.detail[0]["reason"] == "response was not valid JSON (finishReason: STOP)"


# --- generate_text -----------------------------------------------------------------------------


def test_text_parts_are_joined_as_is_without_trim_or_fence_stripping() -> None:
    parts = [
        {"text": "  ```ts\n"},
        {"text": "plan", "thought": True},
        {"text": "const a = 1;\n"},
        "not a part",
        {"text": 5},
        {"inlineData": {}},
        {"text": "```\n\n"},
    ]
    out = run("text", [reply(200, parts_body(parts))])
    assert isinstance(out.result, GeminiTextOk)
    assert out.result.text == "  ```ts\nconst a = 1;\n```\n\n"
    assert out.result.model == "m1"
    assert out.result.ok is True


def test_text_that_looks_like_invalid_json_is_a_success() -> None:
    out = run("text", [reply(200, ok_body("not json at all"))])
    assert isinstance(out.result, GeminiTextOk)
    assert out.result.text == "not json at all"
    assert len(out.requests) == 1


def test_success_reports_usage_latency_and_finish_reason() -> None:
    out = run("text", [reply(200, ok_body("x", finish="STOP"))])
    result = out.result
    assert isinstance(result, GeminiTextOk)
    assert (result.usage.prompt_tokens, result.usage.output_tokens) == (3, 4)
    assert result.usage.total_tokens == 7
    assert result.finish_reason == "STOP"
    assert result.latency_ms == 0.0


def test_missing_finish_reason_is_none_and_missing_usage_is_empty() -> None:
    out = run("text", [reply(200, parts_body([{"text": "x"}], finish=None))])
    assert isinstance(out.result, GeminiTextOk)
    assert out.result.finish_reason == "none"
    assert out.result.usage.total_tokens is None


def test_max_tokens_finish_reason_is_still_a_success() -> None:
    out = run("text", [reply(200, ok_body("const cut = ", finish="MAX_TOKENS"))])
    assert isinstance(out.result, GeminiTextOk)
    assert out.result.finish_reason == "MAX_TOKENS"
    assert out.result.text == "const cut = "
    assert len(out.requests) == 1
    assert out.sleeps == []


def test_empty_and_whitespace_only_text_is_retried_then_succeeds() -> None:
    script: Script = [
        reply(200, parts_body([], finish="MAX_TOKENS")),
        reply(200, ok_body(" \n\t ")),
        reply(200, ok_body("done\n")),
    ]
    out = run("text", script, models=("m1",), attempts_per_model=3)
    assert isinstance(out.result, GeminiTextOk)
    assert out.result.text == "done\n"
    assert out.models == ["m1", "m1", "m1"]
    assert out.sleeps == [1.0, 2.0]


def test_empty_text_everywhere_is_provider_unavailable_with_empty_reasons() -> None:
    script: Script = [
        reply(200, parts_body([], finish="MAX_TOKENS")),
        reply(200, ok_body("   ")),
        reply(200, {"candidates": []}),
        reply(200, parts_body([{"text": "hidden", "thought": True}])),
    ]
    out = run("text", script)
    assert isinstance(out.result, GeminiFailure)
    assert out.code == "PROVIDER_UNAVAILABLE"
    assert [d["reason"] for d in out.detail] == [
        "empty response (finishReason: MAX_TOKENS)",
        "empty response (finishReason: STOP)",
        "empty response (finishReason: none)",
        "empty response (finishReason: STOP)",
    ]
    assert out.models == ["m1", "m1", "m2", "m2"]
    assert out.sleeps == [1.0, 1.0]


@pytest.mark.parametrize(
    "script_factory",
    [
        lambda: [reply(200, ok_body("   "))] * 4,
        lambda: [reply(400, {"error": {"message": "Request body is not valid JSON"}})] * 2,
        lambda: [reply(503, {"error": {"message": "payload is not valid JSON"}})] * 4,
        lambda: [httpx2.ConnectError("boom")] * 4,
        lambda: [reply(200, ok_body("   "))] * 2 + [reply(429, {})] * 2,
    ],
    ids=["empty", "400-mentions-json", "503-mentions-json", "network", "empty-then-429"],
)
def test_text_mode_never_reports_output_parse_failed(
    script_factory: Callable[[], Script],
) -> None:
    out = run("text", script_factory())
    assert isinstance(out.result, GeminiFailure)
    assert out.code in {"RATE_LIMITED", "TIMEOUT", "PROVIDER_UNAVAILABLE"}


def test_text_mode_rate_limit_classification_matches_json_mode() -> None:
    def script() -> Script:
        return [reply(200, ok_body("  ")), reply(429, {}), reply(429, {}), reply(429, {})]

    assert run("text", script()).code == "RATE_LIMITED"
    assert run("json", script()).code == "RATE_LIMITED"


def test_text_mode_creates_and_closes_its_own_client(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[httpx2.AsyncClient] = []
    real = httpx2.AsyncClient
    transport = httpx2.MockTransport(lambda _r: reply(200, ok_body("hello")))

    def factory(*args: Any, **kwargs: Any) -> httpx2.AsyncClient:
        instance = real(*args, transport=transport, **kwargs)
        created.append(instance)
        return instance

    monkeypatch.setattr(httpx2, "AsyncClient", factory)
    result = asyncio.run(generate_text(REQUEST, make_config()))
    assert isinstance(result, GeminiTextOk)
    assert len(created) == 1
    assert created[0].is_closed


def test_ai_context_generate_text_forwards_client_sleep_and_clock() -> None:
    sleeps: list[float] = []
    script: Script = [reply(429, {}), reply(200, ok_body("from context"))]
    requests: list[httpx2.Request] = []

    def handler(req: httpx2.Request) -> httpx2.Response:
        requests.append(req)
        item = script.pop(0)
        assert isinstance(item, httpx2.Response)
        return item

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    async def go() -> GeminiTextResult:
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as client:
            runtime = AiRuntime(http_client=client, sleep=fake_sleep, monotonic=lambda: 0.0)
            return await AiContext(make_config(), runtime).generate_text(REQUEST)

    result = asyncio.run(go())
    assert isinstance(result, GeminiTextOk)
    assert result.text == "from context"
    assert sleeps == [1.0]
    assert len(requests) == 2


# --- sentinel API key (Requirement 4.13) -------------------------------------------------------

LEAKY = f"Illegal header value b'{KEY}'"
SENTINEL_SCENARIOS: dict[str, Callable[[], Script]] = {
    "success": lambda: [reply(200, ok_body("generated"))],
    "401": lambda: [reply(401, {"error": {"message": "API key not valid"}})],
    "429": lambda: [reply(429, {"error": {"message": "quota"}})] * 4,
    "timeout": lambda: [httpx2.ReadTimeout(f"slow {KEY}")] * 2,
    "local-protocol-error": lambda: [httpx2.LocalProtocolError(LEAKY)],
}


@pytest.mark.parametrize("name", SENTINEL_SCENARIOS)
def test_sentinel_key_never_leaks_in_text_mode(name: str, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    config = make_config()
    out = run("text", SENTINEL_SCENARIOS[name](), config=config)

    assert KEY not in repr(out.result)
    assert KEY not in repr(config)
    if isinstance(out.result, GeminiFailure):
        assert KEY not in json.dumps(out.detail)
        assert KEY not in out.result.message
    # The key travels only in the header, never in the URL or the body.
    for sent in out.requests:
        assert sent.headers["x-goog-api-key"] == KEY
        assert KEY not in str(sent.url)
        assert KEY.encode() not in sent.content
    assert KEY not in caplog.text
    assert PROMPT not in caplog.text
    assert SYSTEM not in caplog.text


def test_local_protocol_error_is_fatal_in_text_mode_and_its_text_is_not_used() -> None:
    out = run("text", [httpx2.LocalProtocolError(LEAKY)] * 4)
    assert isinstance(out.result, GeminiFailure)
    assert out.code == "PROVIDER_UNAVAILABLE"
    assert len(out.requests) == 1  # fatal: no retry, no next model
    assert out.detail == [
        {"model": "m1", "reason": "API key is not a valid header value (check GOOGLE_API_KEY)"}
    ]
    assert out.sleeps == []


def test_text_mode_does_not_raise_for_expected_failures() -> None:
    # Every failure scenario returns a result; an exception would fail the call and show here.
    for factory in SENTINEL_SCENARIOS.values():
        run("text", factory())


# --- one Gemini client only (Requirements 4.8, 39.1) -------------------------------------------


def test_gemini_endpoint_host_appears_only_in_gemini_client() -> None:
    host = "generativelanguage.googleapis.com"
    hits = sorted(
        path.relative_to(APP_DIR).as_posix()
        for path in APP_DIR.rglob("*.py")
        if host in path.read_text(encoding="utf-8")
    )
    assert hits == ["ai/gemini_client.py"]


# --- animation_models_from_env (Requirement 4.6) -----------------------------------------------


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, DEFAULT_MODELS),
        ({"AI_MODEL": "a,b"}, ("a", "b")),
        ({"AI_ANIMATION_MODEL": "x,y", "AI_MODEL": "a,b"}, ("x", "y")),
        ({"AI_ANIMATION_MODEL": " x , ,y ,, "}, ("x", "y")),
        ({"AI_ANIMATION_MODEL": " , ,", "AI_MODEL": " a ,b "}, ("a", "b")),
        ({"AI_ANIMATION_MODEL": "", "AI_MODEL": ""}, DEFAULT_MODELS),
        ({"AI_ANIMATION_MODEL": "   ", "AI_MODEL": ", ,"}, DEFAULT_MODELS),
        ({"AI_ANIMATION_MODEL": "only"}, ("only",)),
    ],
    ids=[
        "defaults",
        "ai-model",
        "animation-wins",
        "trim-and-drop-empty",
        "blank-animation-falls-back",
        "both-empty",
        "both-blank",
        "single",
    ],
)
def test_animation_models_from_env(env: dict[str, str], expected: tuple[str, ...]) -> None:
    assert animation_models_from_env(env) == expected


def test_animation_models_from_env_reads_process_env_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AI_MODEL", raising=False)
    monkeypatch.setenv("AI_ANIMATION_MODEL", "from-os-environ")
    assert animation_models_from_env() == ("from-os-environ",)
