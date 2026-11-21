---
inclusion: always
---

# Stack, perintah, env, test

- **Frontend (`frontend/`):** Next 16.4.5 (App Router, `cacheComponents`, `reactCompiler`, Turbopack dengan loader Tailwind), React 19.3, TypeScript strict, Tailwind 4, Zod 3, `@remotion/player` 4.0.543, pdfjs-dist, mammoth, jszip, lucide-react. Runtime Node 26 (`.nvmrc`).
  - Test: Vitest 3, Testing Library, jsdom, fake-indexeddb.
  - Alias `@/*` → `src/*` (di dalam `frontend/`).
  - Perintah (jalankan dari `frontend/`): `npm run dev | build | lint | test | test:watch | test:coverage`.
  - Next 16 punya breaking changes: baca `node_modules/next/dist/docs/` (resolve dari root repo; lihat `AGENTS.md`) sebelum menulis kode Next.
  - `frontend/node_modules` tidak selalu ada di mesin lokal (kadang hanya `node_modules` di root). Jalankan `npm ci` di `frontend/` sebelum lint, tsc, atau vitest.
  - Urutan check CI web (dari `.github/workflows/ci.yml`): `npm run lint`, `npx next typegen`, `npx tsc --noEmit`, `npx vitest run --testTimeout=60000`, `npm run build` dengan `AI_PROVIDER=google` (tanpa key; build tidak memanggil AI).
- **Backend (`backend/`):** Python 3.12, FastAPI 0.163.2, Uvicorn 0.54.0, SQLAlchemy 2.1.9, psycopg[binary] 3.3.9, Alembic 1.20.1, Ruff 0.17.5, Pytest 9.2.0.
  - Perintah (jalankan dari `backend/`): `ruff check . && ruff format --check .`, `alembic upgrade head`, `pytest -q` (yang dipakai CI; `-v` boleh untuk lokal).
  - Ruff: `line-length = 100`, aturan `E,F,I,B,UP` (`backend/pyproject.toml`).
- **Env frontend (`frontend/.env.example`):**
  - `AI_PROVIDER=google` (satu-satunya provider; tidak ada provider offline/dummy di runtime);
  - `GOOGLE_API_KEY` (atau `GEMINI_API_KEY`); tanpa key, semua layer mengembalikan `PROVIDER_NOT_CONFIGURED` dan UI menampilkan peringatan;
  - `AI_MODEL`: daftar model dipisah koma, dicoba berurutan;
  - `AI_TIMEOUT_MS=300000` per request (5 menit, default di `gemini-client.ts`);
  - `AI_DEADLINE_MS=300000` total per langkah AI (5 menit, default di `gemini-client.ts`).
- **Env backend:** variabel terpisah `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` (default `require`), `DB_POOL_SIZE` (default 5), `DB_MAX_OVERFLOW` (default 5, maks 10 koneksi per proses), `DB_CONNECT_TIMEOUT` (default 5), `AI_*`, `GOOGLE_API_KEY`.
- Jangan pernah menaruh API key atau password di kode atau di steering ini. Pakai `.env`.

## Test
- **Frontend:** sekitar 65 file `*.test.ts(x)` di `frontend/tests/` (hitungan statis 20 Nov 2026; jumlah test persis, sebelumnya dicatat 854, hanya bisa dipastikan dengan menjalankan vitest). Dikelompokkan per domain: ai, story, schemas, ingest, validation, campaign, knowledge, setup, stage, game, generation, state, api health. Fixture di `frontend/tests/fixtures/`.
- Environment default `node`. File yang butuh DOM memakai docblock `@vitest-environment jsdom`.
- `frontend/tests/setup.ts` memuat jest-dom dan `fake-indexeddb/auto`, menambah polyfill `Blob.text/arrayBuffer`, dan memperbaiki localStorage di Node 25.
- **Backend:** 2 file di `backend/tests/` (11 test: `test_health.py`, `test_db.py`), diuji dengan service container `postgres:16-alpine` di CI (`alembic upgrade head` + `pytest`).
- **Infra checkers:** `scripts/ci/test-checkers.py` (`6` unit test) + `check-cost-static`.
- Status (19 Nov 2026): lint (`web` 0 error / 6 pre-existing warnings, `api` ruff clean), `tsc --noEmit`, `npm run build`, Vitest (`npx vitest run --testTimeout=60000`, 854 passed), Pytest (11 passed), dan Terraform validate semuanya hijau di CI.