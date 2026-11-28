"""Read the backend source as syntax trees, for the structural tests of the animation feature.

Why: two test files (task 18.5) check how the code is built rather than what it does: the lazy
imports of `langgraph`, `boto3` and `botocore` (`test_animation_memory.py`) and the "do not write
this twice" guards (`test_animation_reuse.py`). Both need the same few things: every file under
`app/` parsed once, a walk that knows each node's ancestors, and the list of what a module defines
at module scope. Keeping them here means each rule in those files is a few lines that read like the
rule, and means a rule can be tried on a small made-up source (`parse`) to prove it fails when it
should, not only on the real tree where it passes.

Everything here reads text and syntax trees. It imports nothing from `app`, so reading the source
cannot load a package the tests are about to check for.
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
APP = BACKEND / "app"
TESTS = BACKEND / "tests"

FunctionLike = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


@dataclass(frozen=True)
class Source:
    """One parsed file: its path relative to `backend/` (with `/`), its text and its tree."""

    path: str
    text: str
    tree: ast.Module


def parse(path: str, text: str) -> Source:
    """A `Source` from text, so a rule can be tried on a small invented module."""
    return Source(path, text, ast.parse(text, filename=path))


def read_tree(root: Path) -> list[Source]:
    """Every `.py` file under `root`, sorted by path, parsed."""
    return [
        parse(file.relative_to(BACKEND).as_posix(), file.read_text(encoding="utf-8"))
        for file in sorted(root.rglob("*.py"))
        if "__pycache__" not in file.parts
    ]


def walk(tree: ast.AST) -> Iterator[tuple[ast.AST, tuple[ast.AST, ...]]]:
    """Every node of `tree` in source order, with the tuple of its ancestors (outermost first).

    An explicit stack, not recursion, so a very long expression cannot hit the recursion limit.
    """
    stack: list[tuple[ast.AST, tuple[ast.AST, ...]]] = [(tree, ())]
    while stack:
        node, ancestors = stack.pop()
        yield node, ancestors
        below = (*ancestors, node)
        stack.extend((child, below) for child in reversed(list(ast.iter_child_nodes(node))))


def in_function(ancestors: tuple[ast.AST, ...]) -> bool:
    """True when the node runs only when a function is called (a def, an async def, a lambda)."""
    return any(isinstance(node, FunctionLike) for node in ancestors)


def in_class_or_function(ancestors: tuple[ast.AST, ...]) -> bool:
    """True when the node is not at module scope (it may still sit in an `if` or a `try`)."""
    return any(isinstance(node, (*FunctionLike, ast.ClassDef)) for node in ancestors)


def module_scope_definitions(source: Source) -> list[tuple[str, str]]:
    """`(kind, name)` of each function and class defined at module scope, kind `def` or `class`.

    Module scope includes the body of a module-level `if` or `try`, because a copy of a helper
    can hide there; methods and nested functions are not module scope.
    """
    found: list[tuple[str, str]] = []
    for node, ancestors in walk(source.tree):
        if in_class_or_function(ancestors):
            continue
        if isinstance(node, ast.ClassDef):
            found.append(("class", node.name))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found.append(("def", node.name))
    return found


def assigned_names(source: Source) -> list[str]:
    """Names bound by a plain or annotated assignment anywhere in the file."""
    names: list[str] = []
    for node, _ in walk(source.tree):
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        names.extend(target.id for target in targets if isinstance(target, ast.Name))
    return names


def docstring_nodes(tree: ast.Module) -> set[int]:
    """`id()` of every string node that is a docstring (module, class, function)."""
    found: set[int] = set()
    for node, _ in walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                found.add(id(first.value))
    return found


def string_literals(source: Source) -> list[str]:
    """Every string literal that is not a docstring, so prose that names a thing is not a use."""
    skip = docstring_nodes(source.tree)
    return [
        node.value
        for node, _ in walk(source.tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip
    ]


def imported_roots(source: Source) -> list[tuple[str, int, tuple[ast.AST, ...]]]:
    """`(top-level package, line, ancestors)` of every `import` and `from ... import` statement.

    A relative import has no package name here and is left out; the code base uses absolute
    imports (`from app...`).
    """
    found: list[tuple[str, int, tuple[ast.AST, ...]]] = []
    for node, ancestors in walk(source.tree):
        if isinstance(node, ast.Import):
            found.extend((alias.name.split(".")[0], node.lineno, ancestors) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.append((node.module.split(".")[0], node.lineno, ancestors))
    return found


def imported_names(source: Source) -> dict[str, set[str]]:
    """`{module: names}` for each `from module import names` in the file (all scopes)."""
    found: dict[str, set[str]] = {}
    for node, _ in walk(source.tree):
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.setdefault(node.module, set()).update(alias.name for alias in node.names)
    return found


def dynamic_import_targets(source: Source) -> list[str]:
    """Constant module names given to `__import__(...)` or `importlib.import_module(...)`."""
    found: list[str] = []
    for node, _ in walk(source.tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
        first = node.args[0]
        if name in ("__import__", "import_module") and isinstance(first, ast.Constant):
            if isinstance(first.value, str):
                found.append(first.value)
    return found
