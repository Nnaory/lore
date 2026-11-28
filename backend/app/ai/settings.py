"""Gemini configuration read from environment variables.

Why: a faithful port of `geminiConfigFromEnv` in
`frontend/src/lib/ai/providers/gemini-client.ts`, so the frontend and backend interpret the
same env (`GOOGLE_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`, `AI_DEADLINE_MS`) identically.
"""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field

DEFAULT_MODELS: tuple[str, ...] = ("gemini-3.5-flash-lite",)
DEFAULT_TIMEOUT_MS = 300_000
DEFAULT_DEADLINE_MS = 300_000

# Terraform creates GOOGLE_API_KEY in SSM with this value until the real key is set by hand
# (infra/ssm.tf). Treating it as "no key" reports PROVIDER_NOT_CONFIGURED instead of sending a
# bogus key to Google and failing every request with a 401.
PLACEHOLDER_KEY = "__SET_ME__"


@dataclass(frozen=True)
class GeminiConfig:
    """Settings for one Gemini client. The API key is hidden from repr."""

    api_key: str = field(repr=False)
    models: tuple[str, ...]
    timeout_ms: float
    attempts_per_model: int = 2
    backoff_ms: float = 1_000
    deadline_ms: float = DEFAULT_DEADLINE_MS


def _parse_positive_ms(raw: str | None, fallback: float) -> float:
    """Return `raw` as a positive finite number, else `fallback`."""
    if raw is None or raw.strip() == "":
        return fallback
    try:
        parsed = float(raw)
    except ValueError:
        return fallback
    return parsed if math.isfinite(parsed) and parsed > 0 else fallback


def gemini_config_from_env(env: Mapping[str, str] | None = None) -> GeminiConfig | None:
    """Read config from env. Returns None when no key is configured."""
    source = os.environ if env is None else env
    # Strip surrounding whitespace: a key pasted with spaces or a CR (common with `set /p` on
    # Windows) is not a valid HTTP header value and would never reach Google.
    api_key = (source.get("GOOGLE_API_KEY") or source.get("GEMINI_API_KEY") or "").strip()
    if not api_key or api_key == PLACEHOLDER_KEY:
        return None
    models = tuple(m.strip() for m in source.get("AI_MODEL", "").split(",") if m.strip())
    return GeminiConfig(
        api_key=api_key,
        models=models or DEFAULT_MODELS,
        timeout_ms=_parse_positive_ms(source.get("AI_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS),
        deadline_ms=_parse_positive_ms(source.get("AI_DEADLINE_MS"), DEFAULT_DEADLINE_MS),
    )


def ai_provider_ready(env: Mapping[str, str] | None = None) -> bool:
    """True only when AI_PROVIDER is "google" and a key is configured."""
    source = os.environ if env is None else env
    return source.get("AI_PROVIDER") == "google" and gemini_config_from_env(source) is not None


def animation_models_from_env(env: Mapping[str, str] | None = None) -> tuple[str, ...]:
    """Models for animation generation, tried in order.

    Uses `AI_ANIMATION_MODEL` (comma separated, entries trimmed, empty entries dropped). When
    that yields no entry it falls back to `AI_MODEL` with the same splitting, then to
    `DEFAULT_MODELS`. It reads models only; the key, timeouts and deadline still come from
    `gemini_config_from_env`.
    """
    source = os.environ if env is None else env

    def split(name: str) -> tuple[str, ...]:
        return tuple(m.strip() for m in source.get(name, "").split(",") if m.strip())

    return split("AI_ANIMATION_MODEL") or split("AI_MODEL") or DEFAULT_MODELS
