---
inclusion: always
---

# LORE: apa ini dan kondisi kode

Dipecah dari `lore-overview.md` (diperbarui 19 Nov 2026 mengikuti penyelesaian fondasi infrastruktur R1–R12 di `infra/setup` -> `main`; R13 diperbarui 21 Nov 2026; fitur animasi Remotion buatan AI (R14) ditambahkan sebagai kode yang belum dirilis dan belum dinyalakan).

## Apa ini
Web app "interactive learning visual novel". Pengguna memberi materi berupa file (PDF/DOCX/PPTX/TXT/MD; file wajib, teks yang diketik hanya menjadi instruksi tambahan, bukan materi), lalu AI mengekstrak konsep, merencanakan campaign, dan menulis story. Story dimainkan di stage 3 panel: karakter SVG, kanvas Remotion, dan chat box. Data pemain disimpan di browser (IndexedDB). Backend persistensi R13 (FastAPI + RDS PostgreSQL 16, `/api/v1/projects`) sudah di-deploy, tetapi web production masih di mode `idb` sampai cutover `http` (task D5).

## Dokumen vs kode
`README.md`, `docs/DOCS.md`, dan `docs/DESIGN.md` menjelaskan rencana **v2**, sedangkan `docs/infra/` mendokumentasikan arsitektur AWS + CI/CD yang sudah diimplementasikan (R1–R13) dan fitur animasi R14 (`12-remotion-animation.md`, kode sudah ada, belum dirilis). Kondisi kode sekarang:
- Aplikasi Next.js berada di `frontend/` (dipindah dari root repo) dan tidak memuat kode server selain liveness `GET /api/health`. `backend/` berisi FastAPI (`app/main.py`, `app/db.py`, modul R13 `owner.py`, `models.py`, `ratelimit.py`, `projects.py`, pipeline AI `app/ai/`, dan fitur animasi `app/ai/animation/`; Alembic `4ee36ac0a0f8`, `7c1d9e4a52b8`, dan `725515cc1581`) dengan `/health`, `/health/db`, `/health/ai`, `/api/v1/health`, `/api/v1/projects`, `/api/v1/ai/*` (termasuk `POST /api/v1/ai/animations`), dan Reader `GET /api/v1/animations/{animation_id}`.
- Persistensi project punya dua implementasi di belakang `project-store.ts` (IndexedDB dan HTTP), dipilih oleh flag build `NEXT_PUBLIC_PROJECT_STORE`. Lihat steering `persistence`.
- LangGraph dan SSE **sudah ada**, tetapi hanya untuk fitur animasi (`backend/app/ai/animation/`: agent LangGraph `generate → verify → repair → publish`, stream SSE). Pipeline JSON `/api/v1/ai/{analyze-material,plan-campaign,generate-story}` tetap request/response biasa. Fitur v2 lain seperti AI grilling, credit simulation, route `/stage`, dan `/api/chat/in-character` belum ada.
- **Animasi Remotion buatan AI (R14): kode ada, fitur mati.** AI menulis satu berkas `main.ts` per langkah pelajaran atau puzzle; Verifier_Lambda (`animation-verifier/`, tanpa egress) memeriksanya dalam tujuh langkah; yang lolos disimpan di S3 privat dan dijalankan di iframe bersandbox di kanvas Stage (`frontend/sandbox-runtime/`). Jalur lama (`visual` JSON) tetap menjadi Fallback_Scene untuk setiap kegagalan. **Flag_Api `ANIMATION_ENABLED` = `false` dan Flag_Web `NEXT_PUBLIC_ANIMATIONS` = `off`** (default dan kondisi production). Dengan keduanya mati perilaku production tidak berubah, api tidak mengimpor `langgraph` atau `boto3`, dan web tidak memanggil `/api/v1/animations`. Belum dirilis: butuh bootstrap IAM admin, tiga PR infra, rilis image verifier, lockfile dan paket `@fontsource/*` (dikerjakan operator online), serta bukti browser, memori, dan biaya sebelum flag dinyalakan. Urutan dan syaratnya: `docs/infra/12-remotion-animation.md`; sisa risiko: steering `known-issues`.
- Pipeline AI (hanya Gemini) berjalan di backend `backend/app/ai/` (`/api/v1/ai/*`), port 1:1 dari route Next.js lama. Tanpa key proses berhenti dengan peringatan, tidak ada konsep palsu. Kode Next.js lama tersimpan di branch `backup/dev-before-fe-ai-removal`. Rilis production dengan key di SSM belum dilakukan (lihat `docs/infra/11-ai-backend-migration.md`).
- Input `type something` sudah ada, tapi disabled ("coming soon").
- Puzzle berupa pilihan ganda dengan kontrol `ChoiceButton` di bawah kanvas Remotion (`PuzzleBoard` bila AI mengirim `puzzle.visual`, atau `DecisionGraph` bila tidak; dengan Flag_Web `on` dan referensi `puzzle.animation`, animasi sandbox menggantikannya dan `PuzzleBoard` atau `DecisionGraph` menjadi fallback). `StagePuzzle` tidak dipakai UI.
- Yang sudah ada: stage penuh layar (`StageHud`, `StageScene`, `CanvasPane`, `StageSprite`, `StageDialogue`), toggle `fast | animate`, `log chat`, Remotion player, serta infra Terraform + GitHub Actions CI/CD di `infra/`, `deploy/`, dan `.github/workflows/` (termasuk `infra/animation.tf` dan `release-verifier.yml` untuk R14).

Jadikan kode sumber kebenaran. Docs desain v2 adalah visi.

## Peta steering
Selalu dimuat: `product`, `tech`, `structure`, `conventions`. Steering lain dimuat otomatis saat file terkait dibuka (`fileMatch`): `ai-pipeline`, `game-engine`, `persistence`, `theme-halloween`, `backend`, `infra`. Pembaruan fitur animasi ada di `ai-pipeline` (endpoint, alur, verifier), `backend`, `infra`, `persistence`, `game-engine` (Animation_Scene), `tech`, `structure`, dan `conventions`. Catatan isu lama dan sisa risiko animasi ada di `known-issues` (manual, panggil dengan `#known-issues`).
