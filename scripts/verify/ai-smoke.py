#!/usr/bin/env python3
"""Smoke test for the LORE AI endpoints on a running backend (read-only for AWS).

Why: unit tests use a fake Gemini, so they cannot prove the real API accepts our requests.
This runs one short generation through /api/v1/ai/* (analyze, plan, one story) against a
server that already holds the Gemini key, then prints status, latency, model, warnings and
counts. It never reads or sends the key; the server owns it. It spends a few real Gemini
calls, so run it on purpose.

Usage (local):  uvicorn app.main:app --port 8000   # from backend/, with backend/.env loaded
                python3 scripts/verify/ai-smoke.py http://localhost:8000
Usage (prod):   python3 scripts/verify/ai-smoke.py https://<APP_URL>   # through Caddy
Needs httpx2 (backend/requirements.txt). Exit code 0 only if all three steps succeed.
"""

from __future__ import annotations

import sys
import time
from typing import Any

import httpx2

TEXT = (
    "Vectors have magnitude and direction. The dot product of two vectors a and b equals "
    "|a||b|cos(theta); it is zero exactly when the vectors are perpendicular. The cross product "
    "of two vectors in 3D is a vector perpendicular to both, with magnitude |a||b|sin(theta). "
    "Vector addition follows the parallelogram rule: place the tail of b at the head of a. "
    "A unit vector has magnitude 1 and is obtained by dividing a vector by its magnitude. "
) * 2


def fail(message: str) -> int:
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def post(client: httpx2.Client, step: str, body: dict[str, Any]) -> dict[str, Any] | None:
    """POST one AI step, print a one-line summary, and return the envelope (None on failure)."""
    started = time.monotonic()
    response = client.post(f"/api/v1/ai/{step}", json=body)
    elapsed = time.monotonic() - started
    try:
        envelope = response.json()
    except ValueError:
        print(f"{step}: HTTP {response.status_code} (not JSON) {elapsed:.1f}s")
        return None
    meta = (envelope.get("data") or {}).get("meta") or {}
    error = (envelope.get("error") or {}).get("code")
    print(
        f"{step}: HTTP {response.status_code} ok={envelope.get('ok')} {elapsed:.1f}s "
        f"model={meta.get('model')} warnings={len(meta.get('warnings', []))} error={error}"
    )
    return envelope if envelope.get("ok") else None


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
    with httpx2.Client(base_url=base, timeout=330.0) as client:
        material_env = post(client, "analyze-material", {"material": TEXT, "genre": "fantasy"})
        if material_env is None:
            return fail("analyze-material")
        material = material_env["data"]["blueprint"]
        print(f"  concepts: {len(material['concepts'])}")

        campaign_env = post(
            client, "plan-campaign", {"materials": [material], "options": {"genre": "fantasy"}}
        )
        if campaign_env is None:
            return fail("plan-campaign")
        campaign = campaign_env["data"]["blueprint"]
        print(f"  stories: {len(campaign['story_sequence'])}")

        story_env = post(
            client,
            "generate-story",
            {
                "campaign": campaign,
                "story": campaign["story_sequence"][0],
                "material": material,
                "previousSummaries": [],
                "options": {},
            },
        )
        if story_env is None:
            return fail("generate-story")
        story = story_env["data"]["blueprint"]
        scenes = sum(len(chapter["scenes"]) for chapter in story["chapters"])
        print(f"  chapters: {len(story['chapters'])} scenes: {scenes}")
        print(f"cookie issued: {'lore_device' in client.cookies}")
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
