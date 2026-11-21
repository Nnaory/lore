# R13 — Implementation tasks

> **Status:** Tasks — awaiting review. No task has been started.
> **Requirements:** [requirements.md](./requirements.md). **Design:** [design.md](./design.md).

## How to read this list

Every task has a checkbox, the requirement and design sections it satisfies, the files it touches, its test, and its commits.

**Environment markers**

| Marker | Meaning |
|---|---|
| `[CI]` | Runs in CI and on a developer machine. Needs no deployed environment. |
| `[PG]` | As `[CI]`, but needs PostgreSQL 16. In CI this is the `postgres:16-alpine` service container. Locally it needs `PGHOST` and friends; the DB tests skip without `PGHOST`, as `tests/test_db.py` does today. |
| `[LOCAL]` | Manual step on a developer machine (measurement, `docker run`). Not in CI. |
| `[DEPLOYED]` | Needs the deployed AWS environment (real Caddy, real RDS, the public URL). **Never run in CI.** Some of these change production and need an explicit go-ahead from the user. |

**Rules that apply to every task**

- One task is one code commit plus one test commit, in separate Conventional Commits with a scope (`feat(db)`, `test(db)`, `feat(api)`, `feat(state)`, `feat(infra)`, `docs(infra)`). Tasks marked **tests first** commit the test first (red), then the code (green). The red commit is expected inside the PR; CI judges the PR head.
- Nothing is committed or pushed until the user asks (project convention). The commit lines below describe what to commit when asked.
- Every new file starts with a header comment that states its purpose and why (project convention).
- Results are `{ ok: true, ... } | { ok: false, ... }`; nothing throws across a module boundary. Zod validates data at every client trust boundary.
- A task is done when its own test passes and the stack gate passes. Backend gate, run from `backend/`: `ruff check . && ruff format --check .` and `pytest -v`. Frontend gate, run from `frontend/`: `npm run lint`, `npx next typegen`, `npx tsc --noEmit`, `npx vitest run --testTimeout=60000`, `npm run build` (with `AI_PROVIDER=dummy`).
- Check the repository's merge method before PR 1. If it squash-merges, the separate code and test commits collapse into one; use merge or rebase merge for this work.

**Pull requests and gates**

| PR | Tasks | Notes |
|---|---|---|
| 1 `feat(api)` | T0 (spec numbers), T1–T11 | Backend. The web flag stays `idb`, so nothing changes for users. |
| 2 `feat(infra)` | T12 | Caddyfile. Replaces the web instance, so it needs an `infra.yml` plan review and the `production` approval. |
| 3 `feat(state)` | F1–F8 | Frontend. Merged with the flag defaulting to `idb`. |
| 4 `docs(infra)` | D1 | Documentation. |
| 5 `ci(release)` | D5 | The only change that switches production to `http` mode. |

- **Gate A** is reached after PR 1, PR 2, and D2–D4: the API is deployed, tested, and smoke-tested, and the frontend still uses `idb`. This is a complete, demonstrable backend even if the frontend phase is cut.
- **Gate B** is PR 3 merged with the flag still `idb`. Existing behavior is unchanged and all 854 existing tests pass.
- **Gate C** is PR 5 merged and D6 verified.

The Kiroween deadline date used in planning has not been checked against the official page.

---

## Phase 0 — Numbers the design depends on

- [x] **T0 — Measure a real project's JSON size** `[LOCAL]`
  - **Satisfies:** FR-7.1, design "Body size limits". The "~170 KB per project" figure is an estimate from schema shapes. It has not been measured, and the 2 MB, 4 MB, 500 KB, and 50 MB limits all rest on it.
  - **How:** run the dev server with a real `GOOGLE_API_KEY` (never committed). Generate one `short` (3 chapter) and one `medium` (5 chapter) project from a real document, and one `medium` project from the largest allowed input (80,000 characters). Finish at least one story in each. In browser devtools, read the `lore` database, store `projects`, and record `new Blob([JSON.stringify(record)]).size` for the whole record, `campaign`, each story, `materials`, and `campaign_state`.
  - **Files:** `design.md` (replace the "~170 KB" estimate with the measured table), `requirements.md` FR-7 if a limit changes.
  - **Test:** none. The output is a table. If a medium project exceeds 1 MB or the largest input exceeds 2 MB, revisit the limits before T8 and T11.
  - **Fallback:** without an API key, the dummy provider's output gives only a lower bound. State that in the table instead of presenting it as typical.
  - **Commit:** `docs(spec): record measured project size`.

## Phase 1 — Backend (PR 1; flag stays `idb`)

- [x] **T1 — Alembic migration** `[PG]`
  - **Satisfies:** FR-1.1–1.5, NFR-1.3; design "Data model (SQL DDL)".
  - **Files:** `backend/alembic/versions/<rev>_r13_persistence.py` (`down_revision = "4ee36ac0a0f8"`, hand-written SQL, additive only, a real `downgrade`), `backend/tests/test_projects_migration.py`, `backend/tests/test_db.py`.
  - **Test:**
    - `upgrade head` from empty creates `projects`, `project_stories`, `project_state`, and `idx_projects_owner_updated`. Check `information_schema`: ids are `text`, timestamps are `bigint`, `owner_id` is a nullable `uuid`.
    - Deleting a project cascades to its stories and state.
    - `downgrade base` drops everything and a second `upgrade head` works.
    - `test_live_postgres_alembic_upgrade_and_downgrade` in `tests/test_db.py` currently asserts that the head revision equals `4ee36ac0a0f8`. It must be updated to the new head (read it from Alembic's `ScriptDirectory` rather than hard-coding it).
  - **Commits:** `feat(db): add projects, project_stories and project_state tables`, then `test(db): cover the r13 migration and update the expected head`. The first commit leaves `test_db.py` red until the second.

- [x] **T2 — Device-token middleware** `[CI]` **tests first**
  - **Satisfies:** FR-2 "Owner filtering" and "Device token cookie", OQ-1; design "Device token middleware".
  - **Files:** `backend/tests/test_owner.py`, then `backend/app/owner.py` (middleware plus `get_owner_id` dependency).
  - **Test:** build a small app in the test with the middleware and a throwaway route under `/api/v1/projects/` that can raise `HTTPException`.
    - No cookie: `Set-Cookie` carries a valid UUID with `HttpOnly`, `SameSite=lax`, `Path=/`, `Max-Age=31536000`.
    - Valid cookie: reused, no new `Set-Cookie`.
    - Malformed cookie: a new cookie is issued.
    - `Secure` is present only when `X-Forwarded-Proto: https` is sent.
    - `Set-Cookie` is present on responses built from `HTTPException` with 404, 409, 413, 422, and 429.
    - Paths outside `/api/v1/projects` get no cookie.
    - An unhandled exception is **not** asserted to carry a cookie. Starlette builds that 500 outside user middleware (see the note in design.md).
  - **Commits:** `test(api): device token middleware`, then `feat(api): device token middleware`.

- [x] **T3 — Envelope models and validators** `[CI]`
  - **Satisfies:** FR-1.6, NFR-3.3; design "Pydantic envelope models + NOT NULL validation".
  - **Files:** `backend/app/models.py`, `backend/tests/test_models.py`, `backend/tests/fixtures/project.json` (one shared fixture, generated once from the frontend's `linear-story` fixture and committed; the provenance goes in a one-line comment in the test).
  - **Test:**
    - The fixture validates.
    - Missing or empty `campaign.title` or `campaign.genre`, and a non-array `story_sequence`, are rejected.
    - A missing or non-array `completed_stories`, or one with non-string items, is rejected in both `ProjectCreate.campaign_state` and `CampaignStateUpdate`.
    - `campaign_state: None` and `id: None` are accepted.
    - `campaign`, `stories`, `campaign_state`, and `materials` round-trip as equal dicts, so nothing is truncated or reordered.
  - **Commits:** `feat(api): project envelope models`, then `test(api): project envelope models`.

- [x] **T4 — Rate limiter** `[CI]` **tests first**
  - **Satisfies:** FR-7.2; design "Rate limiting".
  - **Files:** `backend/tests/test_ratelimit.py`, then `backend/app/ratelimit.py`.
  - **Test** (injected monotonic and wall clocks):
    - The 120th request in 60 s passes and the 121st is refused. The window frees up after 60 s.
    - **A first call on a fresh key records a timestamp.** This is the regression test for the inert draft that deleted the key and returned early.
    - Owner-write (60/min) and import (5/min) buckets are independent of the per-IP bucket.
    - **The sweep shrinks the dicts:** create many keys, advance the clock past the window, make enough calls to reach `SWEEP_EVERY`, and assert the key count dropped.
    - The sweep also runs when the key count exceeds `SWEEP_KEYS`.
    - Daily quota: the 101st create in one UTC day is refused. Moving the wall clock past UTC midnight resets it. The sweep removes entries from earlier days.
    - Several threads calling at once never admit more than the limit.
  - **Commits:** `test(api): rate limiter behaviour`, then `feat(api): in-memory rate limiter`.

- [x] **T5 — Router skeleton and wiring** `[CI]`
  - **Satisfies:** FR-2 (routing, owner dependency), FR-7.2 (limit order); design "FastAPI router".
  - **Files:** `backend/app/projects.py` (router, engine dependency, limiter dependencies), `backend/app/main.py` (register the middleware, include the router, keep one `RateLimiter` on `app.state` so tests can inject clocks), `backend/tests/test_projects_wiring.py`.
  - **Behavior:** the client address is `request.client.host`. Do not parse `X-Forwarded-For` in application code. Limit order is per-IP, then per-owner (or import), then the daily quota. A refused limit returns `429` with `Retry-After: 60`.
  - **Test:** without a configured DB every route returns `503`. A fake limiter shows the order of checks and the `429` plus `Retry-After`. The existing `/health*` and `/api/v1/health` tests stay green.
  - **Commits:** `feat(api): projects router skeleton and rate-limit wiring`, then `test(api): projects router wiring`.

- [x] **T6 — Ownership and isolation tests** `[PG]` **tests first**
  - **Satisfies:** FR-2 "Owner filtering", endpoints 2–6, AC 11, review items on cross-owner access and id collisions.
  - **Files:** `backend/tests/test_projects_ownership.py`. These tests are red until T7–T10.
  - **Test** (two clients with different cookies, A and B):
    - `GET /projects` lists only the caller's projects.
    - `GET`, `DELETE`, and `PUT /state` on A's id as B return 404, with a body identical to the 404 for an id that does not exist.
    - `DELETE` as B leaves A's project intact.
    - `PUT /state` as B writes nothing. A's state and `updated_at` are unchanged, and B gets 404 even when the payload carries a stale `updated_at` that would have given A a 409 (no probing through 409).
    - `POST /projects` as B with A's id returns 409. A's project, stories, and state are unchanged, and the body reveals nothing about the owner.
    - `POST /import` as B containing A's id counts it as `skipped` and changes nothing.
    - A row with `owner_id IS NULL` is invisible to everyone, and a create with its id returns 409.
  - **Commit:** `test(api): owner isolation and ownership-first behaviour`.

- [x] **T7 — List, get, delete** `[PG]`
  - **Satisfies:** FR-2 endpoints 1, 3, 4; NFR-2.1; design "Get", "Delete".
  - **Files:** `backend/app/projects.py`, `backend/tests/test_projects.py` (CRUD portion).
  - **Test:** list order is `updated_at` descending. The list query selects only summary columns (capture SQL with a SQLAlchemy event listener and assert `campaign` and `blueprint` are absent). `GET` assembles `stories` from `project_stories` and returns `campaign_state` as stored. `DELETE` cascades. T6 cases for these three endpoints turn green.
  - **Commits:** `feat(api): list, get and delete projects`, then `test(api): list, get and delete projects`.

- [x] **T8 — Create** `[PG]`
  - **Satisfies:** FR-2 endpoint 2, FR-1.6; design "Create / import: id collision handling".
  - **Files:** `backend/app/projects.py`, `backend/tests/test_projects.py`.
  - **Behavior:** one transaction runs the project upsert (`ON CONFLICT (id) DO UPDATE ... WHERE owner_id = EXCLUDED.owner_id AND updated_at < EXCLUDED.updated_at`), the story replacement, and, when `campaign_state` is present, the `project_state` upsert. `stories_completed` is derived from the stored state afterwards. A foreign id gives 409. (Revised 20 Nov 2026: `<` instead of `<=`, and `stories_completed` from the stored state instead of the request.)
  - **Test:**
    - create then get round-trips every opaque field, including nested and non-ASCII values.
    - A create with `campaign_state` is returned by get, and `stories_completed` appears in the list.
    - A generated `id` and timestamps appear when omitted.
    - A non-UUID id such as `p_lk2j_ab12cd` is accepted.
    - A missing `campaign.title` gives 422, not 500.
    - Re-posting the same id as the same owner with an older `updated_at` changes nothing.
    - **Atomicity:** force the story insert to fail and assert the project row was rolled back.
  - **Commits:** `feat(api): create project`, then `test(api): create project`.

- [x] **T9 — Save state** `[PG]`
  - **Satisfies:** FR-2 endpoint 5, FR-4.2, review items on ownership-first and atomic conflict detection; design "Put state".
  - **Files:** `backend/app/projects.py`, `backend/tests/test_projects.py`.
  - **Behavior:** check ownership first (404). Then run a single `INSERT ... ON CONFLICT (project_id) DO UPDATE ... WHERE project_state.updated_at <= EXCLUDED.updated_at` and read the row count. A row count of 1 updates `projects.stories_completed` and `updated_at` in the same transaction. A row count of 0 returns 409 with `stored_updated_at` and leaves `projects` untouched.
  - **Test:** the first save creates the row. Equal `updated_at` is accepted. A stale one gives 409 with the stored value and writes nothing. A missing or non-array `completed_stories` gives 422. **Race:** two requests with different `updated_at` sent from two connections end with the newer state stored, whichever arrives first.
  - **Commits:** `feat(api): save campaign state with atomic conflict check`, then `test(api): save campaign state`.

- [x] **T10 — Import** `[PG]`
  - **Satisfies:** FR-2 endpoint 6, FR-5.3, AC 5; design "Create / import".
  - **Files:** `backend/app/projects.py`, `backend/tests/test_projects.py`.
  - **Test:**
    - **Progress is preserved:** import a project that has a `campaign_state` and non-empty `completed_stories`, then `GET` it and assert `campaign_state` and `stories_completed` are intact.
    - A second identical import is a no-op.
    - An older copy never overwrites a newer stored one. A newer copy replaces an older one.
    - Foreign ids are skipped and counted.
    - `imported` and `skipped` counts are correct for a mixed batch.
    - The behavior for an invalid item is the one chosen in "Open details", item 2.
  - **Commits:** `feat(api): import projects with campaign state`, then `test(api): import projects`.

- [x] **T11 — Size limits, storage caps, daily quota** `[PG]`
  - **Satisfies:** FR-7.1, FR-7.3, AC 10; design "Body size limits", "Storage caps".
  - **Files:** `backend/app/projects.py` (body-cap dependency, cap queries), `backend/tests/test_projects_limits.py`. Limits are constants on a small settings object, overridable in tests.
  - **Test:**
    - `413` for `POST /projects` above 2 MB, `PUT /state` above 500 KB, and `POST /import` above 5 MB. Each is checked once with a `Content-Length` header and once with a chunked body (a generator body in the test client), so a missing header cannot bypass the cap.
    - Use the numbers from T0 if they changed.
    - The 101st project for one owner gives 422.
    - The per-owner size cap gives 422 (lowered cap in the test).
    - The global cap gives 422 (lowered cap in the test).
    - The daily creation quota is enforced end to end through the router with the fake clock.
  - **Commits:** `feat(api): request size limits and storage caps`, then `test(api): request size limits and storage caps`.

## Phase 2 — Caddy (PR 2)

- [x] **T12 — `request_body` limit on `/api/v1/*`** `[CI]` for validation, `[DEPLOYED]` for the effect
  - **Satisfies:** FR-7.1 (coarse limit that also covers chunked uploads); design "Body size limits".
  - **Files:** `deploy/web/Caddyfile` (add `request_body { max_size 5MB }` inside `handle /api/v1/*` only).
  - **Important:** `infra/compute.tf` embeds the Caddyfile in the web instance's `user_data` (`filebase64`), and `infra.yml` triggers on `deploy/**`. This change **replaces the web instance**: a few minutes of downtime, an `infra.yml` plan comment, and the `production` approval. No `terraform apply` or AWS change happens without an explicit instruction from the user. No instance size, IOPS, or retention changes, so the cost guardrails are unaffected.
  - **Test:** the `Validate Caddyfile` step in `ci.yml` (`[CI]`) plus `docker run --rm -v ...:/etc/caddy/Caddyfile:ro caddy:2.11.9-alpine caddy validate` locally (`[LOCAL]`). The behavioral check on a real Caddy is D4.
  - **Commit:** `feat(infra): cap request body size on /api/v1`.

## Phase 3 — Frontend (PR 3; flag stays `idb`)

- [x] **F1 — Repository interface and shared model module** `[CI]`
  - **Satisfies:** FR-3.1, FR-3.4; design "ProjectRepository interface".
  - **Files:** `frontend/src/lib/state/repository.ts` (interface), `frontend/src/lib/state/project-model.ts` (move `Project`, `ProjectSummary`, `StoreResult`, `ProjectSchema`, `SummarySchema`, `readProject`, `summarize`, `newId` here so `HttpRepository` can reuse them without a circular import). `project-store.ts` re-exports them so no importer changes. `createProject` takes an optional `id`. `saveCampaignState` takes an optional `updatedAt`, so the local and server copies carry the same timestamp (the design's snippet calls `Date.now()` twice, which makes the local copy a few milliseconds newer than the server's).
  - **Test:** `npx tsc --noEmit` and the full existing suite, unchanged.
  - **Commit:** `refactor(state): extract the project model and repository interface`.

- [x] **F2 — Extract `IndexedDbRepository`** `[CI]`
  - **Satisfies:** FR-3.2, AC 2; design "IndexedDbRepository".
  - **Files:** `frontend/src/lib/state/indexed-db-repository.ts` (existing IndexedDB logic, localStorage migration, `storeReady`), `frontend/src/lib/state/project-store.ts` (the five functions delegate to it; `projectStories` and `resetProjectStoreForTests` stay exported).
  - **Test:** a pure refactor. Run the full frontend suite before and after: all 854 tests pass, and `git diff --stat -- frontend/tests` is empty for this commit, so no existing test was edited. New tests go in a separate commit, `frontend/tests/state/indexed-db-repository.test.ts`: an explicit `id` is honored, an explicit `updatedAt` is stored.
  - **Commits:** `refactor(state): move IndexedDB persistence into IndexedDbRepository`, then `test(state): IndexedDbRepository id and timestamp options`.

- [x] **F3 — `HttpRepository`** `[CI]`
  - **Satisfies:** FR-3.2, FR-3.5, FR-4, FR-6; design "HttpRepository".
  - **Files:** `frontend/src/lib/state/http-repository.ts`, `frontend/tests/state/http-repository.test.ts`.
  - **Behavior:** nothing runs at construction (no `fetch`, no IndexedDB), because the module is evaluated during server rendering too. Every response is validated with the Zod schemas from F1.
  - **Test** (mocked `fetch`, `fake-indexeddb`, fake timers):
    - List merges server and local-only projects.
    - Load falls back to local on 404, on a non-OK response, and on a network error.
    - Create writes locally first, returns `ok` on a network error, and **deletes the local copy on 409**.
    - Rapid saves produce one PUT after 1500 ms.
    - Saves are sent in order, never in parallel.
    - A server or network error keeps the pending state and retries with doubling delay up to 60 s.
    - A 429 waits for `Retry-After`.
    - 409 and 404 clear the pending state and call the error callback.
    - An invalid `campaign_state` in a server response is dropped, and the project is still returned.
    - Delete removes the local copy first.
  - **Commits:** `feat(state): HttpRepository`, then `test(state): HttpRepository`.

- [x] **F4 — `syncCheck`** `[CI]`
  - **Satisfies:** FR-5; design "Sync check".
  - **Files:** `frontend/src/lib/state/sync.ts`, `frontend/tests/state/sync.test.ts`.
  - **Behavior:** one run at a time (a module-level in-flight promise, so repeated effects under `cacheComponents` cannot overlap). Unsynced projects are batched **by serialized size, at most 4 MB per request**, never one request per project, so the 5 requests per minute import limit is not hit. A `429` stops the run until the next load. Items in the import response's `rejected` list (invalid, or over a storage cap) are not retried within the run.
  - **Test:** a project missing on the server is imported with its `campaign_state` in the body. Several small projects go in one request, and projects totalling more than 4 MB split into several. A newer local copy triggers one PUT. A newer or equal server copy triggers nothing. An empty IndexedDB makes no request. Offline does nothing and does not throw. **Cleared cookies:** an empty server list re-imports everything. Concurrent calls share one run.
  - **Commits:** `feat(state): sync local projects to the server`, then `test(state): sync local projects to the server`.

- [x] **F5 — Repository selection behind `NEXT_PUBLIC_PROJECT_STORE`** `[CI]`
  - **Satisfies:** FR-3.3, FR-3.4; design "project-store.ts delegation".
  - **Files:** `frontend/src/lib/state/project-store.ts` (`selectRepository`, delegates, `setupSaveErrorHandler`), `frontend/src/lib/state/http-repository.ts` (triggers `syncCheck` once per page load from the first `listProjects` or `loadProject`, so no component has to), `frontend/tests/state/project-store-http.test.ts`.
  - **Behavior:** read the variable as the literal `process.env.NEXT_PUBLIC_PROJECT_STORE` so Next can inline it at build time. The default is `idb`. `setupSaveErrorHandler` is a no-op in `idb` mode.
  - **Test:** the existing `project-store.test.ts` is untouched. The new file uses `vi.stubEnv("NEXT_PUBLIC_PROJECT_STORE", "http")`, `vi.resetModules()`, then a dynamic `import()`, and asserts the five functions reach `fetch`. A second case asserts `idb` is chosen when the variable is unset or has any other value.
  - **Commits:** `feat(state): select the project repository by build flag`, then `test(state): project store in http mode`.

- [x] **F6 — `PlayProject` save-error wiring** `[CI]`
  - **Satisfies:** FR-6.1, AC 6; design "PlayProject.tsx (minimal change)".
  - **Files:** `frontend/src/components/play/PlayProject.tsx` (import `setupSaveErrorHandler`, one `useEffect` that registers `setSaveError` and unregisters on cleanup so a late error cannot update an unmounted component), `frontend/tests/state/play-save-error.test.tsx` (`@vitest-environment jsdom`).
  - **Test:** in http mode a server save error shows the existing `play-save-error` banner, and a later success clears it. `create/page.tsx` and `SavedStories.tsx` are not modified. `tests/state/play-and-home.test.tsx` stays green.
  - **Commits:** `feat(state): show server save errors on the play page`, then `test(state): server save errors on the play page`.

- [x] **F7 — Build flag plumbing, default `idb`** `[CI]`
  - **Satisfies:** NFR-1.2; design "Deployment sequence".
  - **Files:** `frontend/Dockerfile` (`ARG NEXT_PUBLIC_PROJECT_STORE=idb` and `ENV` in the build stage, before `npm run build`, next to the existing `AI_PROVIDER` pattern), `frontend/.env.example`.
  - **Test:** the `docker` job in `ci.yml` builds the default image. Confirm the build still succeeds and the default stays `idb`. `release-web.yml` is **not** changed here (that is D5).
  - **Commit:** `feat(web): add the project store build argument, default idb`.

- [x] **F8 — Contract test against the shared fixture** `[CI]`
  - **Satisfies:** NFR-3.7, AC 4.
  - **Files:** `frontend/tests/state/project-contract.test.ts`.
  - **Test:** read `backend/tests/fixtures/project.json` and assert that `ProjectSchema` and `CampaignStateSchema` accept it. The backend's T3 test already asserts the same file passes the envelope models, so a change on either side that breaks the shared shape fails a test.
  - **Commit:** `test(state): shared project fixture contract`.

## Phase 4 — Documentation and deployment

- [x] **D1 — Update the docs** `[CI]`
  - **Satisfies:** the docs-vs-code rule in `product` steering; the `docs/infra` documents are in Indonesian, so these edits are too.
  - **Files:** `docs/infra/04-database.md` section 7 (text ids, `bigint` timestamps, state written on create and import), `docs/infra/06-app-changes.md` section 4 (final endpoint table with 404, 409, 413, 422, and 429, the device cookie, the limits), `docs/infra/open-questions.md` (Q4 and Q5 decisions), `docs/infra/10-implementation-roadmap.md` (R13 status and PR plan), and the `persistence`, `backend`, and `product` steering files once the code has landed.
  - **Commit:** `docs(infra): document the r13 persistence design and decisions`.

- [ ] **D2 — Backend release** `[DEPLOYED]`
  - **Satisfies:** NFR-1.1 (API first); `docs/infra/04-database.md` section 6.
  - **Steps:** merge PR 1. `ci/api` runs `alembic upgrade head` and `pytest -v` against the Postgres service container. `release-api.yml` builds and deploys through SSM, and `deploy.sh` runs the one-shot `migrate` service first. Afterwards confirm the revision with `alembic current` on the api instance through SSM.
  - **Ask first:** a manual RDS snapshot before this first business migration (`lore-prod-db-premigrate-<date>`, as the database doc describes). It is additive and low risk, but it changes AWS resources, so it needs the user's go-ahead.
  - **Rollback:** redeploy the previous `sha-` image. The tables stay and the old code ignores them.

- [ ] **D3 — API smoke test** `[DEPLOYED]`
  - **Satisfies:** AC 1, AC 11; the "smoke test" step of the deployment sequence.
  - **Files:** `scripts/verify/r13-smoke.sh` (read-only except for the project it creates, which it deletes at the end; `shellcheck` runs on `scripts/verify/*.sh` in CI).
  - **Steps against `$APP_URL`, with two cookie jars A and B:** A creates a project (201, `Set-Cookie`, no `Secure` over HTTP). A gets it (200). B gets it (404). A saves state (200). A saves a stale state (409). B saves state (404). B deletes it (404). A deletes it (204).
  - **Commit:** `test(infra): r13 api smoke script`.

- [ ] **D4 — Caddy behavior checks** `[DEPLOYED]`, after T12 is applied
  - **Satisfies:** FR-7.1, FR-7.2; the design's X-Forwarded-For trust model, which says Caddy overwrites the header and promises a test for what happens if it does not.
  - **Checks (record the results in the PR):**
    1. A chunked body above 5 MB to `/api/v1/projects` is refused with 413 by Caddy (no `Content-Length`, for example `curl -H 'Transfer-Encoding: chunked' --data-binary @6mb.bin`). A body under the FastAPI limit but over 5 MB is not accepted.
    2. **Forged `X-Forwarded-For`:** send about 125 requests, each with a different forged `X-Forwarded-For`. The 429 must still appear at about the 121st request. If it does not, forged addresses create fresh buckets and the client-address handling must be fixed before cutover.
    3. A forged `X-Forwarded-Proto: https` sent over HTTP must not add `Secure` to the cookie.
    4. `uvicorn --forwarded-allow-ips=10.20.0.0/24` is accepted by the pinned uvicorn (the api container is healthy), since CIDR support was marked unverified in `docs/infra/06-app-changes.md`.
    5. Material upload through the Next route `/api/ai/*` is unaffected by the new limit.
  - **Note:** check 2 uses up this IP's per-minute budget for a minute. That is expected.

- [ ] **D5 — Cutover: build the web image in `http` mode** `[CI]` to merge, `[DEPLOYED]` in effect
  - **Satisfies:** NFR-1.1, NFR-1.2; design "Deployment sequence".
  - **Preconditions:** Gate A (D2–D4 done) and Gate B (PR 3 merged). Note the `sha-` tag of the current web image: it is the rollback target, because that image was built in `idb` mode.
  - **Files:** `.github/workflows/release-web.yml` (add `build-args: NEXT_PUBLIC_PROJECT_STORE=http` to the `docker/build-push-action` step).
  - **Warning:** merging to `main` triggers `release-web.yml`, whose `deploy` job targets `production-release` without a reviewer. **Merging this PR is the production switch.**
  - **Test:** `actionlint` locally on the workflow `[LOCAL]`, and a local `docker build --build-arg NEXT_PUBLIC_PROJECT_STORE=http frontend` followed by a run `[LOCAL]` that exercises the home page against a running API.
  - **Commit:** `ci(release): build the web image in http project store mode`.

- [ ] **D6 — Post-cutover verification and rollback rehearsal** `[DEPLOYED]`
  - **Satisfies:** AC 3, 5, 8, 9; design "Verification" and "Rollback".
  - **Checks, in a browser that already holds IndexedDB projects:**
    1. Opening the home page sends `POST /api/v1/projects/import`, and the story resumes at the same point (progress preserved).
    2. During a play session, `PUT .../state` requests are no more frequent than one per 1.5 s.
    3. Offline mode shows the save-error banner, and progress syncs after reconnecting.
    4. Clearing cookies only: the next load re-imports the local projects under a new owner. A second browser profile does not see the first profile's projects.
    5. Rehearse the rollback: run `release-web.yml` through `workflow_dispatch` with the pre-cutover tag and confirm `idb` mode works.
  - **Record:** the outcome in `docs/infra/10-implementation-roadmap.md` (R13 status) and the PR.

---

## Open details to settle before the task that needs them

1. **T8, idempotent create.** `POST /projects` with an id the caller already owns, and an older `updated_at`: the design says "skip" but not the response. Proposed: `200` with the stored project (and `201` only for a new row). **Decided (user, 20 Nov 2026): as proposed.** A same-owner re-post that replaces the row also returns `200`.
2. **T10, one invalid item in an import batch.** The design validates the whole `ImportRequest`, so one bad project returns 422 for the batch and blocks every other project in it, on every load. Proposed: validate each item on its own, skip invalid ones, and return them in a `rejected` list next to `imported` and `skipped`. This changes `ImportRequest` in design.md and FR-2 endpoint 6. **Decided (user, 20 Nov 2026): as proposed.** design.md and FR-2 endpoint 6 were updated in the T10 code commit.
3. **F3, write-through on server reads.** Design.md does not say whether `loadProject` and `listProjects` copy server data into IndexedDB. Proposed: no (YAGNI), with the consequence that a rollback to `idb` mode hides projects that exist only on the server. The data stays on the server and is not lost.
4. **PR 1 size.** T1–T11 is one large backend PR. It can be split after T4 (foundation: migration, owner, models, limiter) and T11 (router) if review load is a concern.
