"""Guards against writing twice what the code base already has (task 18.5; Requirements 39.1-39.5,
39.9, 39.12, 32.7, 4.8, 38.5).

Why: the animation feature sits on top of an AI backend that already has a Gemini client, a limiter,
an envelope, a request guard, a visual validator, an owner cookie and a UTF-16 and trim vocabulary
that matches JavaScript. A second copy of any of them would work on the day it is written and then
drift: a retry rule fixed in one client and not in the other, a limiter that does not count the
requests the other counts, a trim that disagrees with Zod about one space. Nothing in a behaviour
test notices a duplicate that behaves the same today, so these tests read the source (syntax trees
and text, never importing `app`) and fail when a second definition appears.

Each rule is a function over parsed sources and is tried on a few invented sources first, so the
tests are known to fail on a copy and do not pass only because the real tree is clean.

The rules (design 15, "kode yang sengaja TIDAK dibuat kedua kalinya"):

1. one `COOKIE_NAME`, and the cookie's text written in one module only (39.5, 39.9);
2. `httpx2` imported only by `gemini_client.py` and `runtime.py`, and no other HTTP client library
   anywhere (39.1, 39.12); the Gemini host named in one module only (4.8, 39.9);
3. `requirements.txt` pins every dependency with `==`, names no Gemini SDK, and the two packages
   this feature added are there; no mocking library for AWS; the image installs only from the
   pinned file (32.7, 39.12, 38.5);
4. a table of shared helpers (`utf16_length`, `js_trim`, `AiLimiter`, `GeminiRequest`,
   `generate_text`, `entry_guard`, the envelope, the visual validator, `client_ip` and `limit_ip`,
   the owner functions, and more) each defined at module scope in exactly one module (39.1-39.5);
5. the other direction: the animation modules do import and call those helpers (39.2-39.5);
6. no second in-memory limiter, and no custom logger class (design 15).

Not here: Requirement 39.9 also says the frontend has no second player and 39.14 limits who
imports `@remotion/player`. Those are frontend tests (`frontend/tests/`).
"""

from __future__ import annotations

import ast
import re

import pytest

from tests.animation_source_support import (
    APP,
    BACKEND,
    TESTS,
    Source,
    assigned_names,
    dynamic_import_targets,
    imported_names,
    imported_roots,
    module_scope_definitions,
    parse,
    read_tree,
    string_literals,
    walk,
)

GEMINI_CLIENT = "app/ai/gemini_client.py"
RUNTIME = "app/ai/runtime.py"
OWNER = "app/owner.py"


@pytest.fixture(scope="module")
def app_sources() -> list[Source]:
    return read_tree(APP)


@pytest.fixture(scope="module")
def test_sources() -> list[Source]:
    return read_tree(TESTS)


def at(sources: list[Source], path: str) -> Source:
    """The source of `path` (as `app/...`); fails with the list of paths when it is missing."""
    for source in sources:
        if source.path == path:
            return source
    raise AssertionError(f"{path} is not under app/: {[s.path for s in sources][:5]}...")


def dotted(node: ast.AST) -> str:
    """`a.b.c` for a chain of names and attributes; `.attr` when the base is not a name.

    `replace(x).generate_text` is `.generate_text`; a call or a subscript alone is `""`.
    """
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{dotted(node.value)}.{node.attr}"
    return ""


def called_names(source: Source) -> set[str]:
    """Dotted names of everything the file calls: `js_trim`, `pipeline.entry_guard`, `x.y.z`."""
    return {
        dotted(node.func)
        for node, _ in walk(source.tree)
        if isinstance(node, ast.Call) and dotted(node.func)
    }


# --- 1. the owner cookie (Requirements 39.5, 39.9) ---------------------------------------------


def cookie_problems(sources: list[Source], value: str, home: str) -> list[str]:
    """Where `COOKIE_NAME` is bound, or the cookie text written, outside `home`."""
    problems: list[str] = []
    for source in sources:
        if source.path != home and "COOKIE_NAME" in assigned_names(source):
            problems.append(f"{source.path}: defines COOKIE_NAME again")
        if source.path != home and value in string_literals(source):
            problems.append(f"{source.path}: writes the cookie name {value!r} itself")
    return problems


def test_cookie_name_is_defined_in_one_module_only(
    app_sources: list[Source], test_sources: list[Source]
) -> None:
    sites = [s.path for s in (*app_sources, *test_sources) if "COOKIE_NAME" in assigned_names(s)]

    assert sites == [OWNER]


def test_the_cookie_name_is_written_in_one_module_only(app_sources: list[Source]) -> None:
    from app.owner import COOKIE_NAME

    assert cookie_problems(app_sources, COOKIE_NAME, OWNER) == []
    assert COOKIE_NAME in string_literals(at(app_sources, OWNER))


def test_the_cookie_checker_fails_on_a_second_definition_or_a_second_spelling() -> None:
    other = parse("app/ai/animation/endpoint.py", 'COOKIE_NAME = "x"\n')
    typed = parse("app/ai/animation/sse.py", 'COOKIE: str = "lore_device"\nx = COOKIE_NAME\n')
    prose = parse("app/ai/routes.py", '"""The `lore_device` cookie."""\nCOOKIE_NAME = None\n')

    assert cookie_problems([other], "lore_device", OWNER) == [
        "app/ai/animation/endpoint.py: defines COOKIE_NAME again"
    ]
    assert cookie_problems([typed], "lore_device", OWNER) == [
        "app/ai/animation/sse.py: writes the cookie name 'lore_device' itself"
    ]
    # A docstring that names the cookie is prose, but a rebinding of the constant is not.
    assert cookie_problems([prose], "lore_device", OWNER) == [
        "app/ai/routes.py: defines COOKIE_NAME again"
    ]


# --- 2. one HTTP client, one Gemini host (Requirements 39.1, 39.12, 4.8, 39.9) ----------------

HTTPX2_HOMES = frozenset({GEMINI_CLIENT, RUNTIME})
OTHER_HTTP_CLIENTS = frozenset({"httpx", "requests", "aiohttp", "urllib3", "pycurl"})


def http_client_problems(sources: list[Source]) -> list[str]:
    """`httpx2` outside its two homes, and any other HTTP client library anywhere."""
    problems: list[str] = []
    for source in sources:
        roots = {root for root, _, _ in imported_roots(source)}
        roots |= {target.split(".")[0] for target in dynamic_import_targets(source)}
        if "httpx2" in roots and source.path not in HTTPX2_HOMES:
            problems.append(f"{source.path}: imports httpx2")
        for other in sorted(roots & OTHER_HTTP_CLIENTS):
            problems.append(f"{source.path}: imports {other}, a second HTTP client library")
    return problems


def test_httpx2_is_imported_only_by_the_gemini_client_and_the_runtime(
    app_sources: list[Source],
) -> None:
    assert http_client_problems(app_sources) == []
    client = at(app_sources, GEMINI_CLIENT)
    assert "httpx2" in {root for root, _, _ in imported_roots(client)}  # the check sees the client


@pytest.mark.parametrize(
    ("path", "text"),
    [
        ("app/ai/animation/agent.py", "import httpx2\n"),
        ("app/ai/animation/store.py", "from httpx2 import AsyncClient\n"),
        ("app/ai/animation/sse.py", "import httpx2.sub\n"),
        ("app/ai/animation/endpoint.py", "import importlib\nimportlib.import_module('httpx2')\n"),
        ("app/ai/animation/endpoint.py", "m = __import__('httpx2')\n"),
        ("app/ai/animation/agent.py", "import httpx\n"),
        ("app/ai/animation/agent.py", "import requests\n"),
        ("app/db.py", "from aiohttp import ClientSession\n"),
    ],
)
def test_the_http_checker_fails_on_a_second_client(path: str, text: str) -> None:
    assert len(http_client_problems([parse(path, text)])) == 1


@pytest.mark.parametrize("path", sorted(HTTPX2_HOMES))
def test_the_http_checker_accepts_the_two_homes(path: str) -> None:
    assert http_client_problems([parse(path, "import httpx2\n")]) == []


def files_mentioning(root_files: dict[str, str], needle: str) -> list[str]:
    return sorted(path for path, text in root_files.items() if needle in text)


def app_text_files() -> dict[str, str]:
    """Every readable text file under `app/` by path (the animation contract JSON included)."""
    found: dict[str, str] = {}
    for file in sorted(APP.rglob("*")):
        if not file.is_file() or "__pycache__" in file.parts or file.suffix == ".pyc":
            continue
        try:
            found[file.relative_to(BACKEND).as_posix()] = file.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
    return found


def test_the_gemini_host_is_named_in_exactly_one_module() -> None:
    """Requirement 4.8: `generativelanguage.googleapis.com` in `gemini_client.py` and nowhere else.

    The test looks for `generativelanguage`, which is shorter than the host name, so a URL built
    from pieces or a second host spelling (`generativelanguage.mtls.googleapis.com`) is found too.
    """
    files = app_text_files()

    assert files_mentioning(files, "generativelanguage.googleapis.com") == [GEMINI_CLIENT]
    assert files_mentioning(files, "generativelanguage") == [GEMINI_CLIENT]


def test_the_host_checker_finds_a_copy_in_a_docstring_a_string_or_a_json_file() -> None:
    files = {
        GEMINI_CLIENT: 'URL = "https://generativelanguage.googleapis.com/v1beta/models"\n',
        "app/ai/animation/agent.py": '"""Calls generativelanguage.googleapis.com."""\n',
        "app/ai/animation/animation-contract.json": '{"x": "generativelanguage"}',
        "app/main.py": "app = None\n",
    }

    assert files_mentioning(files, "generativelanguage") == [
        "app/ai/animation/agent.py",
        "app/ai/animation/animation-contract.json",
        GEMINI_CLIENT,
    ]


# --- 3. dependencies (Requirements 32.7, 39.12, 38.5) ------------------------------------------

PIN = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"(?:\[(?P<extras>[A-Za-z0-9._,-]+)\])?"
    r"==(?P<version>[0-9][A-Za-z0-9.+!_-]*)"
    r"(?:\s*;.*)?$"
)
GEMINI_SDKS = (
    "google-genai",
    "google-generativeai",
    "google-ai-generativelanguage",
    "langchain-google-genai",
)
NEW_DEPENDENCIES = ("langgraph", "boto3")


def requirement_lines(text: str) -> list[str]:
    """The requirement specifiers of a requirements file: no blanks, comments or `-r` options."""
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.split(" #")[0].strip()
        if line and not line.startswith(("#", "-")):
            lines.append(line)
    return lines


def normalized(name: str) -> str:
    """The PEP 503 form of a package name (`Google_GenAI` and `google.genai` are one package)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def unpinned(text: str) -> list[str]:
    """Each specifier that is not `name==version` (or `name[extra]==version`)."""
    return [line for line in requirement_lines(text) if PIN.match(line) is None]


def pins(text: str) -> dict[str, str]:
    """`{normalized name: version}` of the pinned specifiers."""
    found: dict[str, str] = {}
    for line in requirement_lines(text):
        match = PIN.match(line)
        if match:
            found[normalized(match["name"])] = match["version"]
    return found


def names(text: str) -> set[str]:
    """Normalized names of every specifier, pinned or not."""
    return {
        normalized(re.split(r"[\[<>=!~; ]", line, maxsplit=1)[0])
        for line in requirement_lines(text)
    }


def read_backend(name: str) -> str:
    return (BACKEND / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("file", ["requirements.txt", "requirements-dev.txt"])
def test_every_dependency_is_pinned_to_an_exact_version(file: str) -> None:
    assert unpinned(read_backend(file)) == []


def test_the_two_packages_the_feature_added_are_pinned() -> None:
    found = pins(read_backend("requirements.txt"))

    for name in NEW_DEPENDENCIES:
        assert re.fullmatch(r"[0-9]+(\.[0-9]+)*", found.get(name, "")), f"{name} is not pinned"


@pytest.mark.parametrize("file", ["requirements.txt", "requirements-dev.txt"])
def test_no_google_gemini_sdk_is_a_dependency(file: str) -> None:
    """Requirement 39.12: the one Gemini client is `gemini_client.py` over `httpx2`."""
    assert names(read_backend(file)) & set(GEMINI_SDKS) == set()


@pytest.mark.parametrize("file", ["requirements.txt", "requirements-dev.txt"])
def test_no_aws_mocking_library_is_a_dependency(file: str) -> None:
    """Requirement 38.5: S3 is faked in memory (`tests/fake_s3.py`), without `moto`."""
    assert names(read_backend(file)) & {"moto"} == set()


def test_the_image_installs_from_the_pinned_file_and_nothing_else() -> None:
    """The Dockerfile has no `pip install` of a package named on the command line."""
    installs = [
        line.strip() for line in read_backend("Dockerfile").splitlines() if "pip install" in line
    ]

    assert installs, "the Dockerfile no longer has a pip install line"
    for line in installs:
        assert "-r requirements.txt" in line, line


@pytest.mark.parametrize(
    "line",
    [
        "langgraph>=1.2",
        "langgraph~=1.2.24",
        "langgraph",
        "langgraph==1.*",
        "langgraph===1.2.24",
        "langgraph<=1.2.24",
        "boto3!=1.0",
        "boto3 >=1.44",
        "git+https://example.invalid/boto3.git",
        "boto3==",
        "boto3==latest",
        "uvicorn[standard]",
    ],
)
def test_the_pin_checker_fails_on_a_loose_specifier(line: str) -> None:
    assert unpinned(f"fastapi==0.163.2\n{line}\n") == [line]


@pytest.mark.parametrize(
    "line",
    [
        "langgraph==1.2.24",
        "uvicorn[standard]==0.54.0",
        "Psycopg[binary]==3.3.9",
        "numpy==2.0.0 ; python_version >= '3.12'",
        "boto3==1.44.13  # the Lambda client",
    ],
)
def test_the_pin_checker_accepts_an_exact_pin(line: str) -> None:
    assert unpinned(f"# comment\n\n-r other.txt\n{line}\n") == []


def test_the_name_readers_see_through_case_extras_and_separators() -> None:
    text = "Google_GenAI==1.0\ngoogle.generativeai>=1\nlangchain-google-genai\nMOTO[s3]==5.0\n"

    assert names(text) == {"google-genai", "google-generativeai", "langchain-google-genai", "moto"}
    assert pins(text) == {"google-genai": "1.0", "moto": "5.0"}


# --- 4. one definition of each shared helper (Requirements 39.1-39.5) --------------------------

CLIENT = GEMINI_CLIENT
LIMITS = "app/ai/limits.py"
ENVELOPE = "app/ai/envelope.py"
PIPELINE = "app/ai/pipeline.py"
ZOD = "app/ai/zod_compat.py"
VISUAL = "app/ai/contracts/visual.py"
REQUESTS = "app/ai/contracts/requests.py"
PROJECTS = "app/projects.py"

# name -> the module that defines it. A name appears at module scope in that module and in no other
# (methods do not count: `AiContext.generate_text` is a method that calls the one function).
SHARED: dict[str, str] = {
    "utf16_length": REQUESTS,
    "js_trim": ZOD,
    "ZodModel": ZOD,
    "zod_flatten": ZOD,
    "AiLimiter": LIMITS,
    "AiLimits": LIMITS,
    "Denied": LIMITS,
    "denied_to_error": LIMITS,
    "GeminiRequest": CLIENT,
    "GeminiOk": CLIENT,
    "GeminiTextOk": CLIENT,
    "GeminiFailure": CLIENT,
    "generate_json": CLIENT,
    "generate_text": CLIENT,
    "parse_json_text": CLIENT,
    "AiContext": RUNTIME,
    "AiRuntime": RUNTIME,
    "entry_guard": PIPELINE,
    "Accepted": PIPELINE,
    "read_limited_body": PIPELINE,
    "parse_json_body": PIPELINE,
    "handle_ai_request": PIPELINE,
    "AiOk": ENVELOPE,
    "AiError": ENVELOPE,
    "to_response": ENVELOPE,
    "status_for_code": ENVELOPE,
    "unknown_error": ENVELOPE,
    "parse_lesson_visual": VISUAL,
    "VisualOk": VISUAL,
    "VisualInvalid": VISUAL,
    "VectorsVisual": VISUAL,
    "PlotVisual": VISUAL,
    "DiagramVisual": VISUAL,
    "TableVisual": VISUAL,
    "FormulaVisual": VISUAL,
    "client_ip": PROJECTS,
    "limit_ip": PROJECTS,
    "get_owner_id": OWNER,
    "device_token_middleware": OWNER,
}


def definition_sites(sources: list[Source], name: str) -> list[str]:
    """Paths that define `name` as a function or class at module scope, one entry per definition."""
    return [
        source.path
        for source in sources
        for _, defined in module_scope_definitions(source)
        if defined == name
    ]


@pytest.mark.parametrize(("name", "home"), sorted(SHARED.items()))
def test_a_shared_helper_has_one_definition(
    app_sources: list[Source], name: str, home: str
) -> None:
    assert definition_sites(app_sources, name) == [home]


def test_the_definition_checker_finds_a_copy_wherever_it_hides() -> None:
    home = parse("app/ai/zod_compat.py", "def js_trim(text):\n    return text\n")
    copy = parse("app/ai/animation/models.py", "def js_trim(s):\n    return s.strip()\n")
    hidden = parse(
        "app/ai/animation/tokens.py", "if True:\n    def js_trim(s):\n        return s\n"
    )
    cls = parse("app/ai/animation/limits.py", "class AiLimiter:\n    pass\n")
    method = parse("app/ai/runtime.py", "class A:\n    def js_trim(self):\n        pass\n")
    nested = parse("app/ai/x.py", "def f():\n    def js_trim(s):\n        return s\n")

    assert definition_sites([home, copy, hidden, method, nested], "js_trim") == [
        "app/ai/zod_compat.py",
        "app/ai/animation/models.py",
        "app/ai/animation/tokens.py",
    ]
    assert definition_sites([cls], "AiLimiter") == ["app/ai/animation/limits.py"]


# --- 5. the animation modules use them (Requirements 39.2-39.5) --------------------------------

# (module, the module it must import from, the names it must import)
USES = (
    ("app/ai/animation/agent.py", "app.ai.gemini_client", {"GeminiRequest"}),
    ("app/ai/animation/agent.py", "app.ai.runtime", {"AiContext"}),
    ("app/ai/animation/endpoint.py", "app.ai", {"pipeline"}),
    ("app/ai/animation/endpoint.py", "app.ai.envelope", {"AiError", "AiOk", "to_response"}),
    ("app/ai/animation/endpoint.py", "app.ai.limits", {"AiLimiter", "denied_to_error"}),
    ("app/ai/animation/endpoint.py", "app.owner", {"get_owner_id"}),
    ("app/ai/animation/endpoint.py", "app.projects", {"limit_ip"}),
    ("app/ai/animation/limits.py", "app.ai.limits", {"AiLimiter", "AiLimits"}),
    ("app/ai/animation/models.py", "app.ai.contracts.requests", {"utf16_length"}),
    ("app/ai/animation/models.py", "app.ai.contracts.visual", {"parse_lesson_visual"}),
    ("app/ai/animation/models.py", "app.ai.zod_compat", {"ZodModel", "js_trim"}),
    ("app/ai/animation/sse.py", "app.ai.limits", {"AiLimiter"}),
    ("app/ai/animation/tokens.py", "app.ai.zod_compat", {"js_trim"}),
)
# (module, a dotted name it must call). These are the uses that matter: an import alone proves
# nothing, and a copy with the same effect would sit next to an unused import.
CALLS = (
    ("app/ai/animation/agent.py", ".generate_text"),  # `replace(run.ai, ...).generate_text`
    ("app/ai/animation/endpoint.py", "pipeline.entry_guard"),
    ("app/ai/animation/endpoint.py", "denied_to_error"),
    ("app/ai/animation/endpoint.py", "Depends"),
    ("app/ai/animation/limits.py", "AiLimiter"),
    ("app/ai/animation/limits.py", "AiLimits"),
    ("app/ai/animation/models.py", "parse_lesson_visual"),
    ("app/ai/animation/models.py", "utf16_length"),
    ("app/ai/animation/models.py", "js_trim"),
    ("app/ai/animation/tokens.py", "js_trim"),
    (PIPELINE, "entry_guard"),
)


def missing_imports(source: Source, module: str, wanted: set[str]) -> set[str]:
    return wanted - imported_names(source).get(module, set())


@pytest.mark.parametrize(("path", "module", "wanted"), USES)
def test_an_animation_module_imports_the_shared_helper(
    app_sources: list[Source], path: str, module: str, wanted: set[str]
) -> None:
    assert missing_imports(at(app_sources, path), module, wanted) == set()


@pytest.mark.parametrize(("path", "call"), CALLS)
def test_an_animation_module_calls_the_shared_helper(
    app_sources: list[Source], path: str, call: str
) -> None:
    assert call in called_names(at(app_sources, path))


def test_the_reader_is_guarded_by_the_projects_limit_ip_dependency(
    app_sources: list[Source],
) -> None:
    """Requirement 39.5: `Depends(limit_ip)`, the one from `projects.py`, not a copy."""
    endpoint = at(app_sources, "app/ai/animation/endpoint.py")
    depends = [
        node
        for node, _ in walk(endpoint.tree)
        if isinstance(node, ast.Call) and dotted(node.func) == "Depends"
    ]

    assert [dotted(arg) for call in depends for arg in call.args] == ["limit_ip"]


def test_the_animation_limiter_is_an_ai_limiter_built_in_limits(app_sources: list[Source]) -> None:
    """`animation_limiter_from_env` returns `AiLimiter(...)`, not a class of its own."""
    source = at(app_sources, "app/ai/animation/limits.py")
    builders = [
        node
        for node, _ in walk(source.tree)
        if isinstance(node, ast.FunctionDef) and node.name == "animation_limiter_from_env"
    ]

    assert len(builders) == 1
    built = {
        dotted(node.func)
        for node in ast.walk(builders[0])
        if isinstance(node, ast.Call) and dotted(node.func)
    }
    assert {"AiLimiter", "AiLimits"} <= built


def test_the_uses_checker_fails_when_an_import_or_a_call_is_missing() -> None:
    source = parse(
        "app/ai/animation/models.py",
        "from app.ai.zod_compat import ZodModel\nx = ZodModel()\n",
    )

    assert missing_imports(source, "app.ai.zod_compat", {"ZodModel", "js_trim"}) == {"js_trim"}
    assert missing_imports(source, "app.ai.contracts.visual", {"parse_lesson_visual"}) == {
        "parse_lesson_visual"
    }
    assert "js_trim" not in called_names(source)
    assert "ZodModel" in called_names(source)


# --- 6. no second limiter, no custom logger (design 15) ----------------------------------------

LIMITER_CLASSES = frozenset({(LIMITS, "AiLimiter"), ("app/ratelimit.py", "RateLimiter")})
LIMITER_METHODS = frozenset({"try_acquire", "check_daily"})
CUSTOM_LOGGING_LIBRARIES = frozenset({"loguru", "structlog"})
LOGGER_BASES = frozenset({"Logger", "LoggerAdapter"})


def limiter_problems(sources: list[Source]) -> list[str]:
    """A class named `*Limiter` that is not one of the two that exist, or with an `AiLimiter` API.

    The animation limiter is an `AiLimiter` (design 6.11); the projects limiter is `RateLimiter`
    and was there before this feature. A third class that counts requests per IP would be a
    limiter that shares no counters with either and is easy to forget to test.
    """
    problems: list[str] = []
    for source in sources:
        for node, _ in walk(source.tree):
            if not isinstance(node, ast.ClassDef):
                continue
            methods = {
                item.name
                for item in node.body
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
            known = (source.path, node.name) in LIMITER_CLASSES
            if node.name.endswith("Limiter") and not known:
                problems.append(f"{source.path}: class {node.name} is a second limiter")
            if methods & LIMITER_METHODS and (source.path, node.name) != (LIMITS, "AiLimiter"):
                problems.append(f"{source.path}: class {node.name} copies the AiLimiter methods")
    return problems


def logging_problems(sources: list[Source]) -> list[str]:
    """A subclass of `logging.Logger` or `LoggerAdapter`, or a logging library other than stdlib."""
    problems: list[str] = []
    for source in sources:
        for root, _, _ in imported_roots(source):
            if root in CUSTOM_LOGGING_LIBRARIES:
                problems.append(f"{source.path}: imports {root}")
        for node, _ in walk(source.tree):
            if isinstance(node, ast.ClassDef):
                bases = {dotted(base).split(".")[-1] for base in node.bases}
                if bases & LOGGER_BASES:
                    problems.append(f"{source.path}: class {node.name} is a custom logger")
    return problems


def test_there_is_no_second_in_memory_limiter(app_sources: list[Source]) -> None:
    assert limiter_problems(app_sources) == []


def test_there_is_no_custom_logger(app_sources: list[Source]) -> None:
    assert logging_problems(app_sources) == []


def test_the_limiter_checker_fails_on_a_copy() -> None:
    copy = parse(
        "app/ai/animation/limits.py",
        "class AnimationLimiter:\n    def try_acquire(self, ip):\n        pass\n",
    )
    renamed = parse("app/x.py", "class Quota:\n    def check_daily(self, ip):\n        pass\n")
    other = parse("app/ai/animation/limits.py", "class RateLimiter:\n    pass\n")
    home = parse(LIMITS, "class AiLimiter:\n    def try_acquire(self, ip):\n        pass\n")

    assert limiter_problems([copy]) == [
        "app/ai/animation/limits.py: class AnimationLimiter is a second limiter",
        "app/ai/animation/limits.py: class AnimationLimiter copies the AiLimiter methods",
    ]
    assert limiter_problems([renamed]) == ["app/x.py: class Quota copies the AiLimiter methods"]
    assert limiter_problems([other]) == [
        "app/ai/animation/limits.py: class RateLimiter is a second limiter"
    ]
    assert limiter_problems([home]) == []


def test_the_logging_checker_fails_on_a_custom_logger() -> None:
    subclass = parse("app/a.py", "import logging\nclass L(logging.Logger):\n    pass\n")
    adapter = parse(
        "app/b.py", "from logging import LoggerAdapter\nclass A(LoggerAdapter):\n    pass\n"
    )
    library = parse("app/c.py", "import structlog\n")
    plain = parse("app/d.py", "import logging\nlogger = logging.getLogger('lore.ai')\n")

    assert logging_problems([subclass]) == ["app/a.py: class L is a custom logger"]
    assert logging_problems([adapter]) == ["app/b.py: class A is a custom logger"]
    assert logging_problems([library]) == ["app/c.py: imports structlog"]
    assert logging_problems([plain]) == []
