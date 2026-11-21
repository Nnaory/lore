---
inclusion: always
---

# LORE: apa ini dan kondisi kode

Dipecah dari `lore-overview.md` (diperbarui 19 Nov 2026 mengikuti penyelesaian fondasi infrastruktur R1–R12 di `infra/setup` -> `main`; R13 diperbarui 21 Nov 2026).

## Apa ini
Web app "interactive learning visual novel". Pengguna memberi materi berupa file (PDF/DOCX/PPTX/TXT/MD; file wajib, teks yang diketik hanya menjadi instruksi tambahan, bukan materi), lalu AI mengekstrak konsep, merencanakan campaign, dan menulis story. Story dimainkan di stage 3 panel: karakter SVG, kanvas Remotion, dan chat box. Data pemain disimpan di browser (IndexedDB). Backend persistensi R13 (FastAPI + RDS PostgreSQL 16, `/api/v1/projects`) sudah di-deploy, tetapi web production masih di mode `idb` sampai cutover `http` (task D5).

## Dokumen vs kode
`README.md`, `docs/DOCS.md`, dan `docs/DESIGN.md` menjelaskan rencana **v2**, sedangkan `docs/infra/` mendokumentasikan arsitektur AWS + CI/CD yang sudah diimplementasikan (R1–R13). Kondisi kode sekarang:
- Aplikasi Next.js berada di `frontend/` (dipindah dari root repo). `backend/` berisi FastAPI (`app/main.py`, `app/db.py`, dan modul R13 `owner.py`, `models.py`, `ratelimit.py`, `projects.py`; Alembic `4ee36ac0a0f8` dan `7c1d9e4a52b8`) dengan `/health`, `/health/db`, `/api/v1/health`, dan `/api/v1/projects`.
- Persistensi project punya dua implementasi di belakang `project-store.ts` (IndexedDB dan HTTP), dipilih oleh flag build `NEXT_PUBLIC_PROJECT_STORE`. Lihat steering `persistence`.
- Fitur v2 seperti AI pipeline Python/LangGraph, SSE, AI grilling, credit simulation, route `/stage`, dan `/api/chat/in-character` belum dipindah dari Next.js.
- Pipeline AI masih berjalan di route handler Next.js (`frontend/src/app/api/ai/*`, hanya Gemini; tanpa LLM yang bisa diakses proses berhenti dengan peringatan, tidak ada konsep palsu).
- Input `type something` sudah ada, tapi disabled ("coming soon").
- Puzzle belum berupa primitive Remotion interaktif (`pause_for_interaction_at_frame` tidak ada). Puzzle saat ini adalah pilihan ganda: tombol HTML di atas komposisi `DecisionGraph`.
- Yang sudah ada: stage 3 panel, toggle `fast | animate`, `log chat`, Remotion player, serta infra Terraform + GitHub Actions CI/CD di `infra/`, `deploy/`, dan `.github/workflows/`.

Jadikan kode sumber kebenaran. Docs desain v2 adalah visi.

## Peta steering
Selalu dimuat: `product`, `tech`, `structure`, `conventions`. Steering lain dimuat otomatis saat file terkait dibuka (`fileMatch`): `ai-pipeline`, `game-engine`, `persistence`, `theme-halloween`, `backend`, `infra`. Catatan isu lama ada di `known-issues` (manual, panggil dengan `#known-issues`).
