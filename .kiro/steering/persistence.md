---
inclusion: fileMatch
fileMatchPattern: ["frontend/src/lib/state/**", "frontend/src/components/home/**", "backend/app/db.py", "backend/alembic/**"]
---

# Persistensi

## Browser (kondisi sekarang)
- IndexedDB `lore` v1 (`src/lib/state/idb.ts`) punya store `projects` dan `summaries`, yang selalu ditulis dalam satu transaksi.
- `project-store.ts`:
  - data divalidasi Zod saat dibaca;
  - `campaign_state` yang tidak valid dibuang, tapi story-nya tetap;
  - data lama di localStorage (`lore:projects`, `lore:project:*`) dimigrasi otomatis;
  - semua fungsi async, aman untuk SSR, dan tidak throw (mengembalikan `{ok:false,message}`).
- localStorage dipakai untuk `lore:pacing`.

## Backend (R13, belum dipindah)
Persistensi bisnis ke FastAPI + RDS PostgreSQL 16 + Alembic direncanakan di R13. Skeleton sudah ada (`backend/app/db.py`, migrasi Alembic `4ee36ac0a0f8`, `/health/db`). Rencana migrasi aplikasi: `docs/infra/06-app-changes.md`.
