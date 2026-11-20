# R13 — Design

> **Status:** Design — revised after review. 10 issues fixed.
> **Requirements:** See [requirements.md](./requirements.md).

## Architecture

```
Browser (Next.js)
┌──────────────────────────────────────────────────────────┐
│  project-store.ts  (public API — signatures preserved)     │
│    └─ selectRepository()  (module load, build-time flag)   │
│        ├─ IndexedDbRepository  (current code, extracted)    │
│        └─ HttpRepository        (new)                       │
│            ├─ writes to IndexedDB (local cache, immediate)  │
│            ├─ calls backend API (debounced saves)           │
│            ├─ syncCheck() on load (compares server vs local) │
│            └─ onSaveError callback → PlayProject banner     │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP (via Caddy, TLS when domain set)
┌──────────────────────▼─────────────────────────────────────┐
│  Caddy                                                     │
│  ┌──────────────────────────────────────────────────┐     │
│  │ request_body { max_size 5MB }  on /api/v1/*        │     │
│  │ X-Forwarded-Proto: https|http                      │     │
│  └──────────────────────┬───────────────────────────┘     │
│  ┌──────────────────────▼───────────────────────────┐     │
│  │ FastAPI                                           │     │
│  │  Device token middleware (Set-Cookie on all resp) │     │
│  │  Rate limiter (per-IP + per-owner)                │     │
│  │  /api/v1/projects router                          │     │
│  │  Pydantic envelope validation (422 on bad fields)  │     │
│  │  SQLAlchemy → PostgreSQL                          │     │
│  │   projects / project_stories / project_state      │     │
│  └──────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- `projects.id` is `text` — existing client ids may be `p_<time>_<random>`.
- `owner_id` is `uuid`, nullable at DB level; API always sets it from the cookie token.
- Complex objects are opaque `jsonb`; NOT NULL denormalized fields are validated server-side (422 on missing).
- Timestamps are `bigint` (ms) — no `timestamptz` conversion.
- Stale state writes are rejected with `409`; the conflict check is atomic (single upsert, check rowcount).
- Ownership is checked BEFORE any write; cross-owner access returns `404`.
- Rate limiting is per-IP (primary) + per-owner (secondary) + global storage caps.
- Body size enforced at Caddy (coarse) and FastAPI (per endpoint).
- Device token cookie set via middleware (survives HTTPException); `Secure` flag from `X-Forwarded-Proto`.
- Sync check replaces the `lore:imported` flag; runs on every load, idempotent.
- `PlayProject.tsx` changes minimally: calls `setupSaveErrorHandler(setSaveError)`.

## Data model (SQL DDL)

Deviation from `docs/infra/04-database.md` section 7: `id` is `text` (not `uuid`), timestamps are `bigint` (not `timestamptz`). Both eliminate client↔server conversion.

```sql
-- Revision: r13_persistence
-- Revises: 4ee36ac0a0f8

CREATE TABLE projects (
    id                text PRIMARY KEY,
    owner_id          uuid,
    created_at        bigint NOT NULL,          -- ms since epoch
    updated_at        bigint NOT NULL,          -- ms since epoch
    source            jsonb NOT NULL,           -- { file_name, file_type }
    campaign          jsonb NOT NULL,           -- CampaignBlueprint (opaque)
    materials         jsonb,                    -- MaterialBlueprint[] (opaque, nullable)
    title             text   NOT NULL,          -- denormalized: campaign->>'title'
    genre             text   NOT NULL,          -- denormalized: campaign->>'genre'
    source_name       text   NOT NULL,          -- denormalized: source->>'file_name'
    stories_total     integer NOT NULL,          -- jsonb_array_length(campaign->'story_sequence')
    stories_completed integer NOT NULL DEFAULT 0,
    schema_version    integer NOT NULL DEFAULT 1
);

CREATE TABLE project_stories (
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    story_id   text NOT NULL,
    blueprint  jsonb NOT NULL,                   -- StoryBlueprint (opaque)
    PRIMARY KEY (project_id, story_id)
);

CREATE TABLE project_state (
    project_id     text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    campaign_state jsonb NOT NULL,               -- CampaignState (opaque)
    updated_at     bigint NOT NULL               -- ms, for conflict detection
);

CREATE INDEX idx_projects_owner_updated ON projects (owner_id, updated_at DESC);
```

**Downgrade** drops all three tables and the index.

## Backend design

### Device token middleware

Implemented as an HTTP middleware (not a dependency) so `Set-Cookie` lands on every response, including error responses (`HTTPException` creates a new `Response` and discards a dependency's injected one).

```python
# backend/app/owner.py (new file)

import uuid

COOKIE_NAME = "lore_device"
COOKIE_MAX_AGE = 31536000  # 1 year

def _is_https(request: Request) -> bool:
    # Caddy sets X-Forwarded-Proto; uvicorn --proxy-headers trusts it.
    # request.url.scheme is always "http" behind Caddy (uvicorn receives plain HTTP).
    return request.headers.get("x-forwarded-proto", "") == "https"

def _parse_token(value: str | None) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None  # malformed cookie — issue a new one

async def device_token_middleware(request: Request, call_next):
    if not request.url.path.startswith("/api/v1/projects"):
        return await call_next(request)

    owner_id = _parse_token(request.cookies.get(COOKIE_NAME)) or uuid.uuid4()
    request.state.owner_id = owner_id

    response = await call_next(request)

    # Set cookie on the final response. Works for every response the app returns,
    # including those built from HTTPException (404, 409, 413, 422, 429). It does NOT
    # cover an unhandled exception: Starlette's outermost ServerErrorMiddleware builds
    # that 500 outside this middleware, so no cookie is set on it.
    if not _parse_token(request.cookies.get(COOKIE_NAME)):
        response.set_cookie(
            COOKIE_NAME,
            str(owner_id),
            httponly=True,
            secure=_is_https(request),
            samesite="lax",
            max_age=COOKIE_MAX_AGE,
            path="/",
        )
    return response
```

**Endpoint access to `owner_id`:** a thin dependency reads `request.state.owner_id`:

```python
def get_owner_id(request: Request) -> uuid.UUID:
    owner_id = getattr(request.state, "owner_id", None)
    if owner_id is None:
        owner_id = uuid.uuid4()  # fallback (should not happen — middleware sets it)
        request.state.owner_id = owner_id
    return owner_id
```

**Behavior:**
- No cookie → generate UUID, set cookie, use as `owner_id`.
- Cookie present and valid → reuse.
- Cookie malformed → issue new one.
- `Secure` flag from `X-Forwarded-Proto`: `https` → `Secure=True`, `http` → `Secure=False`. Works behind Caddy where `request.url.scheme` is always `http`.
- No identity table. The token is stateless.

**Registration in `main.py`:** `application.middleware("http")(device_token_middleware)` inside `create_app()`, before `include_router`.

**Testing:** `TestClient` sets cookies via `client.cookies.set(COOKIE_NAME, str(uuid.uuid4()))`. No-cookie tests assert `Set-Cookie` in the response (any status code). Malformed-cookie tests assert a new cookie is issued. Owner isolation tests switch cookies between requests.

### Pydantic envelope models + NOT NULL validation

```python
# backend/app/models.py (new file)

from pydantic import BaseModel, field_validator
from typing import Any

class SourceModel(BaseModel):
    file_name: str
    file_type: str

class ProjectCreate(BaseModel):
    id: str | None = None
    created_at: int | None = None
    updated_at: int | None = None
    source: SourceModel
    campaign: dict[str, Any]    # opaque jsonb
    stories: dict[str, Any]     # opaque jsonb
    campaign_state: dict[str, Any] | None = None
    materials: list[dict[str, Any]] | None = None

    @field_validator("campaign")
    @classmethod
    def validate_denormalized_fields(cls, campaign: dict[str, Any]) -> dict[str, Any]:
        # Fields feeding NOT NULL columns — validate before INSERT, return 422 not 500.
        title = campaign.get("title")
        genre = campaign.get("genre")
        story_sequence = campaign.get("story_sequence")
        errors: list[str] = []
        if not isinstance(title, str) or not title:
            errors.append("campaign.title is required and must be a non-empty string")
        if not isinstance(genre, str) or not genre:
            errors.append("campaign.genre is required and must be a non-empty string")
        if not isinstance(story_sequence, list):
            errors.append("campaign.story_sequence is required and must be an array")
        if errors:
            raise ValueError("; ".join(errors))
        return campaign

    @field_validator("campaign_state")
    @classmethod
    def validate_completed_stories(cls, state: dict[str, Any] | None) -> dict[str, Any] | None:
        if state is None:
            return state
        completed = state.get("completed_stories")
        if not isinstance(completed, list):
            raise ValueError("campaign_state.completed_stories is required and must be an array")
        if not all(isinstance(s, str) for s in completed):
            raise ValueError("campaign_state.completed_stories must be an array of strings")
        return state

class ProjectResponse(BaseModel):
    id: str
    created_at: int
    updated_at: int
    source: dict[str, Any]
    campaign: dict[str, Any]
    stories: dict[str, Any]
    campaign_state: dict[str, Any] | None = None
    materials: list[dict[str, Any]] | None = None

class ProjectSummaryResponse(BaseModel):
    id: str
    title: str
    genre: str
    source_name: str
    updated_at: int
    stories_total: int
    stories_completed: int

class CampaignStateUpdate(BaseModel):
    campaign_state: dict[str, Any]
    updated_at: int

    @field_validator("campaign_state")
    @classmethod
    def validate_completed_stories(cls, state: dict[str, Any]) -> dict[str, Any]:
        # completed_stories feeds jsonb_array_length for stories_completed (NOT NULL column).
        # Without this, a missing or non-array completed_stories causes a 500.
        completed = state.get("completed_stories")
        if not isinstance(completed, list):
            raise ValueError("campaign_state.completed_stories is required and must be an array")
        if not all(isinstance(s, str) for s in completed):
            raise ValueError("campaign_state.completed_stories must be an array of strings")
        return state

class ImportRequest(BaseModel):
    projects: list[ProjectCreate]

class ImportResponse(BaseModel):
    imported: int
    skipped: int

class StateConflictResponse(BaseModel):
    detail: str
    stored_updated_at: int
```

**`source_name`** comes from `source.file_name`, already validated by `SourceModel` (non-empty string). **`stories_total`** is computed as `len(story_sequence)` by the SQL layer (`jsonb_array_length`), so if `story_sequence` is present and is an array, `stories_total` will not be NULL.

### SQLAlchemy data access

#### Ownership check first (security)

Every write endpoint checks ownership before touching any row. The pattern is:

```sql
-- Step 1: ownership check (404 if not owned)
SELECT 1 FROM projects WHERE id = :id AND owner_id = :owner_id
-- If not found → 404 (covers "does not exist" and "not yours" — caller can't distinguish)
```

This runs before any INSERT/UPDATE/DELETE. Without it, an attacker who knows an id can overwrite state (PUT) or probe ids via 409 timing.

#### Create / import: id collision handling

The id is a global PK chosen by the client. `INSERT ... ON CONFLICT (id) DO UPDATE` with a `WHERE` clause that checks ownership:

```sql
INSERT INTO projects (id, owner_id, created_at, updated_at, source, campaign, materials,
                      title, genre, source_name, stories_total, stories_completed, schema_version)
VALUES (:id, :owner_id, :created_at, :updated_at, :source, :campaign, :materials,
        :title, :genre, :source_name, :stories_total, :stories_completed, 1)
ON CONFLICT (id) DO UPDATE
SET campaign = EXCLUDED.campaign,
    materials = EXCLUDED.materials,
    updated_at = EXCLUDED.updated_at,
    source = EXCLUDED.source,
    title = EXCLUDED.title,
    genre = EXCLUDED.genre,
    source_name = EXCLUDED.source_name,
    stories_total = EXCLUDED.stories_total,
    stories_completed = EXCLUDED.stories_completed
WHERE projects.owner_id = EXCLUDED.owner_id
  AND projects.updated_at <= EXCLUDED.updated_at
```

`:stories_completed` is computed in Python: `len(body.campaign_state.get("completed_stories", [])) if body.campaign_state else 0`. This preserves player progress on import — without it, `stories_completed` is always 0 and `campaign_state` is lost.

- `rowcount = 1`: either a new INSERT or an UPDATE of the caller's own project (newer `updated_at`).
- `rowcount = 0`: the row exists but either (a) same owner with older `updated_at` (idempotent skip) or (b) different owner (id collision). To distinguish, `SELECT owner_id FROM projects WHERE id = :id`:
  - Same owner → skip (idempotent, older version).
  - Different owner → `409 Conflict` (create endpoint) or count as `skipped` (import endpoint).

After the project row, insert stories and — if `campaign_state` is present — upsert `project_state`, all in the same transaction:
```sql
-- For UPDATE case: replace old stories
DELETE FROM project_stories WHERE project_id = :id
INSERT INTO project_stories (project_id, story_id, blueprint)
VALUES (:id, :story_id, :blueprint)  -- one row per story

-- If campaign_state is present, upsert project_state (same ownership + updated_at rules):
INSERT INTO project_state (project_id, campaign_state, updated_at)
VALUES (:id, :campaign_state, :updated_at)
ON CONFLICT (project_id) DO UPDATE
SET campaign_state = EXCLUDED.campaign_state, updated_at = EXCLUDED.updated_at
WHERE project_state.updated_at <= EXCLUDED.updated_at
-- If rowcount = 0, the stored state is newer — keep it (don't overwrite newer progress).
```

Without this, imported projects lose all player progress (`campaign_state` is dropped, `stories_completed` is 0). The sync check would then see equal `updated_at` and never re-upload.

#### Get: assemble full project

```sql
SELECT p.id, p.created_at, p.updated_at, p.source, p.campaign, p.materials,
       ps.campaign_state
FROM projects p
LEFT JOIN project_state ps ON ps.project_id = p.id
WHERE p.id = :id AND p.owner_id = :owner_id
-- If not found → 404

SELECT story_id, blueprint FROM project_stories WHERE project_id = :id
-- Assembled in Python: {row.story_id: row.blueprint for row in rows}
```

`campaign_state` is returned as-is (opaque jsonb). The client validates with Zod and drops invalid state.

#### Delete: owner-filtered

```sql
DELETE FROM projects WHERE id = :id AND owner_id = :owner_id
-- If rowcount = 0 → 404
-- Cascades to project_stories and project_state via FK ON DELETE CASCADE
```

#### Put state: ownership check + atomic conflict check

```sql
-- Step 1: ownership check (404 if not owned)
SELECT 1 FROM projects WHERE id = :id AND owner_id = :owner_id
-- If not found → 404

-- Step 2: atomic upsert with conflict detection (single statement)
INSERT INTO project_state (project_id, campaign_state, updated_at)
VALUES (:id, :state, :client_updated_at)
ON CONFLICT (project_id) DO UPDATE
SET campaign_state = EXCLUDED.campaign_state, updated_at = EXCLUDED.updated_at
WHERE project_state.updated_at <= EXCLUDED.updated_at
-- rowcount = 1 → success (new row or updated existing row)
-- rowcount = 0 → conflict (existing row has newer updated_at)

-- Step 3a (success): update denormalized fields on projects
UPDATE projects SET
    stories_completed = jsonb_array_length(:state->'completed_stories'),
    updated_at = :client_updated_at
WHERE id = :id AND owner_id = :owner_id
-- Commit, return 200 with { updated_at: client_updated_at }

-- Step 3b (conflict): get stored updated_at for the 409 response
SELECT updated_at FROM project_state WHERE project_id = :id
-- Rollback, return 409 with { stored_updated_at: stored_value }
```

**Why atomic:** the `INSERT ... ON CONFLICT ... WHERE` is a single statement. There is no race between a SELECT and a separate upsert. If two requests arrive simultaneously, each is atomic; the one with the later `updated_at` wins, the other gets `rowcount = 0`.

**First state save:** if `project_state` has no row for this project, the INSERT succeeds (`rowcount = 1`). No conflict possible.

### Rate limiting

Per-IP (primary) + per-owner (secondary) + global storage caps.

```python
# backend/app/ratelimit.py (new file) - illustrative, not final code

import threading
import time
from collections import deque

class RateLimiter:
    WINDOW = 60            # seconds, sliding window for the per-minute buckets
    SWEEP_EVERY = 500      # run a sweep every N calls ...
    SWEEP_KEYS = 5000      # ... or when the total key count exceeds this

    def __init__(self, monotonic=time.monotonic, wall=time.time):
        self._mono = monotonic          # injectable for tests
        self._wall = wall               # injectable for tests (calendar day)
        self._lock = threading.Lock()   # sync endpoints run in a threadpool
        self._ip: dict[str, deque[float]] = {}
        self._owner: dict[str, deque[float]] = {}
        self._import: dict[str, deque[float]] = {}
        self._daily_create: dict[str, tuple[int, int]] = {}  # ip -> (utc_day, count)
        self._calls = 0

    def _check_and_record(self, buckets: dict, key: str, limit: int) -> bool:
        now = self._mono()
        with self._lock:
            self._maybe_sweep(now)
            window = buckets.setdefault(key, deque())
            while window and now - window[0] >= self.WINDOW:   # 1. drop old timestamps
                window.popleft()
            if len(window) >= limit:                            # 2. over the limit
                return False
            window.append(now)                                  # 3. record this request
            return True

    def check_ip(self, ip: str, limit: int = 120) -> bool:
        return self._check_and_record(self._ip, ip, limit)

    def check_owner_write(self, owner_id: str, limit: int = 60) -> bool:
        return self._check_and_record(self._owner, owner_id, limit)

    def check_import(self, ip: str, limit: int = 5) -> bool:
        return self._check_and_record(self._import, ip, limit)

    def check_daily_create(self, ip: str, limit: int = 100) -> bool:
        today = int(self._wall() // 86400)       # UTC calendar day (not time since boot)
        with self._lock:
            self._maybe_sweep(self._mono())
            day, count = self._daily_create.get(ip, (today, 0))
            if day != today:                      # new UTC day: counter resets
                day, count = today, 0
            if count >= limit:
                return False
            self._daily_create[ip] = (day, count + 1)
            return True

    # --- memory bound: runs OUTSIDE the hot path of a single check ---
    def _maybe_sweep(self, now: float) -> None:   # caller holds the lock
        self._calls += 1
        total = len(self._ip) + len(self._owner) + len(self._import) + len(self._daily_create)
        if self._calls % self.SWEEP_EVERY and total <= self.SWEEP_KEYS:
            return
        for buckets in (self._ip, self._owner, self._import):
            for key in list(buckets):
                window = buckets[key]
                while window and now - window[0] >= self.WINDOW:
                    window.popleft()
                if not window:
                    del buckets[key]              # idle key: remove
        today = int(self._wall() // 86400)
        for ip in [k for k, (day, _) in self._daily_create.items() if day != today]:
            del self._daily_create[ip]            # yesterday's counters: remove
```

Notes on this design:
- A check on a fresh key creates an empty deque, drops nothing, passes the limit test, **appends the timestamp**, and returns True. The earlier draft deleted the key and returned before recording, so no window could ever fill.
- Empty keys are removed only by `_maybe_sweep` (every 500 calls, or when more than 5,000 keys exist), never in the per-request path.
- `threading.Lock` is required because FastAPI runs sync endpoints and dependencies in a threadpool; unsynchronised dict and deque mutation would race.
- Check order in the router: per-IP first, then per-owner or import, then the daily quota. A request rejected by an earlier check does not reach later ones. A request that passes an earlier check and fails a later one has still consumed the earlier budget; this is accepted.
- `Retry-After` on a 429 is the fixed upper bound `60` (the window length).

**IP extraction:** use `request.client.host`. Uvicorn started with `--proxy-headers --forwarded-allow-ips=10.20.0.0/24` already replaces the client address with the value from `X-Forwarded-For` when the connection comes from a trusted proxy, taking the right-most address that is not itself trusted. The application does not parse `X-Forwarded-For` itself, because the left-most entry is client-controlled whenever a proxy appends instead of overwriting. Without a trusted proxy (tests, direct connection) `request.client.host` is the socket peer.

**X-Forwarded-For trust model:** Caddy overwrites (not appends to) `X-Forwarded-For` with the connecting client's IP by default (to be verified on the deployed Caddy, see tasks.md). If it did append, taking the right-most untrusted entry (what uvicorn does) still yields the address Caddy saw, so a client cannot choose its own rate-limit key. If neither held, a client could rotate forged addresses to evade the per-IP limit; the owner-level limit and the storage caps would then be the only remaining limits. The api instance is in a private subnet (`10.20.10.10`) and only reachable through Caddy (security group rules — port 8000 is not exposed to the internet). Uvicorn's `--forwarded-allow-ips=10.20.0.0/24` ensures only Caddy's subnet is trusted for proxy headers. A client sending a spoofed `X-Forwarded-For` directly to the api is not possible without network access to the private subnet. In tests (no Caddy), `X-Forwarded-For` is absent, and the direct connection IP is used.

**Limits:**
- Per-IP: 120/min for all `/api/v1/projects/*` combined.
- Per-owner write: 60/min for POST/DELETE/PUT. (1500 ms debounce → max ~40 PUT/min, so 60/min gives headroom.)
- Import: 5/min per IP.
- Per-IP daily creation quota: max 100 `POST /projects` per IP per UTC calendar day. Stored as one entry per IP, `{ ip: (utc_day, count) }`, where `utc_day = int(time.time() // 86400)`. The counter resets when the stored day differs from today, and the sweep deletes entries from earlier days. Checked after the per-IP rate limit on POST /projects.

**Residual risk:** without the daily quota, one IP could create 10,000 projects in ~83 minutes (120/min × 83 min), filling the global cap and blocking all other users. The daily quota (100 creates/IP/day) raises this to ~100 days. This is accepted for a hackathon; a production deployment would add CAPTCHA or signup gating.

**Storage caps** (checked on create/import):
- Per-owner: max 100 projects. `SELECT count(*) FROM projects WHERE owner_id = :owner_id`.
- Per-owner size: max 50 MB. `SELECT coalesce(sum(octet_length(campaign::text) + coalesce(octet_length(materials::text), 0)), 0) + (SELECT coalesce(sum(octet_length(blueprint::text)), 0) FROM project_stories WHERE project_id IN (SELECT id FROM projects WHERE owner_id = :owner_id)) FROM projects WHERE owner_id = :owner_id`.
- Global: max 10,000 projects. `SELECT count(*) FROM projects`.
- Exceeding returns `422` with a message.

**Dict pruning:** idle keys are removed by a periodic sweep (every 500 calls, or immediately when the total key count exceeds 5,000), not in the per-request path. The sweep drops expired timestamps, deletes keys whose window is empty, and deletes daily-quota entries from earlier UTC days. Growth is bounded because per-IP limiting caps how many new owner keys one IP can create (at most 120 per minute), so cookie cycling cannot grow the dicts faster than the sweep clears them.

### Body size limits

**Caddy (first line of defense):** add `request_body { max_size 5MB }` to the `/api/v1/*` handle block. This catches chunked uploads (no `Content-Length`) before they reach FastAPI.

```caddyfile
handle /api/v1/* {
    request_body {
        max_size 5MB
    }
    reverse_proxy {$API_UPSTREAM} {
        flush_interval -1
        transport http {
            response_header_timeout 330s
        }
    }
}
```

**FastAPI (per endpoint, defense in depth):** read the body, check `len(body_bytes)`. This catches anything that slips through Caddy (e.g., misconfigured proxy).

| Endpoint | Limit | Rationale |
|---|---|---|
| `POST /projects` | 2 MB | Typical full project ~170 KB (estimated from schema field sizes and typical content lengths; should be verified during implementation by logging `JSON.stringify(project).length` in a test). 2 MB is ~12× headroom. |
| `POST /import` | 5 MB | Client batches by byte size, not count: max 4 MB per request (1 MB headroom under Caddy's 5 MB). At ~170 KB per project, that is ~23 projects per batch. No hard count cap — size is the binding constraint. |
| `PUT /state` | 500 KB | CampaignState ~10 KB; 500 KB is ~50× headroom. |

Oversized → `413 Payload Too Large`.

## Frontend design

### ProjectRepository interface

```typescript
// frontend/src/lib/state/repository.ts (new file)

export interface ProjectRepository {
  listProjects(): Promise<ProjectSummary[]>;
  loadProject(id: string): Promise<Project | null>;
  createProject(input: {
    id?: string;                    // if omitted, implementation generates one
    source: Project["source"];
    campaign: CampaignBlueprint;
    stories: ReadonlyMap<string, StoryBlueprint> | Record<string, StoryBlueprint>;
    materials?: MaterialBlueprint[];
  }): Promise<StoreResult<Project>>;
  saveCampaignState(id: string, campaignState: CampaignState): Promise<StoreResult>;
  deleteProject(id: string): Promise<void>;
}
```

The optional `id` parameter lets `HttpRepository` generate the id once and pass it to both the local write and the server POST, so they stay in sync. The public `project-store.ts` function does not expose `id` — it delegates without passing one, and the implementation generates it.

### IndexedDbRepository

Extracts the existing IndexedDB logic from `project-store.ts` into a class. The `createProject` method accepts an optional `id` (uses `newId()` if not provided). No other behavior change. `migrateFromLocalStorage` and `storeReady` stay here. `projectStories` remains a free function in `project-store.ts`.

### HttpRepository

```typescript
// frontend/src/lib/state/http-repository.ts (new file)

const API_BASE = "/api/v1/projects";
const DEBOUNCE_MS = 1500;
const INITIAL_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;

export class HttpRepository implements ProjectRepository {
  private local = new IndexedDbRepository();
  private pendingState: { id: string; state: CampaignState; updatedAt: number } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInProgress = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = INITIAL_RETRY_MS;
  private onError: ((message: string | null) => void) | null = null;

  onSaveError(fn: (message: string | null) => void): void {
    this.onError = fn;
  }

  // ---- listProjects: merge server + local-only ----
  async listProjects(): Promise<ProjectSummary[]> {
    const [serverResult, localResult] = await Promise.allSettled([
      this.fetchServerList(),
      this.local.listProjects(),
    ]);
    const server = serverResult.status === "fulfilled" ? serverResult.value : [];
    const local = localResult.status === "fulfilled" ? localResult.value : [];
    // Local-only: in IndexedDB but not on server (unsynced creates)
    const serverIds = new Set(server.map((s) => s.id));
    const localOnly = local.filter((s) => !serverIds.has(s.id));
    return [...server, ...localOnly].sort((a, b) => b.updated_at - a.updated_at);
  }

  private async fetchServerList(): Promise<ProjectSummary[]> {
    const res = await fetch(API_BASE);
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    return (await res.json()).flatMap((raw: unknown) => {
      const parsed = SummarySchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  }

  // ---- loadProject: server first, fall back to local on 404 or network error ----
  async loadProject(id: string): Promise<Project | null> {
    try {
      const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`);
      if (res.status === 404) return this.local.loadProject(id); // not on server → local
      if (!res.ok) return this.local.loadProject(id);
      return readProject(await res.json());
    } catch {
      return this.local.loadProject(id); // network error → local
    }
  }

  // ---- createProject: generate id, local first, then server ----
  async createProject(input: CreateProjectInput): Promise<StoreResult<Project>> {
    const id = input.id ?? newId();
    const now = Date.now();
    const stories = input.stories instanceof Map
      ? Object.fromEntries(input.stories) : { ...input.stories };
    const project: Project = {
      id, created_at: now, updated_at: now,
      source: input.source, campaign: input.campaign, stories,
      ...(input.materials ? { materials: input.materials } : {}),
    };
    // Local first (survives server failure)
    const localResult = await this.local.createProject({ ...input, id });
    if (!localResult.ok) return localResult;
    try {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      if (res.ok) {
        const saved = readProject(await res.json());
        return saved ? { ok: true, value: saved } : { ok: false, message: "Server returned invalid data." };
      }
      if (res.status === 409) {
        // Clean up orphan local copy — the id collides with another owner's project.
        // Without this, the local copy persists with an id the server rejected.
        await this.local.deleteProject(id);
        return { ok: false, message: "This story ID already exists. Try again." };
      }
      return { ok: false, message: "Could not save to the server. Your story is kept on this device." };
    } catch {
      // Local copy survives — syncCheck will upload it on next load
      return { ok: true, value: project }; // optimistic: project is saved locally
    }
  }

  // ---- saveCampaignState: local immediately, server debounced ----
  async saveCampaignState(id: string, campaignState: CampaignState): Promise<StoreResult> {
    const updatedAt = Date.now();
    const localResult = await this.local.saveCampaignState(id, campaignState);
    if (!localResult.ok) return localResult;

    this.pendingState = { id, state: campaignState, updatedAt };
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flushState(), DEBOUNCE_MS);

    return { ok: true, value: undefined }; // optimistic — server errors via onError
  }

  private async flushState(): Promise<void> {
    if (!this.pendingState || this.saveInProgress) return;
    this.saveInProgress = true;
    const { id, state, updatedAt } = this.pendingState;

    try {
      const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_state: state, updated_at: updatedAt }),
      });
      if (res.ok) {
        this.pendingState = null;       // clear only on success
        this.retryDelay = INITIAL_RETRY_MS; // reset backoff
        this.onError?.(null);
      } else if (res.status === 409) {
        this.pendingState = null;        // stale write — don't retry
        const body = await res.json();
        this.onError?.("Your progress was saved from another session. Reload to see the latest.");
      } else if (res.status === 404) {
        this.pendingState = null;        // project not on server — syncCheck will handle
        this.onError?.("This story is not on the server yet. It will sync on your next visit.");
      } else if (res.status === 429) {
        // rate limited — honor Retry-After, keep pendingState
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
        this.retryDelay = Math.min(retryAfter * 1000, MAX_RETRY_MS);
        this.onError?.("Server is busy. Your progress is kept on this device and will retry.");
        this.scheduleRetry();
      } else {
        // server error — exponential backoff, keep pendingState
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
        this.onError?.("Could not save your progress. It is kept on this device and will retry.");
        this.scheduleRetry();
      }
    } catch {
      // network error — exponential backoff, keep pendingState
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
      this.onError?.("Could not reach the server. Your progress is kept on this device.");
      this.scheduleRetry();
    } finally {
      this.saveInProgress = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.flushState(), this.retryDelay);
  }

  // ---- deleteProject: local first, then server (best effort) ----
  async deleteProject(id: string): Promise<void> {
    await this.local.deleteProject(id);
    try { await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    catch { /* best-effort; local copy already deleted */ }
  }
}
```

**Design decisions:**

1. **Local-first writes.** `createProject` and `saveCampaignState` write to IndexedDB before the server. If the server call fails, the local copy survives. `loadProject` tries server first, falls back to IndexedDB on 404 or network error. `listProjects` merges server + local-only (unsynced) projects.

2. **Optimistic return on save.** `saveCampaignState` returns `{ ok: true }` after the local write. The debounced server save reports errors via `onError` callback. `pendingState` is cleared only on success or stale write (409), not on server/network error — those retry.

3. **Retry with backoff.** `flushState` keeps `pendingState` on server error or network error. Retries use exponential backoff (5 s → 10 s → 20 s → 40 s → 60 s cap). On `429 Too Many Requests`, the delay is set from the `Retry-After` header instead of backoff. On success or stale write (409), the backoff resets to 5 s. If a new state change arrives during the retry wait, `pendingState` is updated with the newer state (the retry sends the latest). `syncCheck` on next load is the fallback for failures that persist across sessions.

4. **createProject on network failure** returns `{ ok: true, value: project }` (optimistic) — the project is saved locally. `syncCheck` on next load detects it's not on the server and uploads it.

5. **Debounce window: 1500 ms.** Short enough that progress is not lost on a sudden tab close (the local IndexedDB write is immediate), long enough to coalesce rapid state changes into one server request.

### Sync check (replaces lore:imported flag)

```typescript
// frontend/src/lib/state/sync.ts (new file)

const MAX_IMPORT_BATCH_BYTES = 4 * 1024 * 1024; // 4 MB (1 MB headroom under Caddy 5 MB)

export async function syncCheck(): Promise<void> {
  // Get server project summaries
  let serverSummaries: Map<string, ProjectSummary>;
  try {
    const res = await fetch("/api/v1/projects");
    if (!res.ok) return; // offline or error — try next load
    const list = await res.json();
    serverSummaries = new Map(
      list.map((s: { id: string; updated_at: number }) => [s.id, s])
    );
  } catch {
    return; // offline — try next load
  }

  // Get IndexedDB summaries
  const localRepo = new IndexedDbRepository();
  const localSummaries = await localRepo.listProjects();
  if (localSummaries.length === 0) return;

  // Collect unsynced projects and state updates
  const toImport: Project[] = [];
  const toSyncState: { id: string; state: CampaignState; updatedAt: number }[] = [];

  for (const local of localSummaries) {
    const server = serverSummaries.get(local.id);
    if (!server) {
      // Not on server → import
      const project = await localRepo.loadProject(local.id);
      if (project) toImport.push(project);
    } else if (local.updated_at > server.updated_at) {
      // Local is newer → sync state
      const project = await localRepo.loadProject(local.id);
      if (project?.campaign_state) {
        toSyncState.push({ id: local.id, state: project.campaign_state, updatedAt: project.updated_at });
      }
    }
    // If server is newer or equal → no action
  }

  // Batch imports by byte size (not count) to stay under Caddy's 5 MB limit
  let batch: Project[] = [];
  let batchSize = 0;
  for (const project of toImport) {
    const size = JSON.stringify(project).length;
    if (batchSize + size > MAX_IMPORT_BATCH_BYTES && batch.length > 0) {
      await sendImportBatch(batch);
      batch = [];
      batchSize = 0;
    }
    batch.push(project);
    batchSize += size;
  }
  if (batch.length > 0) await sendImportBatch(batch);

  // Sync state updates (PUT, one per project — small, infrequent)
  for (const { id, state, updatedAt } of toSyncState) {
    try {
      await fetch(`/api/v1/projects/${encodeURIComponent(id)}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_state: state, updated_at: updatedAt }),
      });
    } catch { /* best-effort — retry on next load */ }
  }
}

async function sendImportBatch(projects: Project[]): Promise<void> {
  try {
    await fetch("/api/v1/projects/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects }),
    });
  } catch { /* best-effort — retry on next load */ }
}
```

**When it runs:** on app load (e.g., from `HomeComposer` or a root layout `useEffect`), after mount. Not blocking — runs in the background.

**Why no flag:** the sync check is idempotent. On every load:
- Projects already on the server with the same or newer `updated_at` → skipped (no action).
- Projects not on the server → imported (first migration, or cookie changed → new owner has nothing).
- Projects with newer local state → state synced (previous save failed).

If the user clears cookies, they get a new owner_id. The server list is empty (new owner). All IndexedDB projects are "not on server" → imported. No flag to interfere.

**Batching:** imports are batched by byte size (max 4 MB per request) to stay under Caddy's 5 MB limit. At ~170 KB per project, each batch holds ~23 projects. State syncs are sent individually (PUT per project) — they are small and infrequent.

### project-store.ts delegation

```typescript
// frontend/src/lib/state/project-store.ts (modified)

// Types, schemas, readProject, summarize, failure, newId — unchanged, still internal/exported
// projectStories — unchanged, still exported (synchronous, no I/O)
// resetProjectStoreForTests — unchanged, still exported

// Repository selection at module load
function selectRepository(): ProjectRepository {
  const mode = process.env.NEXT_PUBLIC_PROJECT_STORE ?? "idb";
  return mode === "http" ? new HttpRepository() : new IndexedDbRepository();
}

const repo = selectRepository();

// Thin delegates (same signatures):
export async function listProjects() { return repo.listProjects(); }
export async function loadProject(id: string) { return repo.loadProject(id); }
export async function createProject(input: { ... }) { return repo.createProject(input); }
export async function saveCampaignState(id: string, state: CampaignState) { return repo.saveCampaignState(id, state); }
export async function deleteProject(id: string) { return repo.deleteProject(id); }

// NEW export: wire server save errors to the UI
export function setupSaveErrorHandler(fn: (message: string | null) => void): void {
  if (repo instanceof HttpRepository) {
    repo.onSaveError(fn);
  }
  // In idb mode, no-op (IndexedDbRepository reports errors via return value)
}
```

### PlayProject.tsx (minimal change)

```typescript
// frontend/src/components/play/PlayProject.tsx (modified)

import { loadProject, projectStories, saveCampaignState, setupSaveErrorHandler, type Project } from "@/lib/state/project-store";

export function PlayProject() {
  // ... existing state ...
  const [saveError, setSaveError] = useState<string | null>(null);

  // NEW: wire debounced server save errors to the banner
  useEffect(() => {
    setupSaveErrorHandler(setSaveError);
  }, []);

  // ... existing loadProject effect, render logic, onStateChange ...
  // onStateChange still calls saveCampaignState and inspects the StoreResult
  // for local-save errors. Server-save errors arrive via the callback.
}
```

**What changed:** one import (`setupSaveErrorHandler`) and one `useEffect` (3 lines). The existing `onStateChange` handler is unchanged — it handles local-save errors. The callback handles server-save errors from the debounced save. Both write to the same `saveError` state.

### create/page.tsx and SavedStories.tsx

**Unchanged.** They import from `project-store.ts` as before. `createProject` still returns `StoreResult<Project>`; `listProjects` still returns `ProjectSummary[]`; `deleteProject` still returns `void`. The repository selection is internal.

## Testing strategy

### Backend tests (pytest, Postgres service container)

| Test file | What it covers |
|---|---|
| `tests/test_projects_migration.py` | `alembic upgrade head` creates tables; `downgrade` drops them; re-upgrade from empty. |
| `tests/test_projects.py` | CRUD: create → get → list → put state → delete. Owner isolation: token A's project → 404 for token B. Cross-owner id collision: create with token B using A's id → 409. Conflict: stale `updated_at` → 409 with `stored_updated_at`. Body size: 413 on oversized POST/PUT (mock large body). Rate limit: 429 on too many requests. Storage cap: 422 on >100 projects. NOT NULL validation: 422 on missing `campaign.title`. `completed_stories` validation: 422 on PUT /state with missing or non-array `completed_stories`. **Import preserves progress**: POST /import with a project that has `campaign_state` and `completed_stories` → GET the project → assert `campaign_state` and `stories_completed` are preserved. Cookie: no cookie → `Set-Cookie` on 200 and on 422. |
| `tests/test_owner.py` | No cookie → `Set-Cookie` header with valid UUID. Valid cookie → reused. Malformed cookie → new cookie. `X-Forwarded-Proto: https` → `Secure` flag set. `X-Forwarded-Proto: http` → `Secure` not set. |
| `tests/test_ratelimit.py` | Written FIRST (before `ratelimit.py`). Uses injected clocks. **Limit triggers**: the 120th request in 60 s passes and the 121st returns False; after 60 s the window frees up. **Records on a fresh key**: a first call on a new key must leave a timestamp in the bucket (regression test for the inert draft). **Sweep shrinks the dicts**: create N keys, advance the clock past the window, run enough calls to trigger a sweep, assert the dict is smaller. **Sweep by size**: exceed `SWEEP_KEYS`, assert a sweep runs. **Daily quota**: the 101st create in one UTC day returns False; advancing the wall clock past UTC midnight resets it; the sweep removes entries from earlier days. **Thread safety**: concurrent calls from several threads never exceed the limit. |

### Frontend tests (vitest, fake-indexeddb, mocked fetch)

| Test file | What it covers |
|---|---|
| `tests/state/http-repository.test.ts` | Mocked `fetch`: list, load, create, delete. Offline fallback: fetch rejects → falls back to IndexedDbRepository. Debounced save: rapid calls → one fetch. 409 → error callback. 404 on load → falls back to local. Network error on create → optimistic success (local copy). **409 on create → local copy deleted** (orphan cleanup). **Backoff**: mock 500 repeatedly → assert retry delay doubles. **Retry-After**: mock 429 with `Retry-After: 10` → assert retry after 10 s. Invalid `campaign_state` in response → dropped by `readProject`. |
| `tests/state/sync.test.ts` | Seed IndexedDB → run syncCheck with mocked fetch → assert import called for unsynced projects (batched by size). Server has project with older `updated_at` → assert PUT state called. Server has project with newer `updated_at` → no action. **Import preserves progress**: seed IndexedDB with a project that has `campaign_state` → syncCheck imports it → assert import body includes `campaign_state`. Empty IndexedDB → no fetch. Offline → no error. |
| `tests/state/project-store.test.ts` | Existing idb tests unchanged. **HTTP mode:** `vi.stubEnv("NEXT_PUBLIC_PROJECT_STORE", "http")` → `vi.resetModules()` → `await import("@/lib/state/project-store")` → assert functions delegate to HttpRepository (mock fetch). |

**HTTP mode test setup:** because `selectRepository()` runs at module load and reads `process.env.NEXT_PUBLIC_PROJECT_STORE`, tests must set the env before importing the module. The pattern is:
```typescript
vi.stubEnv("NEXT_PUBLIC_PROJECT_STORE", "http");
vi.resetModules();
const store = await import("@/lib/state/project-store");
// now store.listProjects() uses HttpRepository
```
The existing 854 tests (idb mode) are unaffected — they import `project-store.ts` at the top level where the env is unset (defaults to `idb`).

### Contract tests

Shared fixture JSON (e.g., `tests/fixtures/linear-story.json`) is loaded by both:
- **Client:** `ProjectSchema.safeParse(fixture)` passes; `CampaignStateSchema.safeParse(fixture.campaign_state)` passes.
- **Server:** `ProjectCreate(**fixture)` accepts the payload (envelope validation). `ProjectResponse(**stored).model_dump()` returns the same JSON structure (no truncation). `campaign.title` etc. present → no 422.

## Deployment sequence

1. **Backend release (API first).** Merge backend PR: Alembic migration, Pydantic models, router, rate limiter, device token middleware, Caddyfile update (`request_body max_size`). CI runs `alembic upgrade head` + `pytest -v`. Release API image, deploy. `alembic upgrade head` runs as the `migrate` service. Caddy reloads with the new Caddyfile (deployed via SSM as part of `deploy/web/compose.yml`).

2. **Smoke test.** `curl -X POST $APP_URL/api/v1/projects -H 'Content-Type: application/json' -d '{...}'` returns 201. Verify `Set-Cookie` header. `curl $APP_URL/api/v1/projects` returns the project. `curl -X PUT $APP_URL/api/v1/projects/{id}/state ...` returns 200.

3. **Frontend release (web second).** Merge frontend PR. The `release-web.yml` workflow builds with `NEXT_PUBLIC_PROJECT_STORE=http` as a Docker build arg (added to `docker/build-push-action` `build-args` and the Dockerfile `ARG`). CI runs vitest (both modes) + `npm run build`. Release web image, deploy.

4. **Verification.** Open the app with existing IndexedDB projects. `syncCheck` runs automatically. Projects appear (served from API + local merge). Play a story — state saves are debounced and sent to the server. Clear IndexedDB — projects still load from the server.

5. **Rollback.** `NEXT_PUBLIC_PROJECT_STORE` is a `NEXT_PUBLIC_` var, inlined at build time. Rolling back requires an image built with `idb` (or without the build arg, since the Dockerfile `ARG` defaults to `idb`). Use `release-web.yml` `workflow_dispatch` with a tag from before the `http` switch — that tag was built without the build arg → `idb` mode. Deploy it. The API stays running (harmless). No env change or rebuild needed; just redeploy the old image.

## File inventory

### New files

| File | Purpose |
|---|---|
| `backend/app/owner.py` | Device token middleware + `get_owner_id` dependency |
| `backend/app/models.py` | Pydantic envelope models + NOT NULL field validators |
| `backend/app/projects.py` | FastAPI router + SQLAlchemy data access |
| `backend/app/ratelimit.py` | Per-IP + per-owner rate limiter + storage caps |
| `backend/alembic/versions/<rev>_r13_persistence.py` | Alembic migration |
| `backend/tests/test_projects.py` | Endpoint tests |
| `backend/tests/test_owner.py` | Device token tests |
| `backend/tests/test_ratelimit.py` | Rate limiter tests (pruning, daily quota, 429) |
| `backend/tests/test_projects_migration.py` | Migration tests |
| `backend/tests/fixtures/linear-story.json` | Shared contract fixture |
| `frontend/src/lib/state/repository.ts` | `ProjectRepository` interface |
| `frontend/src/lib/state/indexed-db-repository.ts` | `IndexedDbRepository` (extracted) |
| `frontend/src/lib/state/http-repository.ts` | `HttpRepository` |
| `frontend/src/lib/state/sync.ts` | `syncCheck()` |
| `frontend/tests/state/http-repository.test.ts` | HttpRepository tests |
| `frontend/tests/state/sync.test.ts` | Sync check tests |

### Modified files

| File | Change |
|---|---|
| `backend/app/main.py` | Register middleware + include `projects.router` |
| `frontend/src/lib/state/project-store.ts` | Extract to `IndexedDbRepository`, add `selectRepository()`, delegates, `setupSaveErrorHandler` export |
| `frontend/src/components/play/PlayProject.tsx` | Import `setupSaveErrorHandler`, add `useEffect` to wire it (3 lines) |
| `frontend/.env.example` | Add `NEXT_PUBLIC_PROJECT_STORE=idb\|http` |
| `frontend/Dockerfile` | Add `ARG NEXT_PUBLIC_PROJECT_STORE=idb` + `ENV` |
| `.github/workflows/release-web.yml` | Add `build-args: NEXT_PUBLIC_PROJECT_STORE=http` to the build step |
| `deploy/web/Caddyfile` | Add `request_body { max_size 5MB }` to `/api/v1/*` handle |
| `frontend/tests/fixtures/fresh-store.ts` | May need update if `resetProjectStoreForTests` moves |

### Unchanged files

All consuming components except `PlayProject.tsx` (`create/page.tsx`, `SavedStories.tsx`), all schemas, all types, all game engine code, all AI pipeline code, all existing tests in `idb` mode.
