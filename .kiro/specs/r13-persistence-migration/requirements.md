# R13 — Migrate Persistence from IndexedDB to Backend

> **Status:** Requirements — revised after review. Q4 resolved (option A).
> **Roadmap ref:** R13 in `docs/infra/10-implementation-roadmap.md`.
> **Decision:** Q4 resolved — anonymous device token (option A). See OQ-1.

## Overview

LORE currently stores player projects — campaign blueprints, story blueprints, and campaign progress — entirely in the browser via IndexedDB. R13 moves that persistence to the FastAPI + PostgreSQL backend that is already deployed (R1–R12). The browser keeps a local copy for offline resilience, but the server becomes the source of truth. The AI pipeline stays in Next.js route handlers; only the project store moves.

## Background

- **R1–R12** built and verified the full AWS infrastructure: VPC, NAT, EC2 web/api, RDS PostgreSQL 16, CI/CD, and the FastAPI skeleton with health endpoints and an empty Alembic migration (`4ee36ac0a0f8`). All of this is live and tested.
- **R13** is the first task that writes business data to the database. Its plan was deferred until open questions Q1, Q4, and Q5 were answered. All three are now resolved: Q1 (FastAPI), Q5 (this spec's scope), Q4 (option A — anonymous device token, see OQ-1).
- The migration sketch lives in `docs/infra/06-app-changes.md` section 4 and the schema sketch in `docs/infra/04-database.md` section 7. Both are illustrations; this spec is authoritative.

## Goals

1. Projects, stories, and campaign state persist in PostgreSQL, not just IndexedDB.
2. The browser keeps a local copy so the app works offline and degrades gracefully.
3. Existing IndexedDB data is synced to the server on every load (idempotent), without data loss.
4. The public TypeScript API of `project-store.ts` does not change, so consuming components (`create/page.tsx`, `SavedStories.tsx`, `PlayProject.tsx`) need no or minimal changes.
5. Backend changes ship first and are backward-compatible, so the API is live before the frontend switches.

## Scope

### In scope (Q5 default)

| Data | Current location | Moves to |
|---|---|---|
| Project (blueprint, stories, materials) | IndexedDB `projects` store | `projects` + `project_stories` tables |
| Campaign state (player progress) | IndexedDB `projects` store (inside Project) | `project_state` table |
| Project summaries (home page list) | IndexedDB `summaries` store | Denormalized columns on `projects` |

### Out of scope

| Item | Reason |
|---|---|
| AI pipeline (`/api/ai/*` → `/api/v1/ai/*`) | Separate future task; route handlers stay in Next.js |
| Chat "type something" / in-character | Not yet implemented in the app |
| Avatar (`lore:avatar` in localStorage) | Stays local — feature was removed 17 Nov 2026 |
| Pacing (`lore:pacing` in localStorage) | Stays local — UI preference, not project data |
| Accounts / OAuth integration | Q4 resolved as option A (device token). Full accounts are a future upgrade, not part of R13. |

## Current state

### Client persistence (`frontend/src/lib/state/`)

**`idb.ts`** — minimal promise wrapper over the raw IndexedDB API. Database `lore` v1 with two object stores: `projects` (full `Project` objects, keyed by `id`) and `summaries` (`ProjectSummary`, keyed by `id`). Both stores are written in a single transaction so they never disagree. Exports `transact()`, `indexedDbAvailable()`, `resetDatabaseConnection()`, and store-name constants.

**`project-store.ts`** — the public API consumed by the app. Key properties:

- **Types:** `Project` (id, created_at, updated_at as `number` milliseconds, source, campaign, stories as `Record<string, StoryBlueprint>`, optional `campaign_state` and `materials`), `ProjectSummary`, `StoreResult<T> = { ok: true; value: T } | { ok: false; message: string }`.
- **Functions:** `listProjects()`, `loadProject(id)`, `createProject(input)`, `saveCampaignState(id, state)`, `deleteProject(id)`, `projectStories(project)`.
- **Validation:** every read is validated with Zod. `ProjectSchema` uses `z.unknown().optional()` for `campaign_state`; the full `CampaignStateSchema` is applied separately in `readProject()`, which drops invalid progress (sets `campaign_state` to `undefined`) rather than failing the whole load. This "drop bad state, keep the story" behavior must be preserved.
- **Legacy migration:** `migrateFromLocalStorage()` copies old localStorage projects into IndexedDB on first use. Idempotent per `id`; newer `updated_at` wins; localStorage keys are removed only after all writes succeed; failure retries on the next page load.
- **SSR safety:** all functions are async and return empty/null/false when IndexedDB is unavailable (server-side, old browser, private mode). No function throws.
- **`projectStories(project)`** is a synchronous pure function that builds a `ReadonlyMap<string, StoryBlueprint>` from `project.stories` filtered by `campaign.story_sequence` order. It does no I/O and is not part of the repository interface.

### Consumers

| Component | File | Calls |
|---|---|---|
| Create page | `src/app/create/page.tsx` | `createProject(input)` → on success navigates to `/play/{id}`; on failure keeps campaign in memory with a save-error banner |
| Home saved stories | `src/components/home/SavedStories.tsx` | `listProjects()` on mount → renders summaries; `deleteProject(id)` then `listProjects()` to refresh |
| Play page | `src/components/play/PlayProject.tsx` | `loadProject(id)` on mount → sets loaded/missing state; `projectStories(project)` to build the story map; `saveCampaignState(id, state)` on every state change → sets/clears a sticky save-error banner |

### Backend skeleton (`backend/app/`)

- **`main.py`** — FastAPI app with lifespan-managed SQLAlchemy engine. Endpoints: `GET /health` (liveness), `GET /health/db` (readiness `SELECT 1`), `GET /api/v1/health` (public, behind Caddy). The app factory `create_app(db_engine)` accepts an injected engine for testing.
- **`db.py`** — `DatabaseConfig` dataclass from `PG*` env vars; `create_db_engine()` returns `Engine | None` (None when `PGHOST` is unset); `check_db_health(engine)` runs `SELECT 1`. Pool is capped at 10 connections per process (`DB_POOL_SIZE` + `DB_MAX_OVERFLOW ≤ 10`).
- **Alembic** — `env.py` reads `PG*` from the same config; `target_metadata = None` (migrations are hand-written SQL, not autogenerate). One revision exists: `4ee36ac0a0f8` (empty `pass` in both `upgrade` and `downgrade`).
- **Tests** — `test_health.py` (5 tests, no DB needed) and `test_db.py` (6 tests, 2 skip without `PGHOST`). Live Postgres tests use `pytest.MonkeyPatch` for env, `TestClient` for requests, and `NullPool` for engine isolation.

## Functional requirements

### FR-1: Backend data model and schema migrations

1. **Tables.** Create `projects`, `project_stories`, and `project_state` tables matching the schema sketch in `docs/infra/04-database.md` section 7, with these adjustments:
   - `projects`: PK `id` (**text**, not uuid — `newId()` in `project-store.ts` falls back to `p_<time>_<random>` when `crypto.randomUUID` is missing, so existing IndexedDB ids are not guaranteed to be UUIDs), `owner_id` (uuid, nullable — see FR-1.5), `created_at`/`updated_at` (**bigint** — milliseconds since epoch, matching the client's `number` type; avoids `timestamptz` conversion), `source` (jsonb), `campaign` (jsonb), `materials` (jsonb, nullable), denormalized columns (`title` text, `genre` text, `source_name` text, `stories_total` integer, `stories_completed` integer default 0), `schema_version` (integer, default 1).
   - `project_stories`: composite PK (`project_id` **text**, `story_id` text), `blueprint` (jsonb), FK to `projects(id)` with `ON DELETE CASCADE`.
   - `project_state`: PK `project_id` (**text**, FK to `projects(id)` with `ON DELETE CASCADE`), `campaign_state` (jsonb), `updated_at` (**bigint** — milliseconds, for conflict detection).
2. **Separation rationale.** `campaign_state` is saved on every player action (frequent), while blueprints rarely change. Splitting them avoids rewriting large blueprints on every state save. Denormalized summary columns replace the IndexedDB `summaries` store for the list endpoint.
3. **Alembic migration.** New revision after `4ee36ac0a0f8`, hand-written (consistent with `target_metadata = None`). Must be runnable via `alembic upgrade head` as a one-shot `migrate` service (as deployed in R10).
4. **Expand-and-contract.** Migrations must be backward-compatible: the new schema must work with the old code, and the old schema must work with the new code during the transition window. No destructive column drops or type changes in the initial migration.
5. **`owner_id` — resolved (Q4 option A).** `owner_id` is a `uuid` column, nullable at the schema level for backward safety. The API enforces non-null on new and imported rows: every request to `/api/v1/projects/*` must carry a device token cookie (see FR-2), and the token's UUID becomes `owner_id`. The column stays nullable so that legacy rows imported without a valid token (edge case during initial migration) do not cause a constraint violation, but the normal path always sets it.
6. **Validation strategy: opaque jsonb with minimal server validation.** Campaign blueprints, story blueprints, campaign state, and materials are stored as opaque `jsonb` blobs. The server does **not** duplicate the complex Zod schemas (CampaignBlueprint, StoryBlueprint, CampaignState, MaterialBlueprint) as full Pydantic models. Full validation stays on the client via the existing Zod schemas in `src/lib/ai/schemas/*`.

   **Rationale (evaluated per review):**
   - The frontend is the only API consumer. No third-party clients need server-validated schemas.
   - Data entering the API already passed Zod validation on the client (AI output is validated before `createProject`).
   - Duplicating the schemas in Pydantic creates a maintenance burden and a drift risk: if Pydantic rejects something Zod accepts, the user loses data. The schemas are complex (Scene is a 6-variant discriminated union, CampaignState has 4 nested types) and evolving.
   - The "drop invalid `campaign_state`, keep the story" behavior is a client-side concern. The server stores and returns the blob; the client's Zod validation decides whether to use or drop it (same as `readProject` today).

   **What the server does validate (the "minimal" part):**
   - Envelope fields: `id` (non-empty string), `created_at`/`updated_at` (integer milliseconds), `source` (object with `file_name` and `file_type`).
   - Denormalized fields extracted via SQL/jsonb path expressions: `title` = `campaign->>'title'`, `genre` = `campaign->>'genre'`, `source_name` = `source->>'file_name'`, `stories_total` = `jsonb_array_length(campaign->'story_sequence')`. `stories_completed` is computed from `campaign_state` on PUT state.
   - **NOT NULL field validation.** The fields `title`, `genre`, `source_name`, and `story_sequence` feed NOT NULL columns. The server validates that these fields are present in the jsonb and are the correct type (string for title/genre/source_name, array for story_sequence) before the INSERT. If any are missing or wrong type, the server returns `422 Unprocessable Entity`, not `500`. Likewise, `campaign_state.completed_stories` (when `campaign_state` is present) must be an array of strings — it feeds `jsonb_array_length` for `stories_completed`. Missing or non-array `completed_stories` returns `422`.
   - `campaign_state` is stored and returned as opaque jsonb. The server does not inspect its internal structure.

### FR-2: REST API endpoints

All endpoints under `/api/v1/projects`, routed publicly by Caddy (Q21 prefix). No CORS (frontend and API share an origin through Caddy).

| # | Method | Path | Purpose | Replaces | Success response | Error codes |
|---|---|---|---|---|---|---|
| 1 | `GET` | `/api/v1/projects` | List summaries for the calling owner, newest first | `listProjects()` | `200` → `ProjectSummary[]` | |
| 2 | `POST` | `/api/v1/projects` | Create a new project | `createProject()` | `201` → `Project` (full) | `413` body too large |
| 3 | `GET` | `/api/v1/projects/{id}` | Load a full project | `loadProject()` | `200` → `Project` | `404` not found or not owned by caller |
| 4 | `DELETE` | `/api/v1/projects/{id}` | Delete a project and its stories/state | `deleteProject()` | `204` (empty) | `404` not found or not owned by caller |
| 5 | `PUT` | `/api/v1/projects/{id}/state` | Save campaign state | `saveCampaignState()` | `200` → `{ updated_at: number }` | `404` not found; `409` stale write (see below) |
| 6 | `POST` | `/api/v1/projects/import` | Bulk import from IndexedDB | One-time migration | `200` → `{ imported: number, skipped: number, rejected: { index, id?, error }[] }` | `413` body too large |

Requirements per endpoint:

- **Owner filtering (cross-cutting).** Every endpoint filters by the calling owner's `owner_id`, extracted from the device token cookie. Cross-owner access (GET, DELETE, PUT on a project owned by a different token) returns `404`, not `403` — the caller cannot distinguish "does not exist" from "not yours." The list endpoint returns only the caller's projects.
- **Device token cookie.** An HTTP middleware (not a dependency) on every `/api/v1/projects/*` request checks for a cookie (e.g., `lore_device`). If absent or malformed, the server generates a UUID v4 and sets it as an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie (max-age 1 year) on the response. The middleware runs around the entire request, so the `Set-Cookie` header lands on the final response for every response the application returns, including those built from `HTTPException` (404, 409, 413, 422, 429); a dependency's injected `Response` would be lost when the endpoint raises `HTTPException`. An unhandled exception (500) is outside this guarantee, because Starlette builds that response outside user middleware. The `Secure` flag is set based on the `X-Forwarded-Proto` header (set by Caddy, trusted by uvicorn `--proxy-headers`): `https` → `Secure=True`, `http` → `Secure=False`. This works behind Caddy where `request.url.scheme` is always `http` (uvicorn receives plain HTTP from Caddy). No separate token-issuance endpoint is needed.
- **Timestamps.** The TypeScript `Project` type uses `number` (milliseconds since epoch). The API must accept and return timestamps as numbers, not ISO strings, so the public `project-store.ts` signatures stay unchanged. The `HttpRepository` is responsible for any conversion.
- **Endpoint 1 (list).** Returns only denormalized summary fields. Does not load `campaign`, `stories`, or `campaign_state`. Sorted by `updated_at` descending.
- **Endpoint 2 (create).** Accepts the full project payload (source, campaign, stories, materials, optional `campaign_state`). Server generates `id`, `created_at`, `updated_at` if not provided, or accepts client-provided values (for import idempotency). Sets `owner_id` from the cookie token. Stores stories in `project_stories` and denormalized fields on `projects` (extracted via jsonb path expressions). If `campaign_state` is present, stores it in `project_state` (unless the stored state is newer); `stories_completed` is then derived from the stored state's `completed_stories`, so it always matches the stored progress — this preserves player progress on import, and a re-post without `campaign_state` keeps the existing progress count. Returns the full `Project`. If a project with the same `id` already exists and is owned by a **different** owner, the server returns `409 Conflict` (id collision) — it does not reveal the other owner's data. If owned by the same owner, only a strictly newer `updated_at` replaces the stored copy; an older or equal one leaves it unchanged (import idempotency). Status: `201` for a new row, `200` with the stored project otherwise.
- **Endpoint 3 (get).** Assembles the full `Project` by joining `projects` + `project_stories` + `project_state`, filtered by the caller's `owner_id`. If the project does not exist or is not owned by the caller, returns `404`. `campaign_state` is returned as-is (opaque jsonb); the client validates with Zod and drops invalid state (same as `readProject` today).
- **Endpoint 4 (delete).** Deletes the project only if it is owned by the caller (`404` otherwise). Cascades to `project_stories` and `project_state` via FK `ON DELETE CASCADE`.
- **Endpoint 5 (put state).** Accepts `campaign_state` and a client-side `updated_at` (milliseconds). The server compares the client's `updated_at` to the stored `updated_at` in `project_state`:
  - If the client's `updated_at` is **newer or equal**, the server writes the state, updates the denormalized `stories_completed` and `updated_at` on `projects` (`updated_at` only moves forward: the stored value is kept when it is already newer), and returns `200` with the new `updated_at`.
  - If the client's `updated_at` is **older** (stale write), the server rejects with `409 Conflict` and returns the stored `updated_at` in the body. The client uses the returned `updated_at` to reconcile (reload the project or discard its local state).
  
  This is a strict last-write-wins on `updated_at`: the newer timestamp always wins, and stale writes are rejected, not silently overwritten.
- **Endpoint 6 (import).** Accepts an array of full `Project` objects. Sets `owner_id` from the cookie token on every imported project. Idempotent per `id`: if a project with the same `id` already exists and is owned by the caller, only a strictly newer `updated_at` replaces it (mirrors `migrateFromLocalStorage`). If the `id` belongs to a different owner, the project is skipped (counted in `skipped`, not `imported`) — no cross-owner write. Each item is validated on its own: an invalid item (same rules as endpoint 2), an item that would exceed a storage cap (FR-7.3), or an item the database refuses as invalid data is not written and is listed in `rejected` with its index, its id when it has a string id, and the error; the other items in the batch are still processed, so one bad project cannot block the batch on every load. Each project is written in its own transaction. Returns `imported` (rows written: new, or the caller's own row replaced by a strictly newer copy), `skipped` (not written: the stored copy is newer or the same version, or the id belongs to another owner), and `rejected`. Re-importing an identical copy is a no-op and counts as `skipped`. Does not delete or modify data that was not in the request.

### FR-3: Repository abstraction and feature flag

1. **Interface.** Define a `ProjectRepository` interface covering the five async functions: `listProjects`, `loadProject`, `createProject`, `saveCampaignState`, `deleteProject`. `createProject` accepts an optional `id` parameter (if omitted, the implementation generates one via `newId()`). The public `project-store.ts` function does not expose `id` — it is an internal parameter used by `HttpRepository` to keep the local and server ids in sync. `projectStories` is not part of the interface (it is a synchronous pure function that operates on a loaded `Project`).
2. **Implementations.** `IndexedDbRepository` wraps the current IndexedDB code. `HttpRepository` calls the backend API. Both return the same types (`ProjectSummary[]`, `Project | null`, `StoreResult<Project>`, `StoreResult`, `void`).
3. **Feature flag.** `NEXT_PUBLIC_PROJECT_STORE` env var selects the implementation: `idb` (default, current behavior) or `http` (new). The flag is read at build time (`NEXT_PUBLIC_` prefix) and determines which repository is constructed. When unset or `idb`, behavior is unchanged.
4. **Public API preserved.** `project-store.ts` keeps its current exported function signatures. Internally it delegates to the selected repository. Consuming components do not change.
5. **`StoreResult` preserved.** Both implementations return `{ ok: true; value: T } | { ok: false; message: string }`. The `HttpRepository` maps HTTP errors (network failure, 4xx, 5xx) to `{ ok: false, message }` with user-facing messages, the same way `failure()` maps IndexedDB errors today.

### FR-4: Debounced saves and conflict resolution

1. **Debounce.** `saveCampaignState` calls are debounced so rapid state changes (e.g., advancing through scenes) produce at most one server request per debounce window. The debounce window should be short enough that progress is not lost on a sudden close, but long enough to avoid flooding the server.
2. **Conflict resolution (reject stale writes).** The server resolves concurrent writes by comparing `updated_at`: if the client's `updated_at` is older than the stored value, the server rejects with `409 Conflict` and returns the stored `updated_at`. The client uses the returned timestamp to decide whether to reload the project or discard its local state. This is strict last-write-wins: the newer timestamp wins, and stale writes are rejected, not silently overwritten.
3. **Ordering.** Debounced saves must apply in order. The current IndexedDB implementation achieves this by using one transaction per save; the HTTP implementation must ensure earlier requests complete before later ones are sent (queue, not parallel fire).
4. **Local copy until confirmed.** The browser keeps the last known state in IndexedDB (or in memory) until the server confirms the save. If the save fails, the local copy is retained and retried.

### FR-5: Sync check and import from IndexedDB

1. **Sync check on every load.** When `NEXT_PUBLIC_PROJECT_STORE=http`, the app runs a sync check on load (e.g., from the home page). It fetches the server project list (`GET /api/v1/projects`), reads the IndexedDB project list, and compares:
   - Projects in IndexedDB but **not on the server** → import (POST to `/api/v1/projects/import`). This handles first-time migration and cookie/owner changes (new owner has no server projects).
   - Projects in both where the local `updated_at` is **newer** than the server's → sync state (PUT to `/api/v1/projects/{id}/state` with the local `campaign_state` and `updated_at`). This handles saves that failed to reach the server.
   - Projects where the server's `updated_at` is newer → no action (server has the latest).
2. **No global flag.** The sync check does not use a `lore:imported` flag. It runs on every load and relies on the server's idempotency (existing projects with the same or newer `updated_at` are skipped). The cost is one extra `GET /api/v1/projects` per load, which the home page already performs. If IndexedDB is empty, the sync check does nothing.
3. **Idempotent.** Importing the same project twice does not duplicate or overwrite it with older data. The server endpoint is idempotent per `id` + `owner_id`: if the project already exists, the one with the newer `updated_at` wins.
4. **No data loss.** Local IndexedDB data is never deleted by the sync check. It stays as a local cache for offline reads.
5. **Validation.** Projects read from IndexedDB are validated with Zod before being sent to the server (same `readProject` validation). Invalid projects are skipped, not sent.
6. **Batching.** Import sends projects in size-bounded batches (max 4 MB per request, leaving 1 MB headroom under the 5 MB Caddy limit) to respect the import body size limit.

### FR-6: Offline and error handling

1. **Save status in UI.** `PlayProject.tsx` already shows a sticky save-error banner when `saveCampaignState` returns `{ ok: false }`. This behavior is preserved. The `HttpRepository` returns appropriate `StoreResult` values for network failures, timeouts, and server errors. A `409 Conflict` response is mapped to `{ ok: false, message }` with a message indicating the save was stale; the client may reload the project to get the server's current state.
2. **Read fallback.** If `loadProject` fails (network error), the `HttpRepository` may fall back to the local IndexedDB copy if one exists. This is a design decision (design.md); the requirement is that a network failure on read does not blank the page if a local copy is available.
3. **No throwing.** All public functions return result unions or null, never throw. Network errors, JSON parse errors, and validation failures are caught and mapped to `{ ok: false, message }` or `null`.

### FR-7: Request limits and rate limiting

The API is public, the RDS is 20 GB on a free plan, the api instance is a t3.micro (1 GB RAM), and the connection pool is capped at 10 per process. Unbounded requests can exhaust memory, connections, or storage.

1. **Body size limits.** Enforced at two layers: Caddy (coarse, catches chunked uploads) and FastAPI (per-endpoint, defense in depth).
   - Caddy: `request_body { max_size 5MB }` on `/api/v1/*` in the Caddyfile. Requests exceeding this are rejected with `413` before reaching FastAPI.
   - `POST /api/v1/projects`: max 2 MB body. A full project measured 25–42 KB (T0, 20 Nov 2026: 3–5 chapters, materials, campaign state; the earlier estimate was ~170 KB); 2 MB gives generous headroom.
   - `POST /api/v1/projects/import`: max 5 MB body. Client batches by byte size (max 4 MB per request, leaving 1 MB headroom under Caddy's 5 MB limit). No hard count cap — size is the binding constraint.
   - `PUT /api/v1/projects/{id}/state`: max 500 KB body. `CampaignState` measured 1.3–1.9 KB after one finished story (T0); 500 KB gives ample headroom.
   - `GET` and `DELETE` have no request body; no limit needed.
2. **Rate limiting.** Per-IP (the client address as resolved by uvicorn from the proxy headers set by Caddy, `request.client.host`), applied at the API layer. Per-owner (cookie) limiting is secondary because cookies are client-controlled and trivially reset.
   - Per-IP: 120 requests/minute for all `/api/v1/projects/*` endpoints combined. This is the primary abuse prevention — an attacker clearing cookies still hits the same IP limit.
   - Per-owner write (POST, DELETE, PUT state): 60 requests/minute. With a 1500 ms debounce, the maximum legitimate PUT rate is ~40/minute, so 60/min allows headroom without blocking normal play.
   - Import (POST /import): 5 requests/minute per IP (heavy operation).
   - Per-IP daily creation quota: max 100 `POST /projects` per IP per 24 hours. Prevents one IP from filling the global 10,000-project cap in ~1.5 hours.
   - When the limit is exceeded, return `429 Too Many Requests` with a `Retry-After` header.
   - Implementation is per-process in-memory (single api instance, no Redis). The rate-limit dict prunes entries older than 5 minutes on every check to avoid unbounded growth on a 1 GB instance.
3. **Global storage caps.** Per-owner: max 100 projects and max 50 MB total storage (sum of `octet_length(campaign) + octet_length(materials) + sum of octet_length(blueprint) for stories`). Global: max 10,000 projects total. Checked on create and import. Exceeding returns `422` with a message on create; on import the item is listed in `rejected` with that message and the rest of the batch is still processed. These protect the 20 GB RDS from a single owner or aggregate growth.

## Non-functional requirements

### NFR-1: Backward compatibility

1. **API first.** The backend image is released and deployed before the frontend switches to `NEXT_PUBLIC_PROJECT_STORE=http`. The frontend at `idb` mode continues to work against the deployed API (the API endpoints exist but are unused).
2. **Rollback.** `NEXT_PUBLIC_PROJECT_STORE` is a `NEXT_PUBLIC_` env var, inlined at build time by Next.js. Rolling back to `idb` mode requires a web image built without the env var (or with it set to `idb`), not a runtime env change. The `release-web.yml` workflow supports `workflow_dispatch` with a tag input: specifying a tag from before the `http` switch deploys an `idb` image. The API stays running (harmless). To build `http` mode, the workflow passes `NEXT_PUBLIC_PROJECT_STORE=http` as a Docker build arg; the Dockerfile declares `ARG NEXT_PUBLIC_PROJECT_STORE=idb` so the default build produces `idb` mode.
3. **Both modes coexist.** During the transition, `idb` mode and `http` mode both work. The IndexedDB code is not removed.
4. **Expand-and-contract.** The initial Alembic migration only adds tables and columns. No existing schema is broken. A future migration may add constraints or remove nullable columns after the frontend has switched.
5. **Route coexistence.** The existing Next.js routes (`/api/ai/*`) stay alive. No route is removed in this spec.

### NFR-2: Performance

1. **List endpoint.** `GET /api/v1/projects` reads only denormalized columns from the `projects` table. It does not join `project_stories` or load JSONB blueprints.
2. **State save.** `PUT /api/v1/projects/{id}/state` updates one row in `project_state` and one in `projects` (denormalized `stories_completed` and `updated_at`). It does not rewrite the campaign or stories.
3. **Debounced saves.** Rapid state changes produce at most one request per debounce window, not one per change.
4. **Connection pool.** The existing pool limits (`DB_POOL_SIZE` + `DB_MAX_OVERFLOW ≤ 10`) are respected. No new long-running connections.

### NFR-3: Conventions and testing

1. **Result unions.** All public TypeScript functions return `{ ok: true; ... } | { ok: false; ... }` or `null`/`[]`. No throwing at module boundaries. Backend endpoints return HTTP status codes; the `HttpRepository` maps them to `StoreResult`.
2. **Zod at trust boundaries.** Data from the server is validated with Zod before being returned to the app (same pattern as `readProject` today). The `HttpRepository` validates API responses with the existing schemas in `src/lib/ai/schemas/*`.
3. **Pydantic for envelope only.** The server uses Pydantic models for the request/response envelope: top-level fields (`id`, `created_at`, `updated_at`, `source`) and denormalized summary fields (`title`, `genre`, `source_name`, `stories_total`, `stories_completed`). Complex nested objects (`campaign`, `stories`, `campaign_state`, `materials`) are stored and returned as opaque `jsonb` — the server does not model their internal structure. Full validation stays on the client via Zod. This avoids duplicating the complex and evolving Zod schemas in a second language.
4. **Conventional Commits.** Commits use scopes: `feat(api): …`, `feat(state): …`, `feat(db): …`, `test(api): …`, `test(state): …`. Code and tests in separate commits.
5. **Backend tests.** Pytest with Postgres service container in CI (existing pattern). Migrations tested from empty. Endpoint tests use `TestClient` and `NullPool`. Owner isolation test: create with token A, assert token B gets `404` on get/delete/put and empty list. Rate-limit and body-size tests: assert `413` on oversized body, `429` on too many requests.
6. **Frontend tests.** Vitest with `fake-indexeddb` (existing pattern). Repository tests: mock `fetch` for `HttpRepository`, use `fake-indexeddb` for `IndexedDbRepository`. Import test: seed IndexedDB, run sync check, assert server received the data, assert IndexedDB is not cleared on failure. Invalid `campaign_state` test: mock a server response with corrupted `campaign_state`, assert `HttpRepository` drops it (returns `Project` with `campaign_state` undefined) — mirrors the existing `readProject` behavior. **HTTP mode test setup:** because the repository is selected at module load (`const repo = selectRepository()`), tests for `http` mode must use `vi.stubEnv("NEXT_PUBLIC_PROJECT_STORE", "http")` followed by `vi.resetModules()` and a dynamic `import()` of `project-store.ts` to pick up the new env. Tests for `idb` mode (the existing 854 tests) are unaffected.
7. **Contract tests.** Shared fixtures (e.g., a valid `Project` with campaign, stories, and campaign state) must pass the Zod schemas on the client and the Pydantic envelope models on the server. Since the server stores complex objects as opaque jsonb, the contract test verifies that the server accepts and returns the full payload without truncation, and that the client's Zod validation of the returned data still passes. This catches transport-level corruption, not schema drift (which is a client-only concern with the opaque-jsonb approach).

## Open questions

### OQ-1: Data ownership (Q4)

**Status: resolved — option A (anonymous device token).**

LORE has no accounts. Data on the server needs an owner: who can read, modify, and delete a project.

**Decision:** Option A — anonymous device token via `HttpOnly`, `Secure`, `SameSite=Lax` cookie.

| Option | How it works | Chosen? |
|---|---|---|
| **A. Anonymous device token (cookie)** | On first visit, the server issues a random UUID v4 as an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Every project is tagged with the token's UUID as `owner_id`. All queries filter by owner. Cross-owner access returns `404` (not `403`). | **Yes** |
| B. Accounts (OAuth) | Player signs in with GitHub/Google. `owner_id` is the user ID. | No — too much scope for a hackathon. |
| C. Single-user | One shared `owner_id` (or `NULL` for all). Every visitor sees every project. | No — not safe for a public deployment. |

**Implementation requirements:**
- `owner_id` column is `uuid`, nullable at the schema level. New rows and imported rows must set it from the cookie token. Only legacy rows imported without a valid token may be `NULL`.
- No separate identity table is created. The token is stateless — the server does not store it, only uses it as `owner_id` on projects.
- Future upgrade path to accounts (option B): add a `devices` or `users` table, link tokens to users, migrate `owner_id` values. The nullable column and opaque token make this an additive change.
- **TLS handling:** the `Secure` flag is set based on `X-Forwarded-Proto` (set by Caddy, trusted by uvicorn `--proxy-headers`). Over HTTP (no domain, Q3 default), the flag is omitted. Over HTTPS (domain configured), the flag is set. No manual configuration needed — it adapts automatically. See FR-2 and design.md.

## Acceptance criteria

1. **Backend.** `alembic upgrade head` creates the three tables from an empty database. `pytest -v` passes with a Postgres service container. All new endpoint tests pass.
2. **Frontend — idb mode.** With `NEXT_PUBLIC_PROJECT_STORE=idb` (or unset), all 854 existing tests pass unchanged. No behavior change.
3. **Frontend — http mode.** With `NEXT_PUBLIC_PROJECT_STORE=http`, vitest tests pass for the `HttpRepository` (mocked fetch), the import flow (fake-indexeddb → mocked server), and the debounced save logic.
4. **Contract.** Shared fixtures pass the Pydantic envelope models on the server (accept and return without truncation) and the Zod schemas on the client (full validation of complex objects).
5. **Sync check.** A project in IndexedDB that is not on the server is imported on next load. A project with a newer local `updated_at` has its state synced. Imported projects retain `campaign_state` and `stories_completed` (player progress is not lost). If the sync fails, IndexedDB data is retained and retried on the next load.
6. **Public API.** `project-store.ts` exports the same function signatures (plus `setupSaveErrorHandler`). `create/page.tsx` and `SavedStories.tsx` are unchanged. `PlayProject.tsx` changes minimally: it calls `setupSaveErrorHandler(setSaveError)` to receive server save errors from the debounced save.
7. **Deploy order.** The API image is released and deployed first. The web image switches to `http` mode in a subsequent release. Both work during the overlap.
8. **No data loss.** A player with existing IndexedDB projects who switches to `http` mode sees their projects on the server. A player who stays on `idb` mode sees no change.
9. **Invalid state handling.** Loading a project with a `campaign_state` that fails Zod validation returns the project with `campaign_state` omitted (not an error) on the client. The server stores and returns `campaign_state` as opaque jsonb without inspecting it.
10. **Request limits.** Oversized request bodies return `413` (enforced at Caddy for `/api/v1/*` and at FastAPI per endpoint). Rate-limit violations return `429` with `Retry-After`. Per-owner storage cap (100 projects) returns `422`. Missing or non-array `completed_stories` on PUT /state or POST /import returns `422`. Rate-limit bucket dict prunes empty keys (memory does not grow unbounded). Tests verify all.
11. **Owner isolation.** A project created with token A is not visible to a request with token B (list returns empty, get/delete/put return `404`). Creating a project with an id that belongs to another owner returns `409`.
