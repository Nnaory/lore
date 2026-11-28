#!/usr/bin/env python3
"""Copy the animation contract to the backend and the frontend, or check that the copies match.

Why: the contract is written once in animation-verifier/contract/animation-contract.json and
every consumer (backend prompts, verifier, sandbox runtime) reads its own byte-identical copy.
Symlinks do not work because the Docker build contexts of backend/ and frontend/ cannot see
animation-verifier/, so CI runs `--check` to fail on drift (design D-6, section 4.4).

Usage:  python3 scripts/sync-animation-contract.py            # write both copies, print paths
        python3 scripts/sync-animation-contract.py --check    # write nothing, list drifted paths
Exit code: 2 for a bad argument or a missing / non-JSON source (wins over 1), 1 for drift
(a copy that differs or is missing), 0 otherwise. Files are read and written as bytes, so no
newline conversion happens. Standard library only; the source is checked for JSON validity,
not for the contract schema.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "animation-verifier/contract/animation-contract.json"
COPIES = (
    ROOT / "backend/app/ai/animation/animation-contract.json",
    ROOT / "frontend/src/lib/animation/animation-contract.json",
)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args not in ([], ["--check"]):  # unknown arguments
        print("usage: sync-animation-contract.py [--check]", file=sys.stderr)
        return 2
    try:
        data = SOURCE.read_bytes()
        json.loads(data)  # JSON validity only, not the schema
    except (OSError, ValueError):
        print(f"cannot read a valid JSON source: {SOURCE}", file=sys.stderr)
        return 2
    if args == ["--check"]:
        drift = [p for p in COPIES if not p.exists() or p.read_bytes() != data]
        for p in drift:
            print(p.relative_to(ROOT), file=sys.stderr)  # one path per line
        return 1 if drift else 0
    for p in COPIES:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)  # binary, no newline conversion
        print(p.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
