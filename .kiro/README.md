# .kiro: Kiro configuration for LORE

What is here and how it was produced. Kept honest on purpose.

| Path | What it is | Notes |
|---|---|---|
| `steering/` | Project facts and conventions. `always` files: product, tech, structure, conventions. Per-area `fileMatch` files: ai-pipeline, game-engine, persistence, theme-halloween, backend, infra. `manual`: known-issues (`#known-issues`) | Split from the original single `lore-overview.md`, then corrected against the code |
| `specs/r13-persistence-migration/` | Requirements and design for moving persistence from IndexedDB to FastAPI + PostgreSQL | Kiro CLI wrote `requirements.md` and `design.md`. `tasks.md` appeared afterwards (status "awaiting review", no task started) |
| `hooks/` | `guard-shell` (blocks terraform apply/destroy, mutating AWS CLI, docker push, force push, alembic downgrade, rm -rf), `protect-files` (lockfiles, existing Alembic revisions, secrets, state), `check-after-edit` (ruff/eslint on the edited file), `session-start` (branch and rules) | |
| `agents/` | `frontend`, `backend`, `infra` (read-only), `reviewer` (read-only) with scoped write and shell permissions | Checked with `kiro-cli agent validate` (structure only) |
| `skills/` | `frontend-module`, `infra-change` | |
| `settings/mcp.json` | AWS documentation MCP server | Added with `kiro-cli mcp add` |

## Notes
- Hooks need Node (no extra dependencies). `check-after-edit` skips silently when `ruff` or `frontend/node_modules` is missing.

