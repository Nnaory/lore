---
inclusion: always
---

# LORE: apa ini dan kondisi kode

Dipecah dari `lore-overview.md` (diperbarui 19 Nov 2026 mengikuti penyelesaian fondasi infrastruktur R1–R12 di `infra/setup` -> `main`).

## Apa ini
Web app "interactive learning visual novel". Pengguna memberi materi (PDF/DOCX/PPTX/TXT/MD atau teks tempel), lalu AI mengekstrak konsep, merencanakan campaign, dan menulis story. Story dimainkan di stage 3 panel: karakter SVG, kanvas Remotion, dan chat box. Saat ini data pemain masih disimpan di browser (IndexedDB), sementara skeleton `backend/` FastAPI + RDS PostgreSQL 16 + Alembic sudah aktif untuk migrasi persistensi di R13.

## Dokumen vs kode
`README.md`, `docs/DOCS.md`, dan `docs/DESIGN.md` menjelaskan rencana **v2**, sedangkan `docs/infra/` mendokumentasikan arsitektur AWS + CI/CD yang sudah diimplementasikan (R1–R12). Kondisi kode sekarang:
- Aplikasi Next.js berada di `frontend/` (dipindah dari root repo), sedangkan `backend/` berisi skeleton FastAPI (`app/main.py`, `app/db.py`, Alembic `4ee36ac0a0f8`) dengan `/health`, `/health/db`, dan `/api/v1/health`.
- Fitur v2 seperti AI pipeline Python/LangGraph, SSE, AI grilling, credit simulation, route `/stage`, `/api/chat/in-character`, dan persistensi DB bisnis (R13) belum dipindah dari Next.js.
- Pipeline AI masih berjalan di route handler Next.js (`frontend/src/app/api/ai/*`, Gemini atau dummy).
- Input `type something` sudah ada, tapi disabled ("coming soon").
- Puzzle belum berupa primitive Remotion interaktif (`pause_for_interaction_at_frame` tidak ada). Puzzle saat ini adalah pilihan ganda: tombol HTML di atas komposisi `DecisionGraph`.
- Yang sudah ada: stage 3 panel, toggle `fast | animate`, `log chat`, Remotion player, serta infra Terraform + GitHub Actions CI/CD di `infra/`, `deploy/`, dan `.github/workflows/`.

Jadikan kode sumber kebenaran. Docs desain v2 adalah visi.

## Peta steering
Selalu dimuat: `product`, `tech`, `structure`, `conventions`. Steering lain dimuat otomatis saat file terkait dibuka (`fileMatch`): `ai-pipeline`, `game-engine`, `persistence`, `theme-halloween`, `backend`, `infra`. Catatan isu lama ada di `known-issues` (manual, panggil dengan `#known-issues`).
