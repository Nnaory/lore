"""Tests for `GET /api/v1/animations/{animation_id}`, the Animation_Reader (task 18.4; Req. 21).

Why: the Reader hands the browser two short-lived URLs for an animation, so what matters is who may
ask, in which order the checks run, and that nothing but the owner's own animation ever comes back.
These tests drive the real application (cookie middleware, `limit_ip`, router, registry port, store)
with the registry and S3 replaced at the seams the production code already has
(`animation_endpoint_support.py`), so no network, AWS package or Postgres is needed. They pin:

1. the answer for a stored animation: the shared fixture `reader-response.json` (the one the
   frontend loader test also reads), `pause_at_frame` present only when the row has one, a manifest
   summary with exactly eight keys, and the same reference as the `done` event of the run;
2. the URLs: two presigned GET URLs valid for 300 seconds on the virtual-hosted regional host, made
   without a single S3 request (Requirements 21.3, 21.7, 21.8);
3. the three 404s (not a UUID, no row, another owner's row) being the same bytes (21.4, 21.10), and
   no query for an id that is not a lowercase UUID;
4. the order of the checks: `limit_ip`, then configuration, then the id format, then the row (21.9),
   and `ANIMATION_NOT_CONFIGURED` for every id when the feature is not set up (21.5, 21.14), but not
   because the verifier function is empty (21.12);
5. that the registry read and the signing run off the event loop (21.14);
6. failures: a registry or signing failure is a fixed 503, anything else a fixed 500, and no URL,
   body or exception text reaches a log (21.6).

Everything is proven with doubles, so none of it says how real botocore signs: that is the
`test_real_boto3_*` test in `test_animation_store.py`, which runs where boto3 is installed.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import threading
import time
import uuid
from typing import Any
from urllib.parse import quote

import httpx2
import pytest

from app.ai.animation.models import AnimationReference, AnimationRow, reference_from_row
from app.ai.animation.registry import RegistryError
from app.ai.animation.store import StoreError
from app.owner import COOKIE_NAME
from app.ratelimit import RateLimiter
from tests.animation_agent_support import OWNER, fenced, source, verified
from tests.animation_endpoint_support import (
    FIXTURES,
    IP,
    OTHER_OWNER,
    TEST_IP,
    Exchange,
    World,
    build_world,
    events_of,
    make_row,
    request_body,
    ticker,
)

READER = "/api/v1/animations/"
FIXTURE: dict[str, Any] = json.loads((FIXTURES / "reader-response.json").read_text("utf-8"))
NOT_FOUND = b'{"detail":"animation not found"}'
RATE_LIMITED = b'{"detail":"rate limit exceeded"}'
NOT_CONFIGURED = {
    "ok": False,
    "error": {
        "code": "ANIMATION_NOT_CONFIGURED",
        "message": "Animations are not available on this server.",
    },
}
UNKNOWN = {"ok": False, "error": {"code": "UNKNOWN", "message": "Internal server error"}}
STORAGE_FAILED_CODE = "ANIMATION_STORAGE_FAILED"
ANIMATION_ID = FIXTURE["data"]["animation"]["animation_id"]
OTHER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
SECRET = "https://leak.example/X-Amz-Signature=do-not-log"


# --- helpers -------------------------------------------------------------------------------------


def fixture_row(owner: uuid.UUID = OWNER) -> AnimationRow:
    """The registry row that the shared fixture `reader-response.json` is the answer for."""
    data = FIXTURE["data"]
    animation, manifest = data["animation"], data["manifest"]
    sha = animation["source_sha256"]
    return AnimationRow(
        id=animation["animation_id"],
        owner_id=owner,
        request_hash="0" * 64,
        source_sha256=sha,
        bundle_sha256=animation["bundle_sha256"],
        s3_prefix=f"animations/v1/{sha[:2]}/{sha}/",
        kind="lesson",
        meta=dict(manifest["meta"]),
        attempts=manifest["attempts"],
        model=manifest["model"],
        verifier_version=manifest["verifier_version"],
        contract_version=manifest["contract_version"],
        runtime_version=dict(manifest["runtime_version"]),
        source_bytes=manifest["source_bytes"],
        bundle_bytes=manifest["bundle_bytes"],
        created_at=1_700_000_000_000,
    )


def path_of(animation_id: str) -> str:
    return READER + quote(animation_id, safe="/")


def read(
    world: World, animation_id: str = ANIMATION_ID, *, owner: uuid.UUID | None = OWNER
) -> httpx2.Response:
    return world.client(owner).get(path_of(animation_id))


def served(monkeypatch: pytest.MonkeyPatch, **kwargs: Any) -> World:
    """A world that holds the fixture's animation for `OWNER`."""
    return build_world(monkeypatch, rows=[fixture_row()], **kwargs)


class StoreSpy:
    """Stands in for the runtime's store: delegates, records `presign` and can slow or break it."""

    def __init__(self, inner: Any, *, delay_s: float = 0.0, error: Exception | None = None) -> None:
        self.inner = inner
        self.delay_s = delay_s
        self.error = error
        self.hashes: list[str] = []
        self.threads: list[int] = []

    def publish(self, *args: Any, **kwargs: Any) -> Any:
        return self.inner.publish(*args, **kwargs)

    def presign(self, source_sha256: str) -> dict[str, str]:
        self.hashes.append(source_sha256)
        self.threads.append(threading.get_ident())
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.error is not None:
            raise self.error
        return self.inner.presign(source_sha256)


def spy_on_store(world: World, **kwargs: Any) -> StoreSpy:
    spy = StoreSpy(world.app.state.animation_runtime.store, **kwargs)
    world.app.state.animation_runtime.store = spy
    return spy


def nothing_looked_up(world: World) -> bool:
    return not world.registry.calls and not world.s3.calls


# --- a stored animation --------------------------------------------------------------------------


def test_the_answer_for_a_stored_animation_is_the_shared_fixture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    response = read(world)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    expected = FIXTURE["data"]
    assert body["ok"] is True
    assert set(body) == {"ok", "data"}
    assert list(body["data"]) == ["animation", "manifest", "urls", "expires_in"]
    assert body["data"]["animation"] == expected["animation"]
    assert body["data"]["manifest"] == expected["manifest"]
    assert body["data"]["expires_in"] == expected["expires_in"] == 300
    assert set(body["data"]["urls"]) == set(expected["urls"]) == {"bundle", "manifest"}


def test_the_animation_is_the_reference_of_the_row_and_passes_the_reference_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    animation = read(world).json()["data"]["animation"]

    assert animation == reference_from_row(fixture_row()).dump()
    assert AnimationReference.model_validate(animation).dump() == animation


@pytest.mark.parametrize("with_pause", [False, True])
def test_pause_at_frame_is_absent_unless_the_row_has_one(
    monkeypatch: pytest.MonkeyPatch, with_pause: bool
) -> None:
    row = make_row(OWNER, "a" * 64, kind="puzzle" if with_pause else "lesson")
    world = build_world(monkeypatch, rows=[row])
    data = read(world, row.id).json()["data"]

    if with_pause:
        assert data["animation"]["pause_at_frame"] == 120
        assert data["manifest"]["meta"]["pauseAtFrame"] == 120
    else:
        assert "pause_at_frame" not in data["animation"]
        assert "pauseAtFrame" not in data["manifest"]["meta"]
    assert None not in data["animation"].values()


def test_the_manifest_summary_has_exactly_the_documented_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    manifest = read(world).json()["data"]["manifest"]

    assert set(manifest) == {
        "contract_version",
        "runtime_version",
        "source_bytes",
        "bundle_bytes",
        "meta",
        "verifier_version",
        "model",
        "attempts",
    }
    assert not {"checks", "warnings", "request_hash", "created_at"} & set(manifest)


def test_the_answer_for_a_run_that_just_finished_is_the_done_event_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Requirement 21.13: `data.animation` equals `done.animation` of the same animation."""
    world = build_world(monkeypatch, gemini=[fenced(source(1))], verifier=[verified()])
    client = world.client(OWNER)
    run = client.post("/api/v1/ai/animations", json=request_body())
    name, done = events_of(run)[-1]
    assert name == "done"

    response = client.get(path_of(done["animation"]["animation_id"]))

    assert response.status_code == 200
    assert response.json()["data"]["animation"] == done["animation"]
    (stored,) = world.registry.rows
    assert response.json()["data"]["manifest"]["attempts"] == stored.attempts
    assert world.registry.ops() == ["find", "count", "register", "get"]


# --- the URLs ------------------------------------------------------------------------------------


def test_the_urls_are_presigned_for_300_seconds_and_need_no_s3_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    data = read(world).json()["data"]
    sha = FIXTURE["data"]["animation"]["source_sha256"]
    host = f"https://{world.s3.bucket}.s3.{world.s3.region}.amazonaws.com"

    assert data["urls"]["bundle"].startswith(f"{host}/animations/v1/{sha[:2]}/{sha}/main.js?")
    assert data["urls"]["manifest"].startswith(
        f"{host}/animations/v1/{sha[:2]}/{sha}/manifest.json?"
    )
    for url in data["urls"].values():
        assert "X-Amz-Expires=300" in url
    # Two presigned URLs and no other S3 request, of any kind (Requirement 21.7).
    assert [call.op for call in world.s3.calls] == ["generate_presigned_url"] * 2
    assert {call.params["ExpiresIn"] for call in world.s3.calls} == {300}
    assert {call.params["ClientMethod"] for call in world.s3.calls} == {"get_object"}
    assert [call.name for call in world.s3.calls] == ["main.js", "manifest.json"]
    for forbidden in ("get_object", "head_object", "list_objects_v2", "put_object"):
        assert world.s3.calls_of(forbidden) == []
    assert world.s3.unexpected == []


def test_the_signing_is_asked_for_the_hash_of_the_row_not_for_one_the_client_chose(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    spy = spy_on_store(world)
    read(world)

    assert spy.hashes == [FIXTURE["data"]["animation"]["source_sha256"]]


# --- who may read --------------------------------------------------------------------------------


def test_the_three_kinds_of_404_are_the_same_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Requirements 21.4, 21.8, 21.10, 21.11: not a UUID, no row and another owner's row."""
    world = build_world(monkeypatch, rows=[fixture_row(OTHER_OWNER)])
    answers = {
        "not a uuid": read(world, "not-a-uuid"),
        "no row": read(world, OTHER_ID),
        "another owner": read(world, ANIMATION_ID),
    }

    for label, response in answers.items():
        assert response.status_code == 404, label
        assert response.content == NOT_FOUND, label
        assert response.headers["cache-control"] == "no-store", label
        assert response.headers["content-type"] == "application/json", label
        assert response.headers["content-length"] == str(len(NOT_FOUND)), label
    assert world.registry.ops() == ["get", "get"]  # the malformed id never reached the database


def test_a_row_of_another_owner_is_readable_only_by_that_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = build_world(monkeypatch, rows=[fixture_row(OTHER_OWNER)])

    mine = read(world, owner=OWNER)
    theirs = read(world, owner=OTHER_OWNER)

    assert (mine.status_code, mine.content) == (404, NOT_FOUND)
    assert theirs.status_code == 200
    assert theirs.json()["data"]["animation"] == FIXTURE["data"]["animation"]
    owners = [owner for _, owner, _ in world.registry.fetched]
    assert owners == [OWNER, OTHER_OWNER]
    engines = {id(engine) for engine, _, _ in world.registry.fetched}
    assert engines == {id(world.app.state.db_engine)}


def test_a_client_without_a_cookie_gets_a_new_owner_and_the_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cookie middleware covers `/api/v1/animations` (Requirement 21.1)."""
    world = served(monkeypatch)
    response = read(world, owner=None)

    assert (response.status_code, response.content) == (404, NOT_FOUND)
    assert COOKIE_NAME in response.cookies
    (_, owner, _) = world.registry.fetched[0]
    assert owner != OWNER and owner == uuid.UUID(response.cookies[COOKIE_NAME])


# --- ids that are not lowercase UUIDs ------------------------------------------------------------

MALFORMED_IDS = [
    pytest.param("not-a-uuid", id="word"),
    pytest.param(ANIMATION_ID.upper(), id="uppercase"),
    pytest.param(ANIMATION_ID.replace("-", ""), id="no-dashes"),
    pytest.param(ANIMATION_ID + "0", id="too-long"),
    pytest.param(ANIMATION_ID[:-1], id="too-short"),
    pytest.param(ANIMATION_ID + "\n", id="trailing-newline"),
    pytest.param("a\nb", id="inner-newline"),
    pytest.param(" " + ANIMATION_ID, id="leading-space"),
    pytest.param(ANIMATION_ID.replace("3", "\u0663", 1), id="arabic-indic-digit"),
    pytest.param(ANIMATION_ID.replace("f", "\uff46", 1), id="fullwidth-letter"),
    pytest.param("x" * 5000, id="very-long"),
]


@pytest.mark.parametrize("animation_id", MALFORMED_IDS)
def test_an_id_that_is_not_a_lowercase_uuid_is_a_404_with_no_query(
    monkeypatch: pytest.MonkeyPatch, animation_id: str
) -> None:
    world = served(monkeypatch)
    response = read(world, animation_id)

    assert (response.status_code, response.content) == (404, NOT_FOUND)
    assert response.headers["cache-control"] == "no-store"
    assert nothing_looked_up(world)


@pytest.mark.parametrize(
    "path", ["/api/v1/animations/a/b", "/api/v1/animations/", "/api/v1/animations"]
)
def test_a_path_that_is_not_one_segment_is_not_a_reader_url_and_costs_nothing(
    monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    world = served(monkeypatch)
    response = world.client().get(path)

    assert (response.status_code, response.json()) == (404, {"detail": "Not Found"})
    assert nothing_looked_up(world)


# --- configuration -------------------------------------------------------------------------------

NOT_CONFIGURED_CAUSES = [
    pytest.param({"enabled": False}, id="flag-off"),
    pytest.param({"bucket": ""}, id="no-bucket"),
    pytest.param({"region": ""}, id="no-region"),
    pytest.param({"with_engine": False}, id="no-engine"),
    pytest.param({"env": {"ANIMATION_BUCKET": "  \t "}}, id="blank-bucket"),
    pytest.param({"env": {"ANIMATION_ENABLED": "yes"}}, id="flag-not-true"),
]
ANY_ID = [ANIMATION_ID, OTHER_ID, "not-a-uuid", ANIMATION_ID.upper(), ANIMATION_ID + "\n"]


@pytest.mark.parametrize("cause", NOT_CONFIGURED_CAUSES)
@pytest.mark.parametrize("animation_id", ANY_ID)
def test_when_not_configured_every_id_gets_the_same_503_and_nothing_is_looked_up(
    monkeypatch: pytest.MonkeyPatch, cause: dict[str, Any], animation_id: str
) -> None:
    """Requirements 21.5, 21.11, 21.14: the 503 does not depend on the id and costs no query."""
    world = served(monkeypatch, **cause)
    runtime = world.app.state.animation_runtime
    response = read(world, animation_id)

    assert response.status_code == 503
    assert response.json() == NOT_CONFIGURED
    assert response.headers["cache-control"] == "no-store"
    assert nothing_looked_up(world)
    assert world.app.state.animation_runtime is runtime


def test_an_empty_verifier_function_does_not_stop_the_reader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Requirement 21.12: a stored animation stays readable while the verifier is unset."""
    world = served(monkeypatch, function="")
    response = read(world)

    assert response.status_code == 200
    assert response.json()["data"]["animation"] == FIXTURE["data"]["animation"]


def test_the_reader_builds_no_runtime_before_it_has_a_valid_id_and_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The flag off, or an id that cannot exist, loads nothing (Requirement 41.1)."""
    off = served(monkeypatch, enabled=False)
    off.app.state.animation_runtime = None
    assert read(off).status_code == 503
    assert off.app.state.animation_runtime is None

    on = served(monkeypatch)
    on.app.state.animation_runtime = None
    assert read(on, "not-a-uuid").status_code == 404
    assert on.app.state.animation_runtime is None


# --- order of the checks -------------------------------------------------------------------------


def exhaust_limit_ip(world: World) -> None:
    """Use up the 120 requests per minute that `limit_ip` allows the test client's address."""
    world.app.state.rate_limiter = RateLimiter(monotonic=lambda: 0.0)
    for _ in range(120):
        assert world.app.state.rate_limiter.check_ip(TEST_IP)


def test_the_121st_request_of_a_minute_is_a_429_from_limit_ip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    world.app.state.rate_limiter = RateLimiter(monotonic=lambda: 0.0)
    client = world.client()

    statuses = [client.get(path_of(ANIMATION_ID)).status_code for _ in range(120)]
    last = client.get(path_of(ANIMATION_ID))

    assert statuses == [200] * 120
    assert last.status_code == 429
    assert last.content == RATE_LIMITED
    assert last.headers["retry-after"] == "60"
    assert len(world.registry.calls) == 120  # the 121st reached no query


@pytest.mark.parametrize("animation_id", ["not-a-uuid", ANIMATION_ID])
@pytest.mark.parametrize("cause", [{"enabled": False}, {}], ids=["not-configured", "configured"])
def test_limit_ip_comes_first(
    monkeypatch: pytest.MonkeyPatch, cause: dict[str, Any], animation_id: str
) -> None:
    world = served(monkeypatch, **cause)
    exhaust_limit_ip(world)
    response = read(world, animation_id)

    assert (response.status_code, response.content) == (429, RATE_LIMITED)
    assert nothing_looked_up(world)


def test_configuration_comes_before_the_format_of_the_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch, enabled=False)

    assert read(world, "not-a-uuid").status_code == 503
    assert read(world, ANIMATION_ID).status_code == 503


def test_the_format_comes_before_the_row_and_the_row_before_the_signing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    spy = spy_on_store(world)

    assert read(world, "not-a-uuid").status_code == 404
    assert world.registry.calls == []

    assert read(world, OTHER_ID).status_code == 404  # a valid id with no row
    assert world.registry.ops() == ["get"]
    assert spy.hashes == [] and world.s3.calls == []

    assert read(world).status_code == 200
    assert world.registry.ops() == ["get", "get"]
    assert len(spy.hashes) == 1


# --- off the event loop --------------------------------------------------------------------------


def test_the_registry_read_and_the_signing_do_not_stall_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Requirement 21.14: 500 ms in each delays a ticker on the same loop by at most 100 ms."""
    world = served(monkeypatch)
    world.registry.delay_s["get"] = 0.5
    spy = spy_on_store(world, delay_s=0.5)

    async def go() -> tuple[Exchange, float]:
        stop = asyncio.Event()
        tick = asyncio.create_task(ticker(stop))
        exchange = Exchange(
            world.app, b"", path=path_of(ANIMATION_ID), method="GET", ip=IP, owner=OWNER
        )
        await exchange.run()
        stop.set()
        return exchange, await tick

    exchange, worst = asyncio.run(go())

    assert exchange.status == 200
    assert json.loads(exchange.body)["data"]["animation"] == FIXTURE["data"]["animation"]
    assert worst <= 0.1
    loop_thread = threading.get_ident()
    assert loop_thread not in world.registry.threads()
    assert spy.threads and loop_thread not in spy.threads


# --- failures and logs ---------------------------------------------------------------------------


@pytest.mark.parametrize("where", ["registry", "signing"])
def test_a_registry_or_signing_failure_is_a_fixed_503(
    monkeypatch: pytest.MonkeyPatch, where: str
) -> None:
    world = served(monkeypatch)
    if where == "registry":
        world.registry.fail["get"] = RegistryError(f"database said {SECRET}")
    else:
        spy_on_store(world, error=StoreError(f"signing said {SECRET}"))
    response = read(world)

    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    error = response.json()["error"]
    assert error["code"] == STORAGE_FAILED_CODE
    assert response.json()["ok"] is False
    assert SECRET not in response.text


@pytest.mark.parametrize("where", ["registry", "signing", "row"])
def test_an_unexpected_failure_is_a_fixed_500_and_the_log_holds_no_detail(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, where: str
) -> None:
    world = served(monkeypatch)
    if where == "registry":
        world.registry.fail["get"] = RuntimeError(SECRET)
    elif where == "signing":
        spy_on_store(world, error=RuntimeError(SECRET))
    else:  # a row that breaks the contract cannot become a reference
        broken = fixture_row()
        world.registry.rows[:] = [dataclasses.replace(broken, meta={**broken.meta, "width": 640})]
    with caplog.at_level(logging.DEBUG):
        response = read(world)

    assert response.status_code == 500
    assert response.json() == UNKNOWN
    assert SECRET not in response.text and SECRET not in caplog.text
    assert "animation reader failed" in caplog.text


def test_no_url_and_no_body_reaches_a_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Requirement 21.6, at every level and for every logger."""
    world = served(monkeypatch)
    with caplog.at_level(logging.DEBUG):
        response = read(world)
        read(world, "not-a-uuid")
        read(world, OTHER_ID)

    assert response.status_code == 200
    logged = "\n".join(record.getMessage() for record in caplog.records)
    for url in response.json()["data"]["urls"].values():
        assert url not in logged
    assert "X-Amz-" not in logged and "amazonaws.com" not in logged
    assert response.text not in logged


# --- wiring --------------------------------------------------------------------------------------


def test_the_reader_answers_get_only_and_is_hidden_from_the_api_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = served(monkeypatch)
    client = world.client()

    for method in ("post", "put", "patch", "delete"):
        response = getattr(client, method)(path_of(ANIMATION_ID))
        assert response.status_code == 405, method
    assert world.registry.calls == []
    assert not [p for p in world.app.openapi()["paths"] if p.startswith("/api/v1/animations")]
