"""Smoke tests of the Animation_Agent nodes and driver loop (`app.ai.animation.agent`, task 17.1).

Why: these tests show that each node does what design 6.6 says on the paths a run really takes, with
a real `AiContext` over a mock Gemini, the real `S3AnimationStore` over `FakeS3`, and scripted
verifier and registry doubles (`tests/animation_agent_support.py`). They run without `langgraph`:
the driver loop and the nodes are plain coroutines. They are a smoke layer on purpose. The full
matrix of task 17.2 (every `decide_after_verify` combination, each `max_attempts` from 1 to 4, every
`GeminiFailure`, a blocked verifier thread, the event loop staying free, `in_flight()`, sentinels in
every input) and the property test of 17.3 build on the same support module and are not repeated
here.

Covered: the first-attempt success and what the doubles are given (Gemini config, payload, S3 calls,
registry row, events, log lines); a repair (prompt content, Diagnostics errors first, temperatures,
tokens equal on every attempt); the two skipped verifications; verifier failures (unavailable,
infrastructure codes, crash); Gemini failures; the deadline at three points; cancellation by
flag and by task; storage, registry and quota failures; a lost race and an adopted manifest; and
that an unexpected exception ends as `UNKNOWN` without its message in the log.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx2
import pytest

from app.ai.animation import agent
from app.ai.animation.agent import AgentFailed, AgentPublished, run_agent
from app.ai.animation.logging_ import END_CANCELLED
from app.ai.animation.models import AnimationManifest
from app.ai.gemini_client import GeminiFailure
from tests.animation_agent_support import (
    OWNER,
    Rig,
    all_log_text,
    animation_log_lines,
    crashed,
    fenced,
    lesson_request,
    make_rig,
    rejected,
    source,
    unavailable,
    verified,
)


def run(rig: Rig) -> AgentPublished | AgentFailed:
    return asyncio.run(run_agent(rig.run))


def published(result: AgentPublished | AgentFailed) -> AgentPublished:
    assert isinstance(result, AgentPublished), result
    return result


def failed(result: AgentPublished | AgentFailed, code: str) -> AgentFailed:
    assert isinstance(result, AgentFailed), result
    assert result.code == code
    return result


# --- the first attempt succeeds ---------------------------------------------------------------


def test_a_first_attempt_success_publishes_and_returns_the_reference(
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified(warnings=["ESLINT_LORE_X"])])
    caplog.set_level(logging.INFO)
    result = published(run(rig))

    assert result.calls == 1
    assert result.model == "fake-model"
    assert result.row.attempts == 1
    reference = result.reference.dump()
    assert reference["animation_id"] == result.row.id
    assert (reference["width"], reference["height"], reference["fps"]) == (1280, 720, 30)
    assert reference["duration_in_frames"] == 120
    assert "pause_at_frame" not in reference
    assert rig.event_names() == [
        "stage:generating:1",
        "stage:verifying:1",
        "diagnostics:1:True:0",
        "stage:publishing:1",
    ]
    assert rig.s3.ops() == [
        "get_object manifest.json",
        "put_object main.ts",
        "put_object main.js",
        "put_object manifest.json",
    ]
    (recorded,) = rig.registry.calls
    assert recorded.owner_id == OWNER
    assert recorded.s3_prefix == f"animations/v1/{result.reference.source_sha256[:2]}/" + (
        f"{result.reference.source_sha256}/"
    )
    assert [line["event"] for line in animation_log_lines(caplog)] == [
        "animation.start",
        "animation.attempt",
        "animation.end",
    ]
    end = animation_log_lines(caplog)[-1]
    assert (end["code"], end["attempts"], end["model"], end["cached"]) == (
        "OK",
        1,
        "fake-model",
        False,
    )
    assert animation_log_lines(caplog)[1]["outcome"] == "verified"


def test_a_puzzle_reference_carries_the_pause_frame() -> None:
    rig = make_rig(kind="puzzle", gemini=[fenced(source(1))], verifier=[verified(kind="puzzle")])
    result = published(run(rig))
    assert result.reference.dump()["pause_at_frame"] == 90
    assert rig.verifier.payloads[0]["kind"] == "puzzle"
    assert rig.verifier.payloads[0]["forbidden_tokens"] == ["seven"]


def test_gemini_is_asked_for_text_with_the_limits_of_the_prompt_module() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    run(rig)
    (config,) = rig.gemini.generation_configs()
    assert config == {
        "responseMimeType": "text/plain",
        "maxOutputTokens": 12_000,
        "temperature": 0.3,
    }


def test_the_gemini_call_is_limited_by_the_time_left_before_the_deadline() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()], deadline_ms=10_000)
    run(rig)
    (request,) = rig.gemini.requests
    assert request.extensions["timeout"]["read"] == pytest.approx(10.0)


def test_the_verifier_gets_exactly_five_keys() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    run(rig)
    (payload,) = rig.verifier.payloads
    assert set(payload) == {
        "source",
        "kind",
        "required_tokens",
        "forbidden_tokens",
        "contract_version",
    }
    assert payload["source"] == source(1)
    assert payload["required_tokens"] == rig.run.required
    assert payload["contract_version"] == 1
    assert rig.verifier.attempts == [1]


# --- repair -----------------------------------------------------------------------------------


def test_a_repair_sends_the_source_and_the_diagnostics_errors_first() -> None:
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(source(2))],
        verifier=[
            rejected("TSC_2304", warnings=["ESLINT_LORE_KIT_STYLE"]),
            verified(),
        ],
    )
    result = published(run(rig))
    assert result.calls == 2
    assert result.row.attempts == 2
    _, repair_prompt = rig.gemini.prompts()[1]
    assert source(1) in repair_prompt
    assert repair_prompt.index("TSC_2304") < repair_prompt.index("ESLINT_LORE_KIT_STYLE")
    assert [config["temperature"] for config in rig.gemini.generation_configs()] == [0.3, 0.2]
    assert rig.event_names()[:4] == [
        "stage:generating:1",
        "stage:verifying:1",
        "diagnostics:1:False:1",
        "stage:repairing:2",
    ]


def test_the_tokens_sent_to_the_verifier_are_the_same_on_every_attempt() -> None:
    rig = make_rig(
        gemini=[fenced(source(n)) for n in (1, 2, 3)],
        verifier=[rejected("TSC_2304"), rejected("TSC_2304"), verified()],
        kind="puzzle",
    )
    rig.verifier.script[2] = verified(kind="puzzle")
    published(run(rig))
    first, *rest = rig.verifier.payloads
    assert len(rest) == 2
    for payload in rest:
        assert payload["required_tokens"] == first["required_tokens"]
        assert payload["forbidden_tokens"] == first["forbidden_tokens"]
    assert rig.verifier.attempts == [1, 2, 3]


def test_the_run_stops_with_verification_failed_when_attempts_are_used() -> None:
    rig = make_rig(
        gemini=[fenced(source(n)) for n in (1, 2)],
        verifier=[rejected("TSC_2304"), rejected("POLICY_URL_LITERAL")],
        max_attempts=2,
    )
    result = failed(run(rig), "ANIMATION_VERIFICATION_FAILED")
    assert result.calls == 2
    assert len(rig.gemini.requests) == 2
    assert [item.code for item in result.diagnostics] == ["POLICY_URL_LITERAL"]
    assert not rig.s3.calls and not rig.registry.calls


# --- skipped verification ---------------------------------------------------------------------


def test_a_reply_without_code_skips_the_verifier_and_repairs_from_nothing() -> None:
    rig = make_rig(gemini=["I cannot do that.", fenced(source(2))], verifier=[verified()])
    result = published(run(rig))
    assert result.calls == 2
    assert len(rig.verifier.payloads) == 1
    assert rig.event_names()[:3] == [
        "stage:generating:1",
        "diagnostics:1:False:1",
        "stage:repairing:2",
    ]
    (diagnostics_event,) = [e for e in rig.events if type(e).__name__ == "DiagnosticsEvent"][:1]
    assert [(item.tool, item.code) for item in diagnostics_event.items] == [
        ("agent", "AGENT_EXTRACT_NO_CODE")
    ]
    _, repair_prompt = rig.gemini.prompts()[1]
    assert "no previous source" in repair_prompt
    assert "AGENT_EXTRACT_NO_CODE" in repair_prompt


def test_a_repair_that_changes_nothing_skips_the_verifier() -> None:
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(source(1)), fenced(source(2))],
        verifier=[rejected("TSC_2304"), verified()],
    )
    result = published(run(rig))
    assert result.calls == 3
    assert len(rig.verifier.payloads) == 2
    assert rig.event_names()[3:6] == [
        "stage:repairing:2",
        "diagnostics:2:False:1",
        "stage:repairing:3",
    ]


def test_a_skipped_verification_on_the_last_attempt_fails_the_run() -> None:
    rig = make_rig(gemini=["no code"], verifier=[verified()], max_attempts=1)
    result = failed(run(rig), "ANIMATION_VERIFICATION_FAILED")
    assert result.calls == 1
    assert [item.code for item in result.diagnostics] == ["AGENT_EXTRACT_NO_CODE"]
    assert rig.verifier.payloads == []


# --- verifier failures ------------------------------------------------------------------------


def test_an_unavailable_verifier_ends_the_run_without_another_gemini_call() -> None:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))], verifier=[unavailable()])
    result = failed(run(rig), "ANIMATION_VERIFIER_UNAVAILABLE")
    assert result.calls == 1
    assert len(rig.gemini.requests) == 1
    assert rig.event_names() == ["stage:generating:1", "stage:verifying:1"]
    assert not rig.s3.calls and not rig.registry.calls


@pytest.mark.parametrize(
    "code", ["VERIFIER_INTERNAL", "VERIFIER_CONTRACT_MISMATCH", "VERIFIER_BAD_INPUT"]
)
def test_a_deployment_problem_reported_by_the_verifier_ends_the_run(code: str) -> None:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))], verifier=[rejected(code)])
    failed(run(rig), "ANIMATION_VERIFIER_UNAVAILABLE")
    assert len(rig.gemini.requests) == 1
    assert rig.event_names() == ["stage:generating:1", "stage:verifying:1"]


def test_a_verifier_deadline_diagnostic_counts_as_a_failed_attempt() -> None:
    rig = make_rig(
        gemini=[fenced(source(1)), fenced(source(2))],
        verifier=[rejected("VERIFIER_DEADLINE"), verified()],
    )
    assert published(run(rig)).calls == 2


def test_a_verifier_that_raises_is_unavailable() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[RuntimeError("SECRET-SENTINEL")])
    failed(run(rig), "ANIMATION_VERIFIER_UNAVAILABLE")


def test_a_crashed_verifier_is_a_failed_attempt_with_a_fixed_message() -> None:
    rig = make_rig(gemini=[fenced(source(1)), fenced(source(2))], verifier=[crashed(), verified()])
    published(run(rig))
    _, repair_prompt = rig.gemini.prompts()[1]
    assert "VERIFIER_CRASH" in repair_prompt
    assert rig.event_names()[2] == "diagnostics:1:False:1"


# --- Gemini failures --------------------------------------------------------------------------


def _read_timeout(_request: httpx2.Request) -> httpx2.Response:
    raise httpx2.ReadTimeout("slow")


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (429, "RATE_LIMITED"),
        (500, "PROVIDER_UNAVAILABLE"),
        (401, "PROVIDER_UNAVAILABLE"),
        (_read_timeout, "ANIMATION_TIMEOUT"),
    ],
)
def test_a_gemini_failure_ends_the_run_with_the_matching_code(reply: Any, code: str) -> None:
    rig = make_rig(gemini=[reply, fenced(source(1))], verifier=[verified()])
    result = failed(run(rig), code)
    assert result.calls == 1
    assert len(rig.gemini.requests) == 1
    assert rig.verifier.payloads == []


def test_an_unparsable_gemini_answer_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    async def parse_failed(*_args: Any) -> GeminiFailure:
        return GeminiFailure("OUTPUT_PARSE_FAILED", "no", [])

    monkeypatch.setattr(agent, "_call_gemini", parse_failed)
    rig = make_rig(verifier=[verified()])
    failed(run(rig), "UNKNOWN")


def test_a_gemini_failure_is_logged_as_an_attempt(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    rig = make_rig(gemini=[429])
    run(rig)
    lines = animation_log_lines(caplog)
    assert [line["event"] for line in lines] == [
        "animation.start",
        "animation.attempt",
        "animation.end",
    ]
    assert lines[1]["outcome"] == "gemini_failed"
    assert (lines[2]["code"], lines[2]["attempts"]) == ("RATE_LIMITED", 1)


# --- the deadline -----------------------------------------------------------------------------


def test_a_deadline_that_passes_during_gemini_stops_before_the_verifier() -> None:
    rig = make_rig(verifier=[verified()])

    def late(_request: httpx2.Request) -> httpx2.Response:
        rig.clock.advance_ms(240_001)
        text = fenced(source(1))
        return httpx2.Response(200, json={"candidates": [{"content": {"parts": [{"text": text}]}}]})

    rig.gemini.replies.append(late)
    failed(run(rig), "ANIMATION_TIMEOUT")
    assert rig.verifier.payloads == []
    assert not rig.s3.calls and not rig.registry.calls


def test_a_verifier_answer_after_the_deadline_is_dropped() -> None:
    rig = make_rig(gemini=[fenced(source(1))])

    async def late(_payload: dict[str, Any], _remaining: float) -> Any:
        rig.clock.advance_ms(240_001)
        return verified()

    rig.verifier.script.append(late)
    failed(run(rig), "ANIMATION_TIMEOUT")
    assert not rig.s3.calls and not rig.registry.calls
    assert "diagnostics" not in " ".join(rig.event_names())


def test_a_deadline_inside_publish_never_writes_the_manifest_or_a_row() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.before("put_object", "main.js", lambda: rig.clock.advance_ms(240_001))
    failed(run(rig), "ANIMATION_TIMEOUT")
    assert not any(key.endswith("manifest.json") for key in rig.s3.objects)
    assert rig.registry.calls == []


def test_the_guard_ends_a_run_stuck_in_a_step_that_ignores_the_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent, "GUARD_MARGIN_MS", 50)
    rig = make_rig(gemini=[fenced(source(1))], deadline_ms=100)

    async def hang(_payload: dict[str, Any], _remaining: float) -> Any:
        await asyncio.sleep(30)

    rig.verifier.script.append(hang)
    failed(run(rig), "ANIMATION_TIMEOUT")
    assert rig.run.cancelled.is_set()


# --- cancellation -----------------------------------------------------------------------------


def test_a_run_whose_flag_is_set_starts_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    cancelled = asyncio.Event()
    cancelled.set()
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()], cancelled=cancelled)
    failed(run(rig), "UNKNOWN")
    assert rig.gemini.requests == [] and rig.verifier.payloads == []
    assert rig.events == []
    assert animation_log_lines(caplog)[-1]["code"] == END_CANCELLED


def test_cancelling_the_task_stops_the_run_and_raises_again(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    rig = make_rig(verifier=[verified()])

    async def blocked(_request: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(30)
        raise AssertionError("not reached")

    rig.gemini.replies.append(blocked)

    async def scenario() -> None:
        task = asyncio.create_task(run_agent(rig.run))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert rig.run.cancelled.is_set()
    assert rig.event_names() == ["stage:generating:1"]
    assert rig.verifier.payloads == [] and not rig.registry.calls
    end = animation_log_lines(caplog)[-1]
    assert (end["event"], end["code"], end["attempts"]) == ("animation.end", END_CANCELLED, 1)


# --- storage, registry and quota --------------------------------------------------------------


def test_an_s3_failure_is_a_storage_failure_and_no_row_is_written() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.fail("put_object", "main.js", 500, "InternalError", times=5)
    failed(run(rig), "ANIMATION_STORAGE_FAILED")
    assert rig.registry.calls == []
    assert rig.gemini.requests and len(rig.gemini.requests) == 1


def test_a_registry_error_is_a_storage_failure() -> None:
    from app.ai.animation.registry import RegistryError

    rig = make_rig(
        gemini=[fenced(source(1))], verifier=[verified()], registry_error=RegistryError("down")
    )
    failed(run(rig), "ANIMATION_STORAGE_FAILED")


def test_a_full_quota_fails_the_run_after_the_files_were_written() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()], registry_limit=0)
    failed(run(rig), "ANIMATION_QUOTA_EXCEEDED")
    assert len(rig.s3.calls_of("put_object")) == 3
    assert rig.registry.rows == []


def test_a_run_that_loses_the_race_answers_with_the_row_that_won() -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    winner = rig.registry.seed(_new_row_for(rig, attempts=3))
    result = published(run(rig))
    assert result.row == winner
    assert result.reference.animation_id == winner.id
    assert len(rig.registry.rows) == 1


def _new_row_for(rig: Rig, *, attempts: int) -> Any:
    """A row another run recorded for the same owner and request hash."""
    from app.ai.animation.registry import NewRow

    return NewRow(
        id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        owner_id=OWNER,
        request_hash=rig.run.request_hash,
        source_sha256="1" * 64,
        bundle_sha256="2" * 64,
        s3_prefix=f"animations/v1/11/{'1' * 64}/",
        kind="lesson",
        meta={"width": 1280, "height": 720, "fps": 30, "durationInFrames": 90},
        attempts=attempts,
        model="fake-model",
        verifier_version="0.1.0",
        contract_version=1,
        runtime_version={"react": "19.3.0", "remotion": "4.0.543"},
        source_bytes=10,
        bundle_bytes=10,
    )


def test_a_manifest_that_is_already_in_s3_is_adopted_and_its_values_are_recorded() -> None:
    first = make_rig(
        gemini=[fenced(source(1)), fenced(source(2))],
        verifier=[rejected("TSC_2304"), verified()],
    )
    first_result = published(run(first))
    assert first_result.row.attempts == 2

    # Another run, same bucket, ends on the same source after one attempt.
    second = make_rig(gemini=[fenced(source(2))], verifier=[verified()], s3=first.s3)
    second_result = published(run(second))
    assert second_result.calls == 1
    assert second_result.row.attempts == 2  # the adopted manifest's value, not this run's
    assert second_result.reference.source_sha256 == first_result.reference.source_sha256
    assert len(first.s3.calls_of("put_object")) == 3  # nothing was written the second time
    manifest = AnimationManifest.model_validate_json(
        first.s3.objects[first_result.row.s3_prefix + "manifest.json"]
    )
    assert manifest.attempts == 2


# --- unexpected failures ----------------------------------------------------------------------


def test_an_unexpected_exception_is_unknown_and_its_message_stays_out_of_the_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def explode(*_args: Any) -> Any:
        raise RuntimeError("SECRET-SENTINEL-MESSAGE")

    monkeypatch.setattr(agent, "build_generate_prompt", explode)
    caplog.set_level(logging.DEBUG)
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    failed(run(rig), "UNKNOWN")
    text = all_log_text(caplog)
    assert "SECRET-SENTINEL-MESSAGE" not in text
    assert "RuntimeError" in text
    assert animation_log_lines(caplog)[-1]["code"] == "UNKNOWN"


def test_the_log_of_a_repair_run_holds_no_material_source_or_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    request = lesson_request(title="TITLE-SENTINEL", text="TEXT-SENTINEL")
    sentinel_source = "// SOURCE-SENTINEL\nexport default function Main() { return null; }\n"
    rig = make_rig(
        request=request,
        gemini=[fenced(sentinel_source), fenced(source(2))],
        verifier=[rejected("TSC_2304"), verified()],
    )
    published(run(rig))
    text = all_log_text(caplog)
    for sentinel in ("TITLE-SENTINEL", "TEXT-SENTINEL", "SOURCE-SENTINEL", "message of TSC_2304"):
        assert sentinel not in text
    assert "fake-model:generateContent" in text  # the HTTP client's own line is there, key-free
