---
inclusion: fileMatch
fileMatchPattern: ["backend/**"]
---

# Backend (FastAPI)

- Python 3.12, FastAPI, SQLAlchemy 2.1, psycopg 3, Alembic, Ruff, Pytest. Perintah dari `backend/`: `ruff check . && ruff format --check .`, `alembic upgrade head`, `pytest -q` (CI).
- Gaya Python: ruff `E,F,I,B,UP`, `line-length = 100`. Tiap modul diawali docstring tujuan dan alasan, dan memakai `from __future__ import annotations`. Skrip CLI memakai `def main() -> int` dan `raise SystemExit(main())`.
- Endpoint probe (health) mengirim `Cache-Control: no-store` (`app/main.py`).
- Migrasi Alembic ditulis tangan (`target_metadata = None`), dan satu-satunya revisi yang ada (`4ee36ac0a0f8`) kosong: jangan diedit. Migrasi dijalankan otomatis saat deploy (`deploy/common/deploy.sh`), jadi harus expand-only dan backward-compatible.
- Skeleton: `app/main.py` dan `app/db.py`, migrasi Alembic `4ee36ac0a0f8`.
- Endpoint: `GET /health` (liveness), `GET /health/db` (readiness `SELECT 1`), `GET /api/v1/health` (health publik lewat Caddy).
- Env: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` (default `require`), `DB_POOL_SIZE` (default 5), `DB_MAX_OVERFLOW` (default 5, maks 10 koneksi per proses), `DB_CONNECT_TIMEOUT` (default 5), `AI_*`, `GOOGLE_API_KEY`.
- Test butuh Postgres 16 (CI memakai service container `postgres:16-alpine`; DB `lore`, user `lore_test`).
- Fitur v2 (pipeline AI Python/LangGraph, SSE, persistensi bisnis R13) belum dipindah dari Next.js. Pipeline AI masih di `frontend/src/app/api/ai/*`.
