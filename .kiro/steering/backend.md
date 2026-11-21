---
inclusion: fileMatch
fileMatchPattern: ["backend/**"]
---

# Backend (FastAPI)

- Python 3.12, FastAPI, SQLAlchemy 2.1, psycopg 3, Alembic, Ruff, Pytest. Perintah dari `backend/`: `ruff check . && ruff format --check .`, `alembic upgrade head`, `pytest -q` (CI).
- Gaya Python: ruff `E,F,I,B,UP`, `line-length = 100`. Tiap modul diawali docstring tujuan dan alasan, dan memakai `from __future__ import annotations`. Skrip CLI memakai `def main() -> int` dan `raise SystemExit(main())`.
- Endpoint probe (health) mengirim `Cache-Control: no-store` (`app/main.py`).
- Migrasi Alembic ditulis tangan (`target_metadata = None`). Revisi yang ada: `4ee36ac0a0f8` (kosong) dan `7c1d9e4a52b8` (tabel project R13); jangan edit revisi yang sudah ada, tambah revisi baru. Migrasi dijalankan otomatis saat deploy (`deploy/common/deploy.sh`, service `migrate`), jadi harus expand-only dan backward-compatible.
- Modul: `app/main.py` (factory, middleware, router), `app/db.py`, `app/owner.py` (cookie `lore_device`), `app/models.py` (envelope Pydantic), `app/ratelimit.py`, `app/projects.py` (router dan batas). Detail di steering `persistence`.
- Endpoint: `GET /health` (liveness), `GET /health/db` (readiness `SELECT 1`), `GET /api/v1/health` (health publik lewat Caddy), dan `/api/v1/projects` (list, create, get, delete, `PUT /{id}/state`, `POST /import`).
- Env: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` (default `require`; Postgres lokal tanpa TLS butuh `disable`), `DB_POOL_SIZE` (default 5), `DB_MAX_OVERFLOW` (default 5, maks 10 koneksi per proses), `DB_CONNECT_TIMEOUT` (default 5), `AI_*`, `GOOGLE_API_KEY`.
- Test butuh Postgres 16 (CI memakai service container `postgres:16-alpine`; DB `lore`, user `lore_test`). Test DB di-skip tanpa `PGHOST`. Fixture DB bersama ada di `tests/conftest.py`; `tests/fixtures/project.json` juga dipakai contract test frontend.
- Jalankan lint dengan `ruff check . --no-cache` sebelum commit: cache ruff pernah menyembunyikan urutan import yang salah.
- Fitur v2 (pipeline AI Python/LangGraph, SSE) belum dipindah dari Next.js. Pipeline AI masih di `frontend/src/app/api/ai/*`.
