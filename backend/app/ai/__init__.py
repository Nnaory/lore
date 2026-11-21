"""Server-side AI pipeline for LORE (Gemini client, contracts, limits, endpoints).

Why: the AI pipeline is moving from the Next.js route handlers to the backend one layer at a
time with identical contracts. Provider pieces: `settings`, `gemini_client`. Shared endpoint
pieces: `envelope`, `limits`, `pipeline`, `runtime`, `zod_compat`. Layer 1 (analyze-material):
`material_intelligence`, `output_parser`, `prompts/`. Routes live in `routes` under /api/v1/ai.
"""
