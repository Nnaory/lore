"""Lazy imports of `langgraph`, `boto3` and `botocore` (task 18.5; Requirements 41.1, 41.7, 38.14).

Why: the `api` container has 1 GiB of RAM. Importing the agent graph library and the AWS SDK costs
tens of MiB, and the feature is off in production until an operator turns it on, so an API that
serves nothing but projects and the older AI endpoints must not pay for them (design D-17, 6.1).
The rule is "load them on the first request that really needs them, and never because of an import
at the top of a module". Nothing else notices when the rule is broken: the API still answers, and
only the memory graph changes.

What is proved, and how:

1. A fresh Python process, not this one (Requirement 38.14): the pytest process has already
   loaded `langgraph` in other tests, so `sys.modules` here would say nothing. The child imports
   `app.main` with `ANIMATION_ENABLED` unset and a made-up Gemini key (so `PROVIDER_NOT_CONFIGURED`
   cannot answer before `ANIMATION_NOT_CONFIGURED`), runs the application startup, then calls
   `/health/ai`, `POST /api/v1/ai/animations` with a valid request and the Reader, and after the
   import and after each step it looks for the three packages in `sys.modules` (Requirement 41.7).
2. A `sys.meta_path` finder that blocks the three names and records every attempt to find them.
   `sys.modules` alone proves little where the packages are not installed (as in the sandbox):
   an `import boto3` would fail there and leave nothing behind. The finder records the attempt
   whether or not the package exists, so the test means the same everywhere. A deliberate import at
   the end of the child shows that the finder sees one, so a silent finder cannot pass the test.
3. Two more configurations in the same way, because "flag off" is not the only way to be cheap:
   the flag on with no database (the configuration checks refuse before anything is built), and
   the flag on with everything set but a database that is down. In the second the runtime
   (`S3AnimationStore`, `LambdaVerifierClient`) is created, which must still load no AWS package:
   they import `boto3` on their first call, and the registry fails before that.
4. A source check that does not need a process: only `agent.py`, `verifier_client.py` and
   `store.py` mention the three packages, and only inside a function body (or under
   `if TYPE_CHECKING`), so an import at module or class level, and an import in any other module,
   fails at once with a file and line. The checker is tried on invented sources so it is known to
   fail when it should.
5. With the real packages installed, one more child with no finder shows the other half: the
   graph and the S3 client do load them on demand, and it records the RSS at each step.
   That test is skipped where a package is missing, with the reason and the command to run it
   elsewhere. See its docstring: it is `[belum diverifikasi]` in the sandbox.

The children do not touch `app` code paths with side effects: no network, no AWS, no Postgres (the
"database down" case is an in-memory SQLite engine without the animations table).
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any

import pytest

from tests.animation_source_support import (
    APP,
    BACKEND,
    TESTS,
    Source,
    dynamic_import_targets,
    imported_roots,
    in_function,
    parse,
    read_tree,
)

FORBIDDEN = ("langgraph", "boto3", "botocore")
# The only modules that may mention them (design 6.1), and only inside functions.
LAZY_MODULES = frozenset(
    {
        "app/ai/animation/agent.py",
        "app/ai/animation/verifier_client.py",
        "app/ai/animation/store.py",
    }
)
# The modules the packages could have been imported from. If one is not imported by `app.main`,
# the child proves less than it says, so the test insists they were loaded.
WIRING = (
    "app.ai.animation.endpoint",
    "app.ai.animation.agent",
    "app.ai.animation.store",
    "app.ai.animation.verifier_client",
)
REQUEST_FIXTURE = TESTS / "fixtures" / "animation" / "request-valid-lesson-minimal.json"
ANIMATION_ID = "11111111-2222-4333-8444-555555555555"
FAKE_KEY = "fake-gemini-key-for-the-memory-test"  # not a secret: no request leaves the process

# Environment that the child must not inherit from the machine running the tests.
SCRUBBED_PREFIXES = ("ANIMATION_", "AI_", "PG", "DB_", "AWS_", "GOOGLE_", "GEMINI_")


# --- the child processes -------------------------------------------------------------------------

# Shared by both children. `CONFIG` is the JSON in `argv[1]`. `block` installs the finder.
_PRELUDE = r"""
import importlib
import importlib.abc
import json
import sys

CONFIG = json.loads(sys.argv[1])
FORBIDDEN = tuple(CONFIG["forbidden"])
attempts = []


class Blocker(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in FORBIDDEN:
            attempts.append(fullname)
            raise ImportError("blocked by the memory test: " + fullname)
        return None


if CONFIG["block"]:
    sys.meta_path.insert(0, Blocker())


def loaded():
    return sorted(name for name in sys.modules if name.split(".")[0] in FORBIDDEN)


report = {"stages": {}}


def mark(stage):
    report["stages"][stage] = {"loaded": loaded(), "attempts": list(attempts)}


def rss_mib():
    try:
        with open("/proc/self/status", encoding="ascii") as status:
            for line in status:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        return None
    return None
"""

# The request-serving child: what a process does when the feature is off or cannot start.
_SERVE = (
    _PRELUDE
    + r"""
import app.main
from app.main import app as application

mark("import")
report["wiring"] = [name for name in CONFIG["wiring"] if name in sys.modules]

if CONFIG["engine"]:
    from sqlalchemy import create_engine

    application.state.db_engine = create_engine("sqlite://")

from fastapi.testclient import TestClient


def answer(response):
    try:
        body = response.json()
    except ValueError:
        body = None
    return {"status": response.status_code, "body": body}


with TestClient(application) as client:
    mark("startup")
    report["health"] = answer(client.get("/health/ai"))
    mark("health")
    report["post"] = answer(client.post("/api/v1/ai/animations", json=CONFIG["body"]))
    mark("post")
    report["reader"] = answer(client.get("/api/v1/animations/" + CONFIG["animation_id"]))
    mark("reader")
    report["reader_bad_id"] = answer(client.get("/api/v1/animations/not-a-uuid"))
    mark("reader-bad-id")

report["runtime_built"] = application.state.animation_runtime is not None

# Control: the finder must see a deliberate import of each package, or the test proves nothing.
before = len(attempts)
for name in FORBIDDEN:
    try:
        importlib.import_module(name)
    except ImportError:
        pass
report["control_attempts"] = sorted(set(attempts[before:]))
print(json.dumps(report))
"""
)

# The demand child (no finder): the packages do load, but only when something asks for them.
_DEMAND = (
    _PRELUDE
    + r"""
import app.main

report["rss_mib"] = {"after_import": rss_mib()}
mark("import")

from app.ai.animation.agent import build_graph
from app.ai.animation.store import build_s3_client

build_graph()
mark("graph")
report["rss_mib"]["after_graph"] = rss_mib()

build_s3_client("ap-southeast-3")
mark("s3-client")
report["rss_mib"]["after_s3_client"] = rss_mib()
print(json.dumps(report))
"""
)


def clean_environment() -> dict[str, str]:
    """This process's environment without the settings that decide what the child does."""
    base = {k: v for k, v in os.environ.items() if not k.startswith(SCRUBBED_PREFIXES)}
    base["AI_PROVIDER"] = "google"
    base["GOOGLE_API_KEY"] = FAKE_KEY
    return base


def run_child(script: str, config: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    """Run `script` in a new interpreter from `backend/`; its last stdout line is a JSON report."""
    completed = subprocess.run(
        [sys.executable, "-c", script, json.dumps({**config, "forbidden": list(FORBIDDEN)})],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, f"child failed:\n{completed.stderr[-3000:]}"
    lines = completed.stdout.strip().splitlines()
    assert lines, f"child printed nothing:\n{completed.stderr[-3000:]}"
    report: dict[str, Any] = json.loads(lines[-1])
    return report


@dataclass(frozen=True)
class Scenario:
    """One configuration of the serving child and what its endpoints must answer."""

    name: str
    env: dict[str, str] = field(default_factory=dict)
    engine: bool = False
    health: dict[str, bool] = field(default_factory=dict)
    post: tuple[int, str] = (503, "ANIMATION_NOT_CONFIGURED")
    reader: tuple[int, str] = (503, "ANIMATION_NOT_CONFIGURED")
    reader_bad_id: tuple[int, str] = (503, "ANIMATION_NOT_CONFIGURED")
    runtime_built: bool = False


_ON = {
    "ANIMATION_ENABLED": "true",
    "ANIMATION_BUCKET": "memory-test-bucket",
    "ANIMATION_VERIFIER_FUNCTION": "memory-test-verifier",
    "AWS_REGION": "ap-southeast-3",
}

SCENARIOS = (
    # Requirement 41.7: `ANIMATION_ENABLED` not set at all.
    Scenario("flag-unset", health={"enabled": False, "configured": False}),
    Scenario(
        "flag-false",
        env={"ANIMATION_ENABLED": "false"},
        health={"enabled": False, "configured": False},
    ),
    # Design D-17: the flag on, but a database is missing, so the configuration check refuses.
    Scenario("flag-on-without-database", env=_ON, health={"enabled": True, "configured": False}),
    # The flag on and everything set, the database down: the runtime is built, no AWS call is made.
    Scenario(
        "flag-on-database-down",
        env=_ON,
        engine=True,
        health={"enabled": True, "configured": True},
        post=(503, "ANIMATION_STORAGE_FAILED"),
        reader=(503, "ANIMATION_STORAGE_FAILED"),
        reader_bad_id=(404, ""),
        runtime_built=True,
    ),
)


@pytest.fixture(scope="module")
def reports() -> dict[str, dict[str, Any]]:
    """One child per scenario, run once for the whole module (each is a new interpreter)."""
    out: dict[str, dict[str, Any]] = {}
    for scenario in SCENARIOS:
        env = {**clean_environment(), **scenario.env}
        config = {
            "block": True,
            "engine": scenario.engine,
            "body": json.loads(REQUEST_FIXTURE.read_text(encoding="utf-8")),
            "animation_id": ANIMATION_ID,
            "wiring": list(WIRING),
        }
        out[scenario.name] = run_child(_SERVE, config, env)
    return out


by_name = pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)


def error_of(answer: dict[str, Any]) -> tuple[int, str]:
    """`(status, error code)` of a response; the code is empty when the body has no `error`."""
    body = answer["body"]
    code = body["error"]["code"] if isinstance(body, dict) and "error" in body else ""
    return answer["status"], code


# --- Requirements 41.1, 41.7, 38.14: nothing heavy is loaded --------------------------------------


@by_name
def test_no_heavy_package_is_loaded_at_any_stage(
    reports: dict[str, dict[str, Any]], scenario: Scenario
) -> None:
    stages = reports[scenario.name]["stages"]

    assert list(stages) == ["import", "startup", "health", "post", "reader", "reader-bad-id"]
    for stage, seen in stages.items():
        assert seen["loaded"] == [], f"{stage}: {seen['loaded']} are in sys.modules"


@by_name
def test_no_import_of_a_heavy_package_is_even_attempted(
    reports: dict[str, dict[str, Any]], scenario: Scenario
) -> None:
    """The finder records a search whether or not the package exists, so this holds anywhere."""
    for stage, seen in reports[scenario.name]["stages"].items():
        assert seen["attempts"] == [], (
            f"{stage}: the application tried to import {seen['attempts']}"
        )


@by_name
def test_the_finder_sees_a_deliberate_import_of_each_package(
    reports: dict[str, dict[str, Any]], scenario: Scenario
) -> None:
    """The control: without it, a finder that records nothing would make the tests above pass."""
    assert reports[scenario.name]["control_attempts"] == sorted(FORBIDDEN)


@by_name
def test_the_modules_that_could_load_the_packages_were_imported(
    reports: dict[str, dict[str, Any]], scenario: Scenario
) -> None:
    """`app.main` wires in the agent, store and verifier client; only their packages wait."""
    assert reports[scenario.name]["wiring"] == list(WIRING)


# --- Requirement 41.7: the answers --------------------------------------------------------------


@by_name
def test_the_probe_and_both_endpoints_answer_as_the_configuration_says(
    reports: dict[str, dict[str, Any]], scenario: Scenario
) -> None:
    report = reports[scenario.name]

    assert report["health"]["status"] == 200
    assert report["health"]["body"] == {"configured": True, "animation": scenario.health}
    assert error_of(report["post"]) == scenario.post
    assert error_of(report["reader"]) == scenario.reader
    assert error_of(report["reader_bad_id"]) == scenario.reader_bad_id
    assert report["runtime_built"] is scenario.runtime_built


def test_with_the_flag_unset_both_endpoints_are_503_animation_not_configured(
    reports: dict[str, dict[str, Any]],
) -> None:
    """Requirement 41.7 in its own words, so the requirement is easy to find in a failure."""
    report = reports["flag-unset"]

    assert report["post"]["status"] == 503
    assert report["post"]["body"]["error"]["code"] == "ANIMATION_NOT_CONFIGURED"
    assert report["reader"]["status"] == 503
    assert report["reader"]["body"]["error"]["code"] == "ANIMATION_NOT_CONFIGURED"


# --- source check: where the packages may be imported -----------------------------------------


def heavy_import_problems(sources: list[Source]) -> list[str]:
    """Each place that breaks the lazy-import rule, as `path:line: what`, in source order."""
    problems: list[str] = []
    for source in sources:
        for root, line, ancestors in imported_roots(source):
            if root not in FORBIDDEN:
                continue
            where = f"{source.path}:{line}"
            if source.path not in LAZY_MODULES:
                problems.append(f"{where}: `{root}` may be imported only by {sorted(LAZY_MODULES)}")
            elif not in_function(ancestors) and not under_type_checking(ancestors):
                problems.append(f"{where}: `{root}` is imported at module or class level")
        for target in dynamic_import_targets(source):
            if target.split(".")[0] in FORBIDDEN and source.path not in LAZY_MODULES:
                problems.append(f"{source.path}: `{target}` is imported by name")
    return problems


def under_type_checking(ancestors: tuple[ast.AST, ...]) -> bool:
    """True inside `if TYPE_CHECKING:` (or `if typing.TYPE_CHECKING:`), which never runs."""
    for node in ancestors:
        if isinstance(node, ast.If):
            test = node.test
            if isinstance(test, ast.Name) and test.id == "TYPE_CHECKING":
                return True
            if isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING":
                return True
    return False


def test_the_packages_are_imported_only_inside_functions_of_three_modules() -> None:
    assert heavy_import_problems(read_tree(APP)) == []


def test_the_three_modules_do_import_the_packages_so_the_check_has_something_to_check() -> None:
    sources = [s for s in read_tree(APP) if s.path in LAZY_MODULES]
    roots = {root for s in sources for root, _, _ in imported_roots(s)}

    assert {s.path for s in sources} == LAZY_MODULES
    assert roots & set(FORBIDDEN) == set(FORBIDDEN)


@pytest.mark.parametrize(
    ("path", "text", "expected"),
    [
        ("app/ai/animation/agent.py", "import langgraph\n", "imported at module or class level"),
        (
            "app/ai/animation/store.py",
            "from boto3.session import Session\n",
            "imported at module or class level",
        ),
        (
            "app/ai/animation/store.py",
            "class A:\n    import botocore\n",
            "imported at module or class level",
        ),
        (
            "app/ai/animation/store.py",
            "try:\n    import boto3\nexcept ImportError:\n    boto3 = None\n",
            "imported at module or class level",
        ),
        ("app/ai/animation/endpoint.py", "def f():\n    import boto3\n", "may be imported only by"),
        ("app/main.py", "from botocore.config import Config\n", "may be imported only by"),
        ("app/ai/animation/models.py", "import langgraph.graph\n", "may be imported only by"),
        ("app/ai/pipeline.py", "x = __import__('boto3')\n", "is imported by name"),
        (
            "app/ai/pipeline.py",
            "import importlib\nimportlib.import_module('botocore.x')\n",
            "by name",
        ),
    ],
)
def test_the_checker_fails_on_a_misplaced_import(path: str, text: str, expected: str) -> None:
    problems = heavy_import_problems([parse(path, text)])

    assert len(problems) == 1
    assert expected in problems[0]


@pytest.mark.parametrize(
    "text",
    [
        "def build():\n    from langgraph.graph import END\n",
        "async def f():\n    import boto3\n",
        "class A:\n    def m(self):\n        from botocore.config import Config\n",
        "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import botocore\n",
        "import typing\nif typing.TYPE_CHECKING:\n    from boto3 import Session\n",
        "import json\nfrom app.ai.limits import AiLimiter\n",
    ],
)
def test_the_checker_accepts_a_lazy_import(text: str) -> None:
    assert heavy_import_problems([parse("app/ai/animation/store.py", text)]) == []


# --- the other half: with the real packages, they load on demand -------------------------------


def _missing_packages() -> list[str]:
    return [name for name in FORBIDDEN if importlib.util.find_spec(name) is None]


@pytest.mark.skipif(
    bool(_missing_packages()),
    reason=(
        f"{_missing_packages()} not installed here [belum diverifikasi]. Run where they are: "
        "`cd backend && pip install -r requirements.txt -r requirements-dev.txt && "
        "pytest -q tests/test_animation_memory.py -rs`"
    ),
)
def test_with_the_real_packages_the_graph_and_the_s3_client_load_them_on_demand(
    record_property: Any,
) -> None:
    """Importing `app.main` loads none; `build_graph()` loads `langgraph`; the S3 client, `boto3`.

    No finder here: this child lets the real packages in. It asserts only which names appear in
    `sys.modules` after each step, and records the RSS in MiB (`/proc/self/status`, `None` where
    that file does not exist) as test properties so they reach the JUnit report. The numbers are
    information for the operator's measurement in `docs/infra/12-remotion-animation.md`
    (Requirement 41.2), not a threshold: nothing asserts how much the packages weigh.

    [belum diverifikasi] against real `langgraph` and `boto3`: they are not installed in the
    sandbox where this was written, so this test has only been read, not run. It builds the real
    graph (`StateGraph(...).compile()`) and the real S3 client for a region, with no network and no
    credentials (creating a boto3 client does not need either).
    """
    report = run_child(
        _DEMAND,
        {"block": False},
        {**clean_environment(), "ANIMATION_ENABLED": "false"},
    )
    stages = report["stages"]

    assert stages["import"]["loaded"] == []
    assert "langgraph" in stages["graph"]["loaded"]
    assert "boto3" in stages["s3-client"]["loaded"]
    assert "botocore" in stages["s3-client"]["loaded"]
    for step, value in report["rss_mib"].items():
        record_property(f"rss_mib_{step}", value)
