# Fixes after review (20 Nov 2026, decisions by the user)

- Commits: `fix(api): keep progress counts, timestamps and import counts consistent` (code plus design.md, requirements.md FR-2 endpoints 2, 5, 6 and FR-7.3, tasks.md T8 and F4); `test(api): progress counts, timestamps and import counts stay consistent`.

1. **`stories_completed` follows the stored state** (decision: my proposal). The upsert no longer copies it from the request; after the state step, `stories_completed` is recomputed from `project_state`. A re-post without `campaign_state` keeps the count, and the count can never disagree with the stored progress.
2. **`projects.updated_at` only moves forward** (my proposal, approved): PUT state sets `GREATEST(updated_at, :client)`. Reason: the column orders the list and feeds the frontend sync check (F4); moving it backwards could make an older local copy look newer. The PUT response still returns the state's own `updated_at`.
3. **Import counts and caps**:
   - The project upsert uses `<` instead of `<=`: an equal `updated_at` is the same version, not rewritten, counted as `skipped` (create returns 200 with the stored project). A repeated import is now a true no-op.
   - A storage cap on import no longer stops the request with 422. The item goes into `rejected` with the cap message and the rest of the batch continues, so an update of an existing own project still lands. Create still answers 422. F4's text now says "rejected items are not retried within the run".
- Verification: the 6 new or changed tests fail on the code before the fix (checked by running them against `f339ac0`) and pass after it.
- Gate: ruff clean; pytest 108 passed with Postgres 16.
