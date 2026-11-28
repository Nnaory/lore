#!/usr/bin/env python3
"""Check that react, react-dom, remotion and @remotion/player have one exact version everywhere.

Why: a file the verifier accepts must behave the same in the browser, so animation-verifier/
and frontend/ (which also builds the sandbox runtime) must resolve the same four runtime
packages (requirement 3, design 8.4 job `contracts` and 12.1 supply chain). CI runs this in
the `contracts` job; the exit code is the gate.

Sources read: animation-verifier/package.json, frontend/package.json and both package-lock.json.
Problems reported, one line each on stderr, all collected before exiting:
  - a source file is missing, unreadable, not JSON, or has no lockfile `packages` map
  - a package is missing in a source, or a package.json value is not an exact version
    (`^`, `~`, ranges, tags and aliases are rejected)
  - a package whose value differs between the four sources (one `<file>=<version>` per source)
  - a nested lockfile entry `node_modules/**/node_modules/<package>` with another version
    than the pin
  - react/react-dom or remotion/@remotion/player at different versions in the same source
Exit code: 0 when everything is identical, 1 for any problem, 2 for a command line argument
(this script takes none). Standard library only; paths resolve from the script location, so a
copy placed under another repo root checks that root (the tests rely on this).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

PACKAGES = ("react", "react-dom", "remotion", "@remotion/player")
PAIRS = (("react", "react-dom"), ("remotion", "@remotion/player"))

VERIFIER_MANIFEST = "animation-verifier/package.json"
FRONTEND_MANIFEST = "frontend/package.json"
VERIFIER_LOCK = "animation-verifier/package-lock.json"
FRONTEND_LOCK = "frontend/package-lock.json"
SOURCES = (VERIFIER_MANIFEST, FRONTEND_MANIFEST, VERIFIER_LOCK, FRONTEND_LOCK)
LOCK_TO_MANIFEST = {VERIFIER_LOCK: VERIFIER_MANIFEST, FRONTEND_LOCK: FRONTEND_MANIFEST}

# MAJOR.MINOR.PATCH with optional prerelease and build parts; nothing that npm reads as a range.
EXACT_VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
MISSING = "<missing>"
USAGE = "usage: check-animation-versions.py (takes no arguments)"

Values = dict[str, dict[str, str | None]]  # package -> source -> pin or resolved version


def _load_json(rel: str, problems: list[str]) -> dict | None:
    """Parse one source as a JSON object; on any failure record a line naming file and packages."""
    needed = f"needed for {', '.join(PACKAGES)}"
    try:
        data = json.loads((ROOT / rel).read_text(encoding="utf-8"))
    except FileNotFoundError:
        problems.append(f"{rel}: file is missing ({needed})")
    except OSError as exc:
        problems.append(f"{rel}: cannot read file: {exc.strerror or exc} ({needed})")
    except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError
        problems.append(f"{rel}: not valid JSON: {exc} ({needed})")
    else:
        if isinstance(data, dict):
            return data
        problems.append(f"{rel}: top-level JSON value is not an object ({needed})")
    return None


def _manifest_pin(data: dict, rel: str, pkg: str, problems: list[str]) -> str | None:
    for section in ("dependencies", "devDependencies"):
        deps = data.get(section)
        if not isinstance(deps, dict) or pkg not in deps:
            continue
        spec = deps[pkg]
        if not isinstance(spec, str):
            problems.append(f"{rel}: {pkg} has a non-string version: {json.dumps(spec)}")
            return None
        if not EXACT_VERSION.fullmatch(spec):
            problems.append(f'{rel}: {pkg} "{spec}" is not an exact pin')
        return spec
    problems.append(f"{rel}: {pkg} is missing")
    return None


def _lock_version(
    packages: dict, rel: str, pkg: str, pin: str | None, problems: list[str]
) -> str | None:
    entry = packages.get(f"node_modules/{pkg}")
    version = entry.get("version") if isinstance(entry, dict) else None
    if not isinstance(version, str):
        what = "is missing" if entry is None else "has no resolved version"
        problems.append(f"{rel}: node_modules/{pkg} {what}")
        version = None
    # Nested copies (node_modules/<dep>/node_modules/<pkg>) mean a second copy of the package.
    if pin is not None and EXACT_VERSION.fullmatch(pin):
        for key, nested in packages.items():
            if not key.endswith(f"/node_modules/{pkg}"):
                continue
            nested_version = nested.get("version") if isinstance(nested, dict) else None
            if nested_version != pin:
                shown = nested_version if isinstance(nested_version, str) else MISSING
                problems.append(f"{rel}: nested entry {key} is {shown}, pin is {pin}")
    return version


def check() -> tuple[list[str], Values]:
    """Return every problem found (empty when the four sources agree) and the values read."""
    problems: list[str] = []
    values: Values = {pkg: dict.fromkeys(SOURCES) for pkg in PACKAGES}
    data = {rel: _load_json(rel, problems) for rel in SOURCES}

    for rel in (VERIFIER_MANIFEST, FRONTEND_MANIFEST):
        if data[rel] is not None:
            for pkg in PACKAGES:
                values[pkg][rel] = _manifest_pin(data[rel], rel, pkg, problems)

    for rel, manifest in LOCK_TO_MANIFEST.items():
        if data[rel] is None:
            continue
        packages = data[rel].get("packages")
        if not isinstance(packages, dict):
            needed = f"needed for {', '.join(PACKAGES)}"
            problems.append(f'{rel}: no "packages" map, lockfileVersion 2 or 3 required ({needed})')
            continue
        for pkg in PACKAGES:
            pin = values[pkg][manifest]
            values[pkg][rel] = _lock_version(packages, rel, pkg, pin, problems)

    for pkg in PACKAGES:
        row = values[pkg]
        if len({v for v in row.values() if v is not None}) > 1:
            shown = (f"{rel}={MISSING if row[rel] is None else row[rel]}" for rel in SOURCES)
            problems.append(f"{pkg}: {' '.join(shown)}")

    for rel in SOURCES:
        for first, second in PAIRS:
            a, b = values[first][rel], values[second][rel]
            if a is not None and b is not None and a != b:
                problems.append(f"{rel}: {first}={a} and {second}={b} must be the same version")
    return problems, values


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args:
        print(USAGE, file=sys.stderr)
        return 2
    problems, values = check()
    if problems:
        for line in problems:
            print(line, file=sys.stderr)  # one problem per line
        return 1
    shown = ", ".join(f"{pkg}={values[pkg][SOURCES[0]]}" for pkg in PACKAGES)
    print(f"animation versions match: {shown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
