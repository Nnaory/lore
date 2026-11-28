"""Tests for how the Animation_Agent is assembled (`app.ai.animation.agent`, task 17.1).

Why: the agent is built so that everything that decides something (routing, nodes, deadlines) is
plain Python, and LangGraph is a thin shell over it (design 6.6, Requirement 41.1). These tests
prove the split and the shell:

- importing `agent.py` loads neither `langgraph`, `boto3` nor `botocore`, and the only place in the
  file that names `langgraph` is the body of `build_graph()` (an AST scan, plus a subprocess);
- the edge table and the pure routing say what design 6.6 says;
- `build_graph()` registers the five nodes and the edges of the table, once, and nothing else. It
  runs here against a stub of the `langgraph.graph` API, because the package is not installed in
  every environment;
- the driver loop (`run_agent(run)`) and the graph (`run_agent(run, graph=build_graph())`) give the
  same result, events, calls and writes on the same scripted runs (a parity table);
- the same parity table runs against the REAL `langgraph` when it is installed, and is skipped with
  a reason when it is not.

What is and is not proved. The stub is my recollection of the LangGraph API (`StateGraph(schema)`,
`add_node`, `add_edge`, `add_conditional_edges`, `compile`, `ainvoke(input, config)`, the `START`
and `END` names, the rule that a node name may not equal a state key, the habit of reading type
hints of a node). It proves that `build_graph()` uses those calls consistently and that the node
wrappers have no unresolvable annotations. It does not prove LangGraph itself. The one test that
does is `test_real_langgraph_matches_the_driver`. [belum diverifikasi]: that test was written
without the package. Run it where `langgraph` is installed (CI `ci/api` installs it from
`requirements.txt`):

    cd backend && .venv/bin/python -m pytest -q tests/test_animation_agent_graph.py -rs

Every test builds its own rig (`tests/animation_agent_support.py`) and runs it in one
`asyncio.run`. No network, no database, no AWS SDK.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import logging
import subprocess
import sys
import textwrap
import types
import typing
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx2
import pytest

from app.ai.animation import agent
from app.ai.animation.agent import (
    NODES,
    ROUTES,
    STATIC_EDGES,
    AgentFailed,
    AgentPublished,
    AgentState,
    build_graph,
    decide_after_verify,
    next_node,
    route_after_verify,
    run_agent,
)
from app.ai.animation.logging_ import BOTO_LOGGERS
from app.ai.animation.registry import RegistryError
from tests.animation_agent_support import (
    Rig,
    crashed,
    fenced,
    make_rig,
    rejected,
    source,
    unavailable,
    verified,
)

BACKEND_DIR = Path(__file__).resolve().parent.parent
AGENT_PATH = BACKEND_DIR / "app" / "ai" / "animation" / "agent.py"

START, END = "__start__", "__end__"


# --- a stub of the langgraph.graph API --------------------------------------------------------


class StubCompiled:
    """What `StateGraph.compile()` returns: runs the nodes one after the other."""

    def __init__(self, graph: StubStateGraph) -> None:
        self.graph = graph
        self.configs: list[dict[str, Any]] = []

    async def ainvoke(self, state: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        self.configs.append(config)
        limit = config["recursion_limit"]
        values = dict(state)
        node = self.graph.target(START)
        steps = 0
        while node != END:
            steps += 1
            if steps > limit:
                raise RuntimeError("GraphRecursionError")
            update = await self.graph.nodes[node](values, config)
            values.update(update)
            if node in self.graph.conditional:
                path, path_map = self.graph.conditional[node]
                node = path_map[path(values)]
            else:
                node = self.graph.target(node)
        return values


class StubStateGraph:
    """The subset of `langgraph.graph.StateGraph` that `build_graph()` uses, with its checks."""

    instances: list[StubStateGraph] = []

    def __init__(self, schema: type) -> None:
        self.state_keys = set(typing.get_type_hints(schema))
        self.nodes: dict[str, Callable[..., Any]] = {}
        self.edges: list[tuple[str, str]] = []
        self.conditional: dict[str, tuple[Callable[..., str], dict[str, str]]] = {}
        self.compiled: StubCompiled | None = None
        self.compile_calls = 0
        StubStateGraph.instances.append(self)

    def add_node(self, name: str, action: Callable[..., Any]) -> None:
        if name in self.state_keys:
            raise ValueError(f"'{name}' is already being used as a state key")
        typing.get_type_hints(action)  # the real library reads hints; this fails on a bad name
        self.nodes[name] = action

    def add_edge(self, start: str, end: str) -> None:
        self.edges.append((start, end))

    def add_conditional_edges(
        self, source_node: str, path: Callable[..., str], path_map: dict[str, str]
    ) -> None:
        self.conditional[source_node] = (path, path_map)

    def target(self, node: str) -> str:
        targets = [end for start, end in self.edges if start == node]
        assert len(targets) == 1, f"{node} needs exactly one outgoing edge, has {targets}"
        return targets[0]

    def compile(self) -> StubCompiled:
        known = {START, END, *self.nodes}
        for start, end in self.edges:
            assert start in known and end in known, (start, end)
        for node, (_, path_map) in self.conditional.items():
            assert node in self.nodes
            assert set(path_map.values()) <= known
        self.compile_calls += 1
        self.compiled = StubCompiled(self)
        return self.compiled


@pytest.fixture
def stub_langgraph(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[StubStateGraph]]:
    """Put a stub `langgraph.graph` in `sys.modules` and start from an empty `build_graph` cache."""
    package = types.ModuleType("langgraph")
    graph_module = types.ModuleType("langgraph.graph")
    graph_module.START = START  # type: ignore[attr-defined]
    graph_module.END = END  # type: ignore[attr-defined]
    graph_module.StateGraph = StubStateGraph  # type: ignore[attr-defined]
    package.graph = graph_module  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "langgraph", package)
    monkeypatch.setitem(sys.modules, "langgraph.graph", graph_module)
    StubStateGraph.instances = []
    build_graph.cache_clear()
    yield StubStateGraph
    build_graph.cache_clear()
    StubStateGraph.instances = []


@pytest.fixture
def restore_boto_levels() -> Iterator[None]:
    saved = {name: logging.getLogger(name).level for name in BOTO_LOGGERS}
    yield
    for name, level in saved.items():
        logging.getLogger(name).setLevel(level)


# --- the agent module and the AI packages -----------------------------------------------------


def test_importing_the_agent_loads_no_ai_or_aws_package() -> None:
    code = textwrap.dedent(
        """
        import sys
        import app.ai.animation.agent  # noqa: F401
        loaded = sorted(
            name for name in ("langgraph", "boto3", "botocore") if name in sys.modules
        )
        assert not loaded, loaded
        print("clean")
        """
    )
    done = subprocess.run(
        [sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True, timeout=60
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "clean"


def _imports_outside_functions(tree: ast.Module, prefix: str) -> list[str]:
    """Imports of `prefix` that are not inside a function body (module level, class level)."""
    found: list[str] = []

    def visit(node: ast.AST, inside_function: bool) -> None:
        for child in ast.iter_child_nodes(node):
            names: list[str] = []
            if isinstance(child, ast.Import):
                names = [alias.name for alias in child.names]
            elif isinstance(child, ast.ImportFrom):
                names = [child.module or ""]
            if any(name == prefix or name.startswith(prefix + ".") for name in names):
                if not inside_function:
                    found.extend(names)
            is_function = isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef)
            visit(child, inside_function or is_function)

    visit(tree, False)
    return found


def test_langgraph_is_imported_only_inside_build_graph() -> None:
    tree = ast.parse(AGENT_PATH.read_text(encoding="utf-8"))
    assert _imports_outside_functions(tree, "langgraph") == []
    assert _imports_outside_functions(tree, "boto3") == []
    assert _imports_outside_functions(tree, "botocore") == []
    owners: list[str] = []
    for function in ast.walk(tree):
        if isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
            for node in ast.walk(function):
                if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("langgraph"):
                    owners.append(function.name)
    assert set(owners) == {"build_graph"}


# --- the edge table and the pure routing ------------------------------------------------------


def test_the_edge_table_is_the_graph_of_design_6_6() -> None:
    assert set(NODES) == {"generate", "verify", "repair", "publish", "fail"}
    assert dict(STATIC_EDGES) == {
        "generate": "verify",
        "repair": "verify",
        "publish": None,
        "fail": None,
    }
    assert dict(ROUTES) == {"publish": "publish", "repair": "repair", "fail": "fail"}
    assert agent.FIRST_NODE == "generate"
    assert next_node("generate", {}) == "verify"
    assert next_node("repair", {}) == "verify"
    assert next_node("publish", {}) is None
    assert next_node("fail", {}) is None
    for route in ("publish", "repair", "fail"):
        assert next_node("verify", {"next": route}) == route


@pytest.mark.parametrize(
    "state",
    [{}, {"next": None}, {"next": "verify"}, {"next": 3}, {"next": ""}, {"next": []}, {"next": {}}],
)
def test_a_state_without_a_usable_route_goes_to_fail(state: dict[str, Any]) -> None:
    assert route_after_verify(state) == "fail"
    assert next_node("verify", state) == "fail"


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        (
            {"ok": True, "calls": 1, "max_attempts": 4, "remaining_ms": 0, "terminal": None},
            ("fail", "ANIMATION_TIMEOUT"),
        ),
        (
            {"ok": True, "calls": 1, "max_attempts": 4, "remaining_ms": -5, "terminal": "UNKNOWN"},
            ("fail", "ANIMATION_TIMEOUT"),
        ),
        (
            {"ok": True, "calls": 1, "max_attempts": 4, "remaining_ms": 1, "terminal": "UNKNOWN"},
            ("fail", "UNKNOWN"),
        ),
        (
            {"ok": True, "calls": 4, "max_attempts": 4, "remaining_ms": 1, "terminal": None},
            ("publish", None),
        ),
        (
            {"ok": False, "calls": 3, "max_attempts": 4, "remaining_ms": 1, "terminal": None},
            ("repair", None),
        ),
        (
            {"ok": False, "calls": 4, "max_attempts": 4, "remaining_ms": 1, "terminal": None},
            ("fail", "ANIMATION_VERIFICATION_FAILED"),
        ),
    ],
)
def test_decide_after_verify_follows_the_table(
    kwargs: dict[str, Any], expected: tuple[str, str | None]
) -> None:
    assert decide_after_verify(**kwargs) == expected


# --- build_graph against the stub -------------------------------------------------------------


def test_build_graph_registers_the_nodes_and_the_edges_of_the_table(
    stub_langgraph: type[StubStateGraph], restore_boto_levels: None
) -> None:
    compiled = build_graph()
    (graph,) = stub_langgraph.instances
    assert isinstance(compiled, StubCompiled)
    assert set(graph.nodes) == set(NODES)
    assert set(graph.edges) == {
        (START, "generate"),
        ("generate", "verify"),
        ("repair", "verify"),
        ("publish", END),
        ("fail", END),
    }
    path, path_map = graph.conditional["verify"]
    assert path is route_after_verify
    assert path_map == {"publish": "publish", "repair": "repair", "fail": "fail"}
    assert set(graph.conditional) == {"verify"}


def test_build_graph_compiles_once_per_process(
    stub_langgraph: type[StubStateGraph], restore_boto_levels: None
) -> None:
    first, second = build_graph(), build_graph()
    assert first is second
    assert len(stub_langgraph.instances) == 1
    assert stub_langgraph.instances[0].compile_calls == 1


def test_building_the_graph_holds_the_aws_loggers_at_warning(
    stub_langgraph: type[StubStateGraph], restore_boto_levels: None
) -> None:
    for name in BOTO_LOGGERS:
        logging.getLogger(name).setLevel(logging.DEBUG)
    build_graph()
    assert all(logging.getLogger(name).level >= logging.WARNING for name in BOTO_LOGGERS)


def test_the_node_wrappers_have_no_annotations_for_the_library_to_resolve(
    stub_langgraph: type[StubStateGraph], restore_boto_levels: None
) -> None:
    build_graph()
    (graph,) = stub_langgraph.instances
    for name, action in graph.nodes.items():
        parameters = list(inspect.signature(action).parameters.values())
        assert [p.name for p in parameters] == ["state", "config"], name
        assert all(p.annotation is inspect.Parameter.empty for p in parameters), name
        assert typing.get_type_hints(action) == {}, name


def test_no_node_is_named_like_a_state_key() -> None:
    assert not set(NODES) & set(typing.get_type_hints(AgentState))


def test_run_agent_gives_the_graph_the_run_and_a_recursion_limit(
    stub_langgraph: type[StubStateGraph], restore_boto_levels: None
) -> None:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    graph = build_graph()
    result = asyncio.run(run_agent(rig.run, graph=graph))
    assert isinstance(result, AgentPublished)
    (config,) = graph.configs
    assert config["configurable"]["run"] is rig.run
    assert config["recursion_limit"] == agent.RECURSION_LIMIT
    # The longest path (generate, verify, 3 x (repair, verify), publish) fits well inside it.
    assert agent.RECURSION_LIMIT > 1 + 1 + 3 * 2 + 1


# --- the driver and the graph agree -----------------------------------------------------------


def _happy() -> Rig:
    return make_rig(gemini=[fenced(source(1))], verifier=[verified()])


def _repaired_twice() -> Rig:
    return make_rig(
        gemini=[fenced(source(1)), fenced(source(2)), fenced(source(3))],
        verifier=[rejected("POLICY_FORBIDDEN_IDENTIFIER"), rejected("TSC_2304"), verified()],
    )


def _puzzle() -> Rig:
    return make_rig(kind="puzzle", gemini=[fenced(source(1))], verifier=[verified(kind="puzzle")])


def _never_verifies() -> Rig:
    return make_rig(
        gemini=[fenced(source(n)) for n in range(1, 5)], verifier=[rejected("TSC_2304")] * 4
    )


def _one_attempt_only() -> Rig:
    return make_rig(gemini=[fenced(source(1))], verifier=[rejected("TSC_2304")], max_attempts=1)


def _extract_fails_then_works() -> Rig:
    return make_rig(gemini=["no code here", fenced(source(2))], verifier=[verified()])


def _repair_unchanged() -> Rig:
    return make_rig(
        gemini=[fenced(source(1)), fenced(source(1)), fenced(source(2))],
        verifier=[rejected("TSC_2304"), verified()],
    )


def _crash_then_works() -> Rig:
    return make_rig(gemini=[fenced(source(1)), fenced(source(2))], verifier=[crashed(), verified()])


def _verifier_unavailable() -> Rig:
    return make_rig(gemini=[fenced(source(1))], verifier=[unavailable()])


def _verifier_internal() -> Rig:
    return make_rig(gemini=[fenced(source(1))], verifier=[rejected("VERIFIER_INTERNAL")])


def _gemini_rate_limited() -> Rig:
    return make_rig(gemini=[429])


def _deadline_in_the_verifier() -> Rig:
    rig = make_rig(gemini=[fenced(source(1))])

    async def late(payload: dict[str, Any], remaining_ms: float) -> Any:
        rig.clock.advance_ms(300_000)
        return verified()

    rig.verifier.script.append(late)
    return rig


def _deadline_in_gemini() -> Rig:
    rig = make_rig()

    def late(_request: httpx2.Request) -> httpx2.Response:
        rig.clock.advance_ms(300_000)
        return httpx2.Response(
            200, json={"candidates": [{"content": {"parts": [{"text": fenced(source(1))}]}}]}
        )

    rig.gemini.replies.append(late)
    rig.verifier.script.append(verified())
    return rig


def _quota_exceeded() -> Rig:
    return make_rig(gemini=[fenced(source(1))], verifier=[verified()], registry_limit=0)


def _registry_down() -> Rig:
    return make_rig(
        gemini=[fenced(source(1))], verifier=[verified()], registry_error=RegistryError("down")
    )


def _s3_down() -> Rig:
    rig = make_rig(gemini=[fenced(source(1))], verifier=[verified()])
    rig.s3.fail("put_object", "main.ts", 500, "InternalError", times=5)
    return rig


def _cancelled_before_the_start() -> Rig:
    cancelled = asyncio.Event()
    cancelled.set()
    return make_rig(gemini=[fenced(source(1))], verifier=[verified()], cancelled=cancelled)


SCENARIOS: dict[str, Callable[[], Rig]] = {
    "happy": _happy,
    "repaired-twice": _repaired_twice,
    "puzzle": _puzzle,
    "never-verifies": _never_verifies,
    "one-attempt-only": _one_attempt_only,
    "extract-fails-then-works": _extract_fails_then_works,
    "repair-unchanged": _repair_unchanged,
    "verifier-crash-then-works": _crash_then_works,
    "verifier-unavailable": _verifier_unavailable,
    "verifier-internal": _verifier_internal,
    "gemini-rate-limited": _gemini_rate_limited,
    "deadline-in-the-verifier": _deadline_in_the_verifier,
    "deadline-in-gemini": _deadline_in_gemini,
    "quota-exceeded": _quota_exceeded,
    "registry-down": _registry_down,
    "s3-down": _s3_down,
    "cancelled-before-the-start": _cancelled_before_the_start,
}


def _summary(rig: Rig, result: AgentPublished | AgentFailed) -> dict[str, Any]:
    """Everything a runner could get wrong, with the random `animation_id` taken out."""
    summary: dict[str, Any] = {
        "type": type(result).__name__,
        "calls": result.calls,
        "model": result.model,
        "events": rig.event_names(),
        "gemini_calls": len(rig.gemini.requests),
        "verifier_calls": len(rig.verifier.payloads),
        "s3_ops": rig.s3.ops(),
        "registry_calls": len(rig.registry.calls),
        "cancelled": rig.run.cancelled.is_set(),
    }
    if isinstance(result, AgentPublished):
        reference = result.reference.dump()
        reference.pop("animation_id")
        summary["reference"] = reference
        summary["row_attempts"] = result.row.attempts
    else:
        summary["code"] = result.code
        summary["diagnostic_codes"] = [item.code for item in result.diagnostics]
    return summary


def _run(rig: Rig, graph: Any | None) -> dict[str, Any]:
    result = asyncio.run(run_agent(rig.run, graph=graph))
    return _summary(rig, result)


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_the_stub_graph_gives_the_same_result_as_the_driver(
    name: str, stub_langgraph: type[StubStateGraph], restore_boto_levels: None
) -> None:
    driver = _run(SCENARIOS[name](), None)
    through_graph = _run(SCENARIOS[name](), build_graph())
    assert through_graph == driver


def test_the_scenarios_cover_both_end_states_and_every_failure_code() -> None:
    codes: set[str] = set()
    published = 0
    for factory in SCENARIOS.values():
        rig = factory()
        result = asyncio.run(run_agent(rig.run))
        if isinstance(result, AgentPublished):
            published += 1
        else:
            codes.add(result.code)
    assert published >= 4
    assert codes == {
        "ANIMATION_VERIFICATION_FAILED",
        "ANIMATION_TIMEOUT",
        "ANIMATION_VERIFIER_UNAVAILABLE",
        "ANIMATION_STORAGE_FAILED",
        "ANIMATION_QUOTA_EXCEEDED",
        "RATE_LIMITED",
        "UNKNOWN",
    }


# --- the real LangGraph -----------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_real_langgraph_matches_the_driver(name: str, restore_boto_levels: None) -> None:
    """[belum diverifikasi] Written without the package; run it where `langgraph` is installed.

    Skipped, with a reason, when `langgraph` cannot be imported. It runs every scenario of the
    parity table through `build_graph()` compiled by the real library and compares the result,
    the events, the calls and the writes with the driver loop.
    """
    pytest.importorskip(
        "langgraph.graph",
        reason="langgraph is not installed; the real StateGraph assembly is not verified here",
    )
    build_graph.cache_clear()
    try:
        driver = _run(SCENARIOS[name](), None)
        through_graph = _run(SCENARIOS[name](), build_graph())
    finally:
        build_graph.cache_clear()
    assert through_graph == driver
