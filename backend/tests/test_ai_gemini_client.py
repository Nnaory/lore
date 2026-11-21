"""Tests for the async Gemini client using httpx2.MockTransport (no real network).

Sleep and the clock are injected so retries and deadlines run instantly.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

import httpx2
import pytest

from app.ai.gemini_client import (
    GeminiFailure,
    GeminiOk,
    GeminiRequest,
    GeminiResult,
    generate_json,
    parse_json_text,
)
from app.ai.settings import GeminiConfig

KEY = "AIza-super-secret-key"
REQUEST = GeminiRequest(system="sys", prompt="hello", max_output_tokens=100, temperature=0.5)


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


def ok_body(text: str = '{"a": 1}', **extra: Any) -> dict[str, Any]:
    return {
        "candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 7},
        **extra,
    }


class Harness:
    """Runs generate_json against a scripted handler with fake sleep and clock."""

    def __init__(self, handler: Callable[[httpx2.Request], httpx2.Response]) -> None:
        self.requests: list[httpx2.Request] = []
        self.sleeps: list[float] = []
        self.now = 0.0

        def wrapped(request: httpx2.Request) -> httpx2.Response:
            self.requests.append(request)
            return handler(request)

        self.transport = httpx2.MockTransport(wrapped)

    async def _sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def run(self, config: GeminiConfig | None = None) -> GeminiResult:
        async def go() -> GeminiResult:
            async with httpx2.AsyncClient(transport=self.transport) as client:
                return await generate_json(
                    REQUEST,
                    config or make_config(),
                    client=client,
                    sleep=self._sleep,
                    monotonic=lambda: self.now,
                )

        return asyncio.run(go())

    def models(self) -> list[str]:
        return [r.url.path.split("/")[-1].split(":")[0] for r in self.requests]


def sequence(
    *responses: httpx2.Response | Exception,
) -> Callable[[httpx2.Request], httpx2.Response]:
    items = list(responses)

    def handler(_request: httpx2.Request) -> httpx2.Response:
        item = items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    return handler


def json_response(status: int, body: Any) -> httpx2.Response:
    return httpx2.Response(status, json=body)


def test_success_sends_expected_request() -> None:
    h = Harness(sequence(json_response(200, ok_body())))
    result = h.run()
    assert isinstance(result, GeminiOk)
    assert result.json == {"a": 1}
    assert result.model == "m1"
    assert (result.usage.prompt_tokens, result.usage.output_tokens) == (3, 4)
    assert result.usage.total_tokens == 7
    request = h.requests[0]
    assert request.method == "POST"
    assert str(request.url) == (
        "https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent"
    )
    assert request.headers["x-goog-api-key"] == KEY
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {
        "systemInstruction": {"parts": [{"text": "sys"}]},
        "contents": [{"role": "user", "parts": [{"text": "hello"}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "maxOutputTokens": 100,
            "temperature": 0.5,
        },
    }


def test_temperature_omitted_when_none_and_model_is_quoted() -> None:
    h = Harness(sequence(json_response(200, ok_body())))
    request = GeminiRequest(system="s", prompt="p", max_output_tokens=5)

    async def go() -> GeminiResult:
        async with httpx2.AsyncClient(transport=h.transport) as client:
            return await generate_json(request, make_config(models=("a/b c",)), client=client)

    assert isinstance(asyncio.run(go()), GeminiOk)
    assert "temperature" not in json.loads(h.requests[0].content)["generationConfig"]
    assert h.requests[0].url.raw_path.decode().endswith("/a%2Fb%20c:generateContent")


def test_thought_parts_ignored_and_code_fence_stripped() -> None:
    body = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {"text": "thinking...", "thought": True},
                        {"text": '```json\n{"x": '},
                        {"text": "2}\n```"},
                    ]
                }
            }
        ]
    }
    result = Harness(sequence(json_response(200, body))).run()
    assert isinstance(result, GeminiOk)
    assert result.json == {"x": 2}
    assert result.usage.total_tokens is None


def test_parse_json_text_variants() -> None:
    assert parse_json_text("```JSON\n[1]\n```") == [1]
    assert parse_json_text('  {"a": true} ') == {"a": True}
    with pytest.raises(ValueError):
        parse_json_text("nope")


def test_rate_limit_then_success_backs_off() -> None:
    h = Harness(
        sequence(
            json_response(429, {"error": {"message": "slow down"}}),
            json_response(200, ok_body()),
        )
    )
    result = h.run()
    assert isinstance(result, GeminiOk)
    assert h.models() == ["m1", "m1"]
    assert h.sleeps == [1.0]


def test_backoff_grows_with_attempt() -> None:
    h = Harness(
        sequence(json_response(500, {}), json_response(500, {}), json_response(200, ok_body()))
    )
    result = h.run(make_config(models=("m1",), attempts_per_model=3))
    assert isinstance(result, GeminiOk)
    assert h.sleeps == [1.0, 2.0]


def test_repeated_5xx_is_provider_unavailable_and_no_sleep_after_last_attempt() -> None:
    h = Harness(sequence(*[json_response(503, {"error": {"message": "down"}})] * 4))
    result = h.run()
    assert isinstance(result, GeminiFailure)
    assert result.code == "PROVIDER_UNAVAILABLE"
    assert result.message == "No configured AI model is available right now. Try again in a moment."
    assert h.models() == ["m1", "m1", "m2", "m2"]
    assert h.sleeps == [1.0, 1.0]
    assert result.detail[0] == {"model": "m1", "reason": "down", "status": 503}


def test_http_status_reason_when_no_message() -> None:
    result = Harness(sequence(json_response(500, {}), json_response(500, {}))).run(
        make_config(models=("m1",))
    )
    assert isinstance(result, GeminiFailure)
    assert result.detail[0]["reason"] == "HTTP 500"


def test_error_message_truncated_to_200() -> None:
    long = "x" * 500
    result = Harness(sequence(json_response(403, {"error": {"message": long}}))).run()
    assert isinstance(result, GeminiFailure)
    assert len(result.detail[0]["reason"]) == 200


def test_empty_response_retries_with_finish_reason() -> None:
    empty = {"candidates": [{"content": {"parts": []}, "finishReason": "MAX_TOKENS"}]}
    h = Harness(sequence(json_response(200, empty), json_response(200, {"candidates": []})))
    result = h.run(make_config(models=("m1",)))
    assert isinstance(result, GeminiFailure)
    assert result.code == "PROVIDER_UNAVAILABLE"
    reasons = [d["reason"] for d in result.detail]
    assert reasons == [
        "empty response (finishReason: MAX_TOKENS)",
        "empty response (finishReason: none)",
    ]


def test_unreadable_body_retries_with_status() -> None:
    h = Harness(sequence(httpx2.Response(200, content=b"<html>"), json_response(200, ok_body())))
    result = h.run()
    assert isinstance(result, GeminiOk)
    assert h.models() == ["m1", "m1"]


def test_invalid_json_everywhere_is_output_parse_failed() -> None:
    bad = json_response(200, ok_body("not json"))
    result = Harness(sequence(*[bad] * 4)).run()
    assert isinstance(result, GeminiFailure)
    assert result.code == "OUTPUT_PARSE_FAILED"
    assert result.message == "The AI provider did not return valid JSON."
    assert result.detail[0]["reason"] == "response was not valid JSON (finishReason: STOP)"


def test_bad_json_with_rate_limit_is_rate_limited() -> None:
    result = Harness(
        sequence(
            json_response(200, ok_body("not json")),
            json_response(429, {}),
            json_response(429, {}),
            json_response(429, {}),
        )
    ).run()
    assert isinstance(result, GeminiFailure)
    assert result.code == "RATE_LIMITED"


@pytest.mark.parametrize("status", [404, 400])
def test_404_and_400_move_to_next_model(status: int) -> None:
    h = Harness(
        sequence(
            json_response(status, {"error": {"message": "bad"}}), json_response(200, ok_body())
        )
    )
    result = h.run()
    assert isinstance(result, GeminiOk)
    assert result.model == "m2"
    assert h.models() == ["m1", "m2"]
    assert h.sleeps == []


@pytest.mark.parametrize("status", [401, 402, 403])
def test_auth_errors_are_fatal(status: int) -> None:
    h = Harness(sequence(json_response(status, {"error": {"message": "denied"}})))
    result = h.run()
    assert isinstance(result, GeminiFailure)
    assert result.code == "PROVIDER_UNAVAILABLE"
    assert result.message == (
        "The AI provider rejected the request (check the API key, billing, or permissions)."
    )
    assert result.detail == [{"model": "m1", "reason": "denied", "status": status}]
    assert len(h.requests) == 1


def test_timeouts_move_to_next_model_then_timeout() -> None:
    h = Harness(sequence(httpx2.ReadTimeout("slow"), httpx2.ConnectTimeout("slow")))
    result = h.run()
    assert isinstance(result, GeminiFailure)
    assert result.code == "TIMEOUT"
    assert h.models() == ["m1", "m2"]
    assert h.sleeps == []


def test_network_error_retries() -> None:
    h = Harness(sequence(httpx2.ConnectError("boom"), json_response(200, ok_body())))
    result = h.run()
    assert isinstance(result, GeminiOk)
    assert h.models() == ["m1", "m1"]
    assert h.sleeps == [1.0]


def test_network_errors_everywhere_not_timeout() -> None:
    result = Harness(sequence(*[httpx2.ConnectError("boom")] * 4)).run()
    assert isinstance(result, GeminiFailure)
    assert result.code == "PROVIDER_UNAVAILABLE"
    assert result.detail[0]["reason"] == "network error"


def test_deadline_reached_stops_everything() -> None:
    # Each retry sleeps 1s; a 1.5s deadline expires before the third request.
    h = Harness(sequence(*[json_response(503, {})] * 10))
    result = h.run(make_config(deadline_ms=1_500, attempts_per_model=3, backoff_ms=1_000))
    assert isinstance(result, GeminiFailure)
    assert result.detail[-1]["reason"] == "deadline reached"
    assert len(h.requests) == 2
    assert h.models() == ["m1", "m1"]


def test_timeout_is_capped_by_remaining_deadline() -> None:
    seen: list[Any] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.extensions["timeout"])
        return json_response(200, ok_body())

    Harness(handler).run(make_config(timeout_ms=10_000, deadline_ms=2_000))
    assert seen[0]["read"] == pytest.approx(2.0)


def test_key_never_appears_in_results_or_logs(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    cases = [
        [json_response(403, {"error": {"message": "denied"}})],
        [httpx2.ConnectError("boom")] * 4,
        [json_response(200, ok_body("not json"))] * 4,
        [json_response(200, ok_body())],
    ]
    for case in cases:
        result = Harness(sequence(*case)).run()
        assert KEY not in repr(result)
        if isinstance(result, GeminiFailure):
            assert KEY not in json.dumps(result.detail)
    assert KEY not in caplog.text
    assert "hello" not in caplog.text


def test_creates_and_closes_own_async_client(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[httpx2.AsyncClient] = []
    real = httpx2.AsyncClient
    transport = httpx2.MockTransport(lambda _r: json_response(200, ok_body()))

    def factory(*args: Any, **kwargs: Any) -> httpx2.AsyncClient:
        instance = real(*args, transport=transport, **kwargs)
        created.append(instance)
        return instance

    monkeypatch.setattr(httpx2, "AsyncClient", factory)
    result = asyncio.run(generate_json(REQUEST, make_config()))
    assert isinstance(result, GeminiOk)
    assert len(created) == 1
    assert created[0].is_closed


def test_key_that_is_not_a_valid_header_is_fatal_and_not_echoed() -> None:
    # A real client (no mock) refuses to build the request, so nothing is sent.
    bad_key = " not-a-header-key\r"

    async def go() -> GeminiResult:
        async with httpx2.AsyncClient() as client:
            return await generate_json(
                REQUEST, make_config(api_key=bad_key), client=client, sleep=_no_sleep
            )

    result = asyncio.run(go())
    assert isinstance(result, GeminiFailure)
    assert result.code == "PROVIDER_UNAVAILABLE"
    assert len(result.detail) == 1  # fatal: no retry, no next model
    assert "valid header value" in result.detail[0]["reason"]
    assert "not-a-header-key" not in repr(result)


async def _no_sleep(_seconds: float) -> None:
    return None
