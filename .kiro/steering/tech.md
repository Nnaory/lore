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
  - Urutan check CI web (dari `.github/workflows/ci.yml`): `npm run lint`, `npx next typegen`, `npx tsc --noEmit`, `npx vitest run --testTimeout=60000`, `npm run build` (tanpa env AI; web tidak memanggil AI).
- **Backend (`backend/`):** Python 3.12, FastAPI 0.163.2, Uvicorn 0.54.0, SQLAlchemy 2.1.9, psycopg[binary] 3.3.9, Alembic 1.20.1, httpx2 2.16.2, Ruff 0.17.5, Pytest 9.2.0.
  - Perintah (jalankan dari `backend/`): `ruff check . && ruff format --check .`, `alembic upgrade head`, `pytest -q` (yang dipakai CI; `-v` boleh untuk lokal).
  - Ruff: `line-length = 100`, aturan `E,F,I,B,UP` (`backend/pyproject.toml`).
- **Env frontend (`frontend/.env.example`):** hanya `NEXT_PUBLIC_PROJECT_STORE` (`idb` | `http`) dan opsional `LORE_API_ORIGIN` (target rewrite `/api/v1/*` saat `npm run dev`, default `http://localhost:8000`). Web tidak memegang key AI.
- **Env backend:** `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` (default `require`), `DB_POOL_SIZE` (default 5), `DB_MAX_OVERFLOW` (default 5, maks 10 koneksi per proses), `DB_CONNECT_TIMEOUT` (default 5), serta AI:
  - `AI_PROVIDER=google` (satu-satunya provider; tidak ada provider offline/dummy di runtime);
  - `GOOGLE_API_KEY` (atau `GEMINI_API_KEY`); tanpa key (atau placeholder `__SET_ME__`), endpoint AI mengembalikan `PROVIDER_NOT_CONFIGURED` dan UI menampilkan peringatan;
  - `AI_MODEL`: daftar model dipisah koma, dicoba berurutan (default `gemini-3.5-flash-lite`);
  - `AI_TIMEOUT_MS=300000` per request dan `AI_DEADLINE_MS=300000` total per langkah (default di `app/ai/settings.py`);
  - batas: `AI_RATE_PER_MINUTE_IP`, `AI_RATE_PER_MINUTE_OWNER`, `AI_DAILY_PER_IP`, `AI_MAX_CONCURRENT_PER_IP`, `AI_MAX_CONCURRENT_GLOBAL` (`app/ai/limits.py`).
- Jangan pernah menaruh API key atau password di kode atau di steering ini. Pakai `.env`.

## Test
- **Frontend:** 48 file `*.test.ts(x)` di `frontend/tests/` (618 test, 21 Nov 2026, dijalankan dengan Zod 3). Dikelompokkan per domain: contracts, story, schemas, ingest, campaign, knowledge, setup, stage, game, generation, state, api health. Fixture di `frontend/tests/fixtures/`; `backend-fetch.ts` melayani fixture AI backend.
- Environment default `node`. File yang butuh DOM memakai docblock `@vitest-environment jsdom`.
- `frontend/tests/setup.ts` memuat jest-dom dan `fake-indexeddb/auto`, menambah polyfill `Blob.text/arrayBuffer`, dan memperbaiki localStorage di Node 25.
- **Backend:** `backend/tests/` (595 passed + 57 skip tanpa Postgres, 21 Nov 2026). Test DB memakai service container `postgres:16-alpine` di CI (`alembic upgrade head` + `pytest`); test AI tidak butuh Postgres atau jaringan.
- **Infra checkers:** `scripts/ci/test-checkers.py` (`7` unit test) + `check-cost-static`.
- Status (21 Nov 2026, lokal): lint web 0 error / 0 warning, `tsc --noEmit`, `npm run build`, Vitest 618 passed, ruff clean, Pytest 595 passed. Terraform belum divalidasi lokal untuk perubahan AI (CI `ci/terraform`).