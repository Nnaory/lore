"""Pydantic mirrors of the frontend Zod contracts for the AI endpoints.

Why: `frontend/src/lib/contracts/**` is the source of truth for what the browser accepts. These
models reproduce its limits, enums and optional fields so the Python API returns exactly what
the Zod schemas parse.
"""
