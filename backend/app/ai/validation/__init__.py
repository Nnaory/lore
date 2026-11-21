"""Semantic validators for AI output (rules a flat schema cannot express).

Why: port of `frontend/src/lib/validation/*`. A schema checks shape; these check cross-references
(unique IDs, known materials, knowledge order). Each validator returns a list of
`ValidationError` dicts, `{code, message, path}`, the same shape as the TypeScript
`ValidationError` and as the non-blocking `meta.warnings` entries. An empty list means valid.
"""

from __future__ import annotations

from app.ai.envelope import warning as validation_error

__all__ = ["validation_error"]
