# Handoff: ui-redesign (Black Cat Gold)

Dibaca oleh developer atau agent Kiro yang melanjutkan spec ini. Sumber kebenaran tetap `requirements.md`, `design.md`, `tasks.md`, dan `deviations.md` di folder ini.

## Status (22 Nov 2026)

- Branch kerja: `feat/redesign-black-cat-gold`, sudah digabung ke `dev`.
- Selesai: task 0 sampai 9 dan task 19.
  - Kit terpasang, Stage desktop dan phone, Preparation desktop dan phone, Home (opsi B).
  - Layar tanpa frame canvas: Generating, ChatLog (Modal), AdvancedOptions, CampaignLobby.
  - Tokoh AI memakai cast kit (backend).
- Belum: task 10 sampai 18.
  - 10 CampaignPlayer, 11 CampaignSummary, 12 EndingDisplay, 13 StoryComplete, 14 StoryFailure, 15 StoryViewer overlay dan dialog keluar, 16 PlayProject, 17 mode dua karakter, 18 penutup (hapus gaya lama, ganti steering).
- Layar yang belum dikerjakan masih bergaya lama (glass, rounded, kartu). Perilaku game tidak terganggu.

## Cara melanjutkan dengan Kiro

1. Buka spec `ui-redesign`, jalankan "Run all tasks". Mulai dari `10.1`.
2. Gerbang persetujuan rancangan 6.1 sampai 6.12 sudah disetujui user sekaligus. Jangan tanya ulang. Rancangan ada di `design.md` bagian 6.
3. Aturan kerja tiap task: sebut bagian DESIGN-SYSTEM dan file canvas, jalankan lint, `tsc --noEmit`, vitest, dan build, golden test harus 40 dari 40, lalu tulis Ringkasan_Penyimpangan di `deviations.md`.
4. Jangan commit atau push tanpa diminta pemilik repo.

## Menjalankan lokal

- `cd frontend && npm ci && npm run dev`. Backend: `cd backend`, isi `.env` (`GOOGLE_API_KEY`, jangan di-commit), `uvicorn app.main:app --port 8000`.
- Restart uvicorn setelah mengubah backend. Server lama masih mengirim tokoh lama.
- Project lama di IndexedDB masih memakai nama tokoh lama. Buat project baru untuk menguji.
- Verifikasi frontend: `npm run lint`, `npx next typegen`, `npx tsc --noEmit`, `npx vitest run --testTimeout=60000`, `npm run build`. Backend: `ruff check .`, `ruff format --check .`, `pytest -q` (597+ lulus, 57 skip tanpa Postgres).
- Screenshot memakai Playwright. Pasang sendiri di luar repo (`playwright-core` dan Chrome terpasang).

## Keputusan user yang berlaku

- Home: opsi B (Hazel menyapa). Kotak CHAPTERS: lima digambar, hanya 3 (short) dan 5 (medium) aktif.
- Pilihan jawaban di phone: sampai 4 (R8.4 dan R8.8 diamandemen).
- Zod tetap 3 (`^3.25.28`). `fast-check` ditambahkan.
- Labu animasi di background dipertahankan di semua layar: `PumpkinBackdrop` dan `lib/ascii-field` tidak dihapus di task 18. `body` transparan, jadi permukaan layar baru harus transparan.
- LessonVisual: geometri tetap, warna mengikuti token. "Beat tanpa canvas" berarti scene `ambient`.
- Grilling dan estimasi kredit tidak dibangun. `SceneBlueprint` kit belum dipasang (pekerjaan lanjutan).
- Tokoh AI memakai cast kit: lihat Requirement 16 dan "Dua tokoh dulu" di bawah.

## Hal yang perlu diketahui

- Hanya Eldric (pemandu) dan Mira (teman) yang berbicara di cerita. Story engine (`story_generator_engine.py`) memakai `characters[0]` dan `[1]`. Hazel, Varr, dan Nyx ada di kampanye tetapi belum pernah berbicara. Mengubah ini mengubah struktur dialog dan snapshot parity story.
- Gemini bisa mengabaikan aturan nama di prompt. Tidak ada validator yang menolak nama lain, sengaja, supaya teks kreatif tidak menggagalkan cerita.
- Demo `/game` (`frontend/src/data/dummy-campaign.ts`) masih memakai "Lyra" dan "Apprentice Keeper".
- `StoryViewer.tsx` menampilkan id mentah (`char_02`) kalau pembicara tidak ada di kampanye. Tidak terjangkau dari backend sekarang.
- Penyimpangan yang melanggar teks spec awal (user sudah setuju):
  - `lib/ingest/index.ts`: `detectFileKind` memakai `Object.hasOwn` (bug MIME seperti `valueOf`), padahal R13.1 melarang perubahan `lib/ingest`.
  - Backend diubah untuk cast kit (`campaign_templates.py`, `campaign_planner_engine.py`, `campaign_planner.py`, prompts, `validation/planner.py`, fixture dan tes). Kontrak `contracts` tidak berubah (0 baris diff).
- Snapshot `backend/tests/fixtures/ai/story-parity.snapshot.json` diregenerasi hanya pada bidang prompt karena prompt cerita berubah.
- Folder `lore-design-kit/` (sumber kit) tidak ikut di-commit. Task 18 menanyakan apakah dihapus. `reference/` dan `docs/DESIGN-SYSTEM.md` adalah salinan kit yang dipakai.

## Aturan gaya (ringkas, rinci di AGENTS.md dan docs/DESIGN-SYSTEM.md)

Token Tailwind kit saja, tanpa `rounded`, `blur`, bayangan, gradient, emoji, atau kartu. Semua ASCII lewat generator `lib/ascii` dan `AsciiArt`. Target sentuh minimal 44 px.