"""Tests for Gemini env parsing, mirroring the frontend `geminiConfigFromEnv` behaviour."""

from __future__ import annotations

import pytest

from app.ai.settings import (
    DEFAULT_DEADLINE_MS,
    DEFAULT_MODELS,
    DEFAULT_TIMEOUT_MS,
    ai_provider_ready,
    gemini_config_from_env,
)


def test_no_key_returns_none() -> None:
    assert gemini_config_from_env({}) is None
    assert gemini_config_from_env({"GOOGLE_API_KEY": ""}) is None


def test_defaults() -> None:
    config = gemini_config_from_env({"GOOGLE_API_KEY": "k"})
    assert config is not None
    assert config.models == DEFAULT_MODELS == ("gemini-3.5-flash-lite",)
    assert config.timeout_ms == DEFAULT_TIMEOUT_MS == 300_000
    assert config.deadline_ms == DEFAULT_DEADLINE_MS == 300_000
    assert config.attempts_per_model == 2
    assert config.backoff_ms == 1_000


def test_models_are_split_trimmed_and_blanks_dropped() -> None:
    config = gemini_config_from_env({"GOOGLE_API_KEY": "k", "AI_MODEL": " a , ,b,, "})
    assert config is not None
    assert config.models == ("a", "b")


def test_blank_model_list_uses_default() -> None:
    config = gemini_config_from_env({"GOOGLE_API_KEY": "k", "AI_MODEL": " , "})
    assert config is not None
    assert config.models == DEFAULT_MODELS


def test_valid_timeouts_are_used() -> None:
    config = gemini_config_from_env(
        {"GOOGLE_API_KEY": "k", "AI_TIMEOUT_MS": "1500", "AI_DEADLINE_MS": "9000"}
    )
    assert config is not None
    assert config.timeout_ms == 1500
    assert config.deadline_ms == 9000


@pytest.mark.parametrize("raw", ["", "  ", "abc", "0", "-5", "nan", "inf", "-inf"])
def test_invalid_timeouts_fall_back_to_default(raw: str) -> None:
    config = gemini_config_from_env(
        {"GOOGLE_API_KEY": "k", "AI_TIMEOUT_MS": raw, "AI_DEADLINE_MS": raw}
    )
    assert config is not None
    assert config.timeout_ms == DEFAULT_TIMEOUT_MS
    assert config.deadline_ms == DEFAULT_DEADLINE_MS


def test_google_key_wins_over_gemini_key() -> None:
    config = gemini_config_from_env({"GOOGLE_API_KEY": "g", "GEMINI_API_KEY": "m"})
    assert config is not None
    assert config.api_key == "g"


def test_gemini_key_is_fallback() -> None:
    config = gemini_config_from_env({"GEMINI_API_KEY": "m"})
    assert config is not None
    assert config.api_key == "m"


def test_reads_process_env_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "from-env")
    config = gemini_config_from_env()
    assert config is not None
    assert config.api_key == "from-env"


def test_config_repr_hides_key() -> None:
    config = gemini_config_from_env({"GOOGLE_API_KEY": "super-secret"})
    assert "super-secret" not in repr(config)


def test_provider_ready_requires_google_and_key() -> None:
    assert ai_provider_ready({"AI_PROVIDER": "google", "GOOGLE_API_KEY": "k"}) is True
    assert ai_provider_ready({"AI_PROVIDER": "google", "GEMINI_API_KEY": "k"}) is True
    assert ai_provider_ready({"AI_PROVIDER": "google"}) is False
    assert ai_provider_ready({"GOOGLE_API_KEY": "k"}) is False
    assert ai_provider_ready({"AI_PROVIDER": "openai", "GOOGLE_API_KEY": "k"}) is False


def test_terraform_placeholder_counts_as_no_key() -> None:
    env = {"AI_PROVIDER": "google", "GOOGLE_API_KEY": "__SET_ME__"}
    assert gemini_config_from_env(env) is None
    assert ai_provider_ready(env) is False
    # The placeholder in GOOGLE_API_KEY wins over GEMINI_API_KEY, so a half-set env stays
    # "not ready" instead of silently using a different key.
    mixed = {"GOOGLE_API_KEY": "__SET_ME__", "GEMINI_API_KEY": "real"}
    assert gemini_config_from_env(mixed) is None


def test_key_whitespace_is_stripped() -> None:
    config = gemini_config_from_env({"GOOGLE_API_KEY": "  k-123\r\n"})
    assert config is not None
    assert config.api_key == "k-123"
    assert gemini_config_from_env({"GOOGLE_API_KEY": "   "}) is None
