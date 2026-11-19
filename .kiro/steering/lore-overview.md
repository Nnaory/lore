# LORE: catatan repo untuk agent

Diperbarui 19 Nov 2026 mengikuti penyelesaian fondasi infrastruktur R1–R12 di `infra/setup` -> `main`. Poin bertanda **(belum dicek)** berasal dari laporan sub-agent sebelumnya dan belum diverifikasi ulang.

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

## Stack, perintah, env
- **Frontend (`frontend/`):** Next 16.4.5 (App Router, `cacheComponents`, `reactCompiler`, Turbopack dengan loader Tailwind), React 19.3, TypeScript strict, Tailwind 4, Zod 3, `@remotion/player` 4.0.543, pdfjs-dist, mammoth, jszip, lucide-react. Runtime Node 26 (`.nvmrc`).
  - Test: Vitest 3, Testing Library, jsdom, fake-indexeddb.
  - Alias `@/*` → `src/*` (di dalam `frontend/`).
  - Perintah (jalankan dari `frontend/`): `npm run dev | build | lint | test | test:watch | test:coverage`.
- **Backend (`backend/`):** Python 3.12, FastAPI 0.163.2, Uvicorn 0.54.0, SQLAlchemy 2.1.9, psycopg[binary] 3.3.9, Alembic 1.20.1, Ruff 0.17.5, Pytest 9.2.0.
  - Perintah (jalankan dari `backend/`): `ruff check . && ruff format --check .`, `alembic upgrade head`, `pytest -v`.
- **Env frontend (`frontend/.env.example`):**
  - `AI_PROVIDER=dummy|google`;
  - `GOOGLE_API_KEY` (atau `GEMINI_API_KEY`); tanpa key, provider jatuh ke dummy;
  - `AI_MODEL`: daftar model dipisah koma, dicoba berurutan;
  - `AI_TIMEOUT_MS=300000` per request (5 menit, default di `gemini-client.ts`);
  - `AI_DEADLINE_MS=300000` total per langkah AI (5 menit, default di `gemini-client.ts`).
- **Env backend:** variabel terpisah `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` (default `require`), `DB_POOL_SIZE` (default 5), `DB_MAX_OVERFLOW` (default 5, maks 10 koneksi per proses), `AI_*`, `GOOGLE_API_KEY`.

## Route
| Route | Lokasi | Isi |
|---|---|---|
| `/` | `frontend/src/app/page.tsx` | Judul LORE di atas satu field chat (`HomeComposer`: teks tempel, atau satu file lewat ikon klip di kanan; kirim membuka `/create`), link demo `/game`, dan `SavedStories` (daftar dari IndexedDB). |
| `/create` | `frontend/src/app/create/page.tsx` | Form materi, lalu GenerationScreen bertahap, simpan, buka `/play/[id]`. Materi dari home masuk lewat `lib/setup/pending-material.ts`. |
| `/game` | `frontend/src/app/game/page.tsx` | Demo "The Last Beacon" dari `frontend/src/data/dummy-campaign.ts` |
| `/play/[projectId]` | `frontend/src/components/play/PlayProject.tsx` | Load project dari IndexedDB, simpan `campaign_state` tiap berubah. |
| `GET /api/health` | `frontend/src/app/api/health/route.ts` | Liveness runtime Next.js (`200 {"status":"ok"}`, `Cache-Control: no-store`). |
| `POST /api/ai/analyze-material` | `frontend/src/app/api/ai/` (Layer 1) | Dipakai UI |
| `POST /api/ai/plan-campaign` | `frontend/src/app/api/ai/` (Layer 2) | Dipakai UI |
| `POST /api/ai/generate-story` | `frontend/src/app/api/ai/` (Layer 3) | Dipakai UI |
| `POST /api/ai/full-workflow` | `frontend/src/app/api/ai/` | Ketiga layer sekaligus (dipakai test) |
| `GET /health`, `GET /health/db`, `GET /api/v1/health` | `backend/app/main.py` | Liveness backend (`/health`), readiness Postgres `SELECT 1` (`/health/db`), dan health publik lewat Caddy (`/api/v1/health`). |

## Alur data per layer
0. **Ingest** (`src/lib/ingest`, jalan di browser): file menjadi `ExtractedDocument`, dengan satu section per halaman, slide, atau heading.
   - Library format di-`import()` hanya saat dibutuhkan.
   - Batas (`limits.ts`): file 25 MB, materi 10 sampai 80.000 karakter.
   - `.doc` dan `.ppt` ditolak dengan kode `LEGACY_FORMAT`.
   - `buildMaterialText` menggabungkan section terpilih menjadi `[source_ref] title\ntext`.
1. **Material Intelligence** menghasilkan `MaterialBlueprint`: daftar concept (definition, principles, methods, prerequisites, misconceptions, source_evidence, dan opsional notation/examples) plus scope_limitations.
2. **Campaign Planner** menghasilkan `CampaignBlueprint`: genre, characters dengan peta ekspresi kaomoji, world_rules, dan `story_sequence` (tiap entri punya `required_knowledge` dan outcomes).
3. **Story Generator** menghasilkan `StoryBlueprint`: chapters berisi scenes, puzzles, endings, continuity_summary, knowledge_mapping.

Tipe ada di `src/lib/types/*`. Schema Zod padanannya ada di `src/lib/ai/schemas/*`.

Bentuk data penting:
- **Scene** adalah discriminated union:
  - `narrative | learning | interaction | consequence` punya `content[]`, berisi narration, dialogue, atau learning_info (dengan `visual?` opsional);
  - `puzzle` punya `puzzle_id` dan `on_incorrect_scene_id` (peta pilihan salah ke scene bad branch);
  - `ending` punya `ending_id`.
- **`LessonVisual`** (`types/visual.ts`): `vectors | plot | diagram | table | formula`. Berupa JSON yang digambar Remotion, jadi label dan angka selalu persis seperti yang ditulis.
- **Puzzle**: hanya pilihan ganda (`correct_choice_id`, `retry_allowed`).

## Generasi (client dan server)
**Client** (`src/lib/generation/{generation.ts,use-generation.ts}`), berjalan bertahap:
1. analyzing;
2. reviewing: pemain membuang konsep yang tidak perlu. `selectConcepts` juga membuang prerequisite yang menunjuk ke konsep yang dibuang;
3. planning;
4. writing: story ditulis satu per satu, dan continuity summary diteruskan ke story berikutnya;
5. done.

Catatan client:
- Retry melanjutkan dari tahap yang gagal.
- Generasi hanya dimulai dari klik, bukan dari effect, supaya double effect React di mode dev tidak mengirim request dua kali.
- `buildWorkflowRequest` (`src/lib/setup/create-form.ts`) memakai `conceptsPerChapter: 1`, jadi satu konsep = satu chapter.
- Opsi form: short = 3 chapter, medium = 5 chapter; bahasa `en | id`; custom instructions maksimal 500 karakter.

**Server** (`src/lib/ai`):
- Registry provider per layer ada di `providers/index.ts` (di-cache).
- Pola service: provider → output parser → validasi Zod dan semantik → envelope `{ok}`. Service tidak pernah throw.
- Provider hanya menulis konten. Struktur (ID, rantai scene, knowledge mapping) dan validasi dikerjakan aplikasi (lihat komentar di `story-generator-types.ts`).
- Envelope route: `{ok:true,data:{blueprint,meta}}` atau `{ok:false,error:{code,message,detail}}`.
- Status HTTP:

| Status | Kode error |
|---|---|
| 400 | `INVALID_REQUEST` |
| 422 | Error semantik |
| 502 | `OUTPUT_PARSE_FAILED`, `VALIDATION_FAILED` |
| 503 | `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `TIMEOUT` |
| 500 | Lainnya |

- Client memvalidasi ulang respons dengan Zod. Pesan untuk pengguna berasal dari `messageForCode` (`src/lib/setup/request-campaign.ts`).

**Belum dibaca detail:** `campaign-planner-engine.ts`, `story-generator-engine.ts`, `story-generator-service.ts`, `providers/gemini-*.ts`, `prompts/material-analysis.ts`, dan `src/lib/validation/*`. Menurut git log, tiap konsep diajarkan dalam 2 sampai 4 lesson step yang dibatasi ke cakupan materi. Gemini juga diminta membuat satu ilustrasi per konsep, dan ilustrasi yang tidak valid dibuang.

## Game engine (`src/lib/game`, fungsi murni tanpa React)
- **`hp-manager.ts`**: `MAX_HP = 5`. Jawaban salah mengurangi 1. HP 0 berarti gagal.
- **`answer-validator.ts`**: `validateMultipleChoice` mengembalikan `correct | incorrect | empty | unknown_choice`. Ini satu-satunya penentu benar atau salah. AI tidak pernah memutuskan.
- **`knowledge-manager.ts`**: status `not_introduced < introduced < developing < demonstrated`, dan hanya bisa naik.
  - `demonstrated` hanya diberikan jika jawaban benar tanpa bukti puzzle sebelumnya di SEMUA run. Bukti disimpan di CampaignState, bukan counter per run.
  - Bukti dideduplikasi per `(reference_id, source)`.
  - Nilai source: `learning_scene`, `puzzle_correct_first_try`, `puzzle_correct_after_feedback`, `puzzle_incorrect`.
- **`campaign-manager.ts`**: story terbuka jika semua story sebelumnya selesai DAN semua `required_knowledge` sudah `demonstrated`. `completeStory` menerapkan delta world dan relationship dari ending, dan aman dipanggil dua kali.
- **`learning-summary.ts`**: evaluasi akhir dengan kategori mastered / developing / practice / unseen.

## Runtime story
- **`src/lib/story/story-player.ts`** (murni): status `reading | scene_end | puzzle | bad_branch | story_complete`. `returnToPuzzleSceneId` dibawa sepanjang bad branch.
- **`use-story-player.ts`**: state React plus HP. `retryStory` me-reset posisi dan HP; knowledge tetap.
- **`src/lib/campaign/use-campaign.ts`**: CampaignState, lobby, `onKnowledgeUpdate`.
- **`CampaignPlayer`** merender `CampaignSummary`, `CampaignLobby`, atau `StoryViewer`. `StoryViewer` di-key dengan `story_id` supaya remount tiap ganti story.
- **`StoryViewer`** adalah stage 3 panel:
  - `StageNavbar`;
  - `StageCharacter`: SVG berlapis. Emosi diturunkan dari kata kunci ekspresi lewat `emotion.ts`, aksesori dipilih per genre;
  - `StageCanvas`: Remotion Player 1280×720 @30fps dengan komposisi `ambient` (loop 300 frame), `lesson`, `visual`, `decision`. Mode `fast` langsung membuka frame terakhir. Player hanya di-mount di client;
  - `StagePuzzle`: maksimal 4 pilihan, berupa tombol HTML di atas `DecisionGraph`;
  - `ChatBox`: efek typewriter, toggle `fast|animate`, tombol `log chat` yang membuka `ChatLog`.
- Ending "baik" adalah scene ending pertama di story. Ending bad branch ditaruh setelahnya.
- Fitur avatar pemain (kartu di home, `src/lib/avatar`, `src/lib/ascii`, figur di `AmbientScene`/`DecisionGraph`) dihapus 17 Nov 2026. Key `lore:avatar` yang mungkin tersisa di localStorage pengguna lama tidak dibaca lagi.

## Persistensi (browser)
- IndexedDB `lore` v1 (`src/lib/state/idb.ts`) punya store `projects` dan `summaries`, yang selalu ditulis dalam satu transaksi.
- `project-store.ts`:
  - data divalidasi Zod saat dibaca;
  - `campaign_state` yang tidak valid dibuang, tapi story-nya tetap;
  - data lama di localStorage (`lore:projects`, `lore:project:*`) dimigrasi otomatis;
  - semua fungsi async, aman untuk SSR, dan tidak throw (mengembalikan `{ok:false,message}`).
- localStorage dipakai untuk `lore:pacing`.

## Gotcha
- Dengan `cacheComponents`, halaman yang ditinggalkan tetap ter-mount secara tersembunyi (React `<Activity>`), lengkap dengan state-nya. `/create` punya effect khusus untuk me-reset form setelah story tersimpan. Hal yang sama berlaku untuk home: `HomeComposer` mengosongkan teks dan file saat kirim, supaya field bersih ketika pemain kembali.
- Remotion Player membaca jam saat render, jadi hanya di-mount setelah hydration (`useIsClient` di `StageCanvas`).

## Test
- **Frontend:** 64 file di `frontend/tests/` (854 test), dikelompokkan per domain: ai, story, schemas, ingest, validation, campaign, knowledge, setup, stage, api health.
- Environment default `node`. File yang butuh DOM memakai docblock `@vitest-environment jsdom`.
- `frontend/tests/setup.ts` memuat jest-dom dan `fake-indexeddb/auto`, menambah polyfill `Blob.text/arrayBuffer`, dan memperbaiki localStorage di Node 25.
- **Backend:** 2 file di `backend/tests/` (11 test: `test_health.py`, `test_db.py`), diuji dengan service container `postgres:16-alpine` di CI (`alembic upgrade head` + `pytest`).
- **Infra checkers:** `scripts/ci/test-checkers.py` (`6` unit test) + `check-cost-static`.
- Status (19 Nov 2026): lint (`web` 0 error / 6 pre-existing warnings, `api` ruff clean), `tsc --noEmit`, `npm run build`, Vitest (`npx vitest run --testTimeout=60000`, 854 passed), Pytest (11 passed), dan Terraform validate semuanya hijau di CI.

## Infra & CI/CD
- Infrastruktur AWS (`ap-southeast-3`) dikelola via `infra/` + `.github/workflows/{ci.yml,infra.yml,release-web.yml,release-api.yml}`: VPC `10.20.0.0/16`, NAT instance `t3.micro`, `web` (`t3.micro`, Caddy + Next.js), `api` (`t3.micro`, FastAPI private subnet), dan RDS PostgreSQL 16 (`db.t3.micro`, 20 GB `gp3`, `backup_retention_period = 1`).
- Deploy aplikasi memakai OIDC + AWS SSM (`scripts/ci/ssm-deploy.sh`, `/opt/lore/{render-env.sh,deploy.sh,compose.yml}`), GHCR publik (`ghcr.io/nnaory/lore-{web,api}:sha-*`). Dependabot sengaja tidak digunakan.

## Tema Halloween + liquid glass (seluruh app, sejak 17 Nov 2026)
- Tema hitam-emas sudah diganti di SEMUA halaman (`/`, `/create`, `/game`, `/play/*`). Token ada di `:root` `globals.css`; tidak ada lagi `.theme-halloween`, `.lore-bg`, `.lore-panel-bg`.
- Palet "Trick-or-Treat": `--hw-candy-apple` #C83E3E, `--hw-pumpkin` #F68928, `--hw-grape` #7443A8, `--hw-candy-corn` #F6C84E, `--hw-licorice` #222222. Token semantik lama dipertahankan agar tidak perlu mengubah ratusan pemakaian, tapi isinya baru: `--accent-gold` = Candy Corn Yellow (namanya basi), `--accent` = Bright Pumpkin.
- Kelas glass (resep dari referensi `~/Temporary/ascii-animals/page.css`): `lore-glass` (dasar), `lore-glass-composer` (kartu utama), `lore-glass-panel` (panel berisi teks/kontrol, tanpa refraksi), `lore-pill` (+ `-sm`, `-lg`, `-icon`, `-primary`, `-accent`, `-danger`), `lore-composer-input` (textarea di composer home; fokus ditandai glow kartu, bukan outline), `lore-tile`, `lore-well`, `lore-eyebrow`, `lore-hairline`, `lore-halo`.
- Radius mengikuti referensi, didaftarkan sebagai utilitas Tailwind: `rounded-pill` 999px (tombol), `rounded-card` 24px (kartu utama), `rounded-panel` 20px (panel), `rounded-tip` 12px (tile kecil di dalam panel).
- Pola halaman: halaman TIDAK mengecat latar sendiri. Konten ditaruh di panel `lore-glass lore-glass-panel rounded-card|panel`, tombol memakai `lore-pill`.
- Refraksi (Chromium saja): `app/layout.tsx` menaruh `<script>` inline di `<head>` yang menambah kelas `liquid` ke `<html>` sebelum paint (`suppressHydrationWarning` di `<html>`), dan `GlassFilter` merender filter SVG `#lore-liquid-glass`. `next/script` `beforeInteractive` TIDAK dipakai: di Next 16 ia baru jalan saat hydration.
- Latar ASCII: `src/lib/ascii-field/` adalah port engine ascii-animals (MIT, lihat `LICENSE` di folder itu), dengan spesies `pumpkins.ts`.
  - `PumpkinBackdrop` (`src/components/backdrop/`) dirender sekali oleh root layout. Layout tidak di-remount saat pindah halaman, jadi satu engine hidup selama tab terbuka dan tidak pernah restart. Tidak ada daftar route lagi: canvas selalu tampil.
  - Canvas `position: fixed`, `z-index: -1`, ukuran `100vw × 100lvh` (bukan `inset: 0`): ukuran itu tidak berubah saat scrollbar muncul atau address bar HP bergeser. Setiap perubahan ukuran mengosongkan canvas; inilah penyebab latar berkedip saat panel avatar dibuka (halaman jadi bisa di-scroll, lebar viewport berubah). Jangan kembalikan ke `inset: 0` / `100%`.
  - `AsciiRenderer.resize` tidak melakukan apa-apa kalau ukuran sama, dan resize yang nyata langsung menggambar ulang sebelum browser mem-paint (tanpa frame kosong).
  - Klik di "langit" mengagetkan labu: engine mendengarkan `pointerdown` di window dan memakai predikat `isSky` (target bukan `a, button, input, textarea, select, label, summary, [role=button], .lore-glass`). Halaman tidak perlu mengatur `pointer-events` atau z-index.
  - Biaya: di stage cerita (Remotion + panel glass + latar) headless tanpa GPU mengukur ~48 fps vs ~55 fps tanpa canvas latar; blur panel glass hampir tidak menambah beban main-thread, canvas latar yang menambah (~15 ms/frame di software rendering). Kalau stage terasa berat di mesin lemah, kurangi `detail`/`max` di `pumpkins.ts` atau jeda canvas di stage.
- Kanvas Remotion ikut palet baru (`GOLD`, `VOID`, ... di `compositions.tsx`, `TONE_COLORS` di `visual-layout.ts`); nama konstanta lama dipertahankan.
- Warna sukses hijau `#6fcf97` masih di-hardcode di beberapa komponen (bukan token).
- Layar overlay stage (ending + story complete) bisa lebih tinggi dari kanvas; karena `items-center` + `overflow-y-auto`, bagian atasnya terpotong dan tak bisa di-scroll (sudah ada sebelum rombak tema, belum diperbaiki).
- Hydration error di `/game` pada hard-load: `ChatBox` merender teks penuh di server tapi mulai dari 0 karakter di klien (pacing `animate`). Sudah ada sebelum rombak tema, belum diperbaiki.

## Konvensi
- Logika murni ada di `src/lib/*` (reducer dan fungsi), dengan hook React tipis di atasnya. Komponen tidak menghitung HP atau benar-salah sendiri.
- Hasil berupa union `{ ok: true, ... } | { ok: false, ... }`. Tidak ada throw di batas modul.
- Zod dipakai di setiap batas kepercayaan: request route, respons di client, dan data dari IndexedDB/localStorage.
- Styling memakai CSS variable semantik (`--background-panel`, `--accent-gold`, `--foreground-muted`, dan seterusnya) lewat `style` inline.
- `data-testid` dipasang di hampir semua elemen interaktif.
- Tiap file punya komentar header yang menjelaskan tujuan dan alasannya.
- Commit memakai Conventional Commits dengan scope (`feat(stage): …`, `fix(visual): …`, `test(ai): …`, `feat(infra): …`). Kode dan test masuk di commit terpisah.
- Branch utama: `main` (dilindungi ruleset `protection-main`: wajib PR dan check `ci/web`, `ci/api`, `ci/docker`, `ci/terraform`). Development infra berjalan di `infra/setup`.

## Isu dan kode lama
Sudah diverifikasi:
- `requestCampaign()` dan `/api/ai/full-workflow` tidak dipakai UI (rencana migrasi di `docs/infra/06-app-changes.md` juga tidak memindahkannya). Masih ada karena `runFullWorkflow` dan route-nya dipakai banyak test (`gemini.test.ts`, `tests/fixtures/route-fetch.ts`); skema request-nya (`full-workflow-schema.ts`) tetap dipakai client.
- Ada kode yang hanya dipanggil test, bukan app: `validateStory` (`validation/story-validator.ts`, tipe `ValidationError`-nya dipakai di mana-mana), `isStoryFailed`/`clampHp` (`hp-manager.ts`), `getNextStoryEntry` (`campaign-manager.ts`), dan `dummyMaterial2/3`, `dummyPlannerOptions`, `dummyStoryState` di `src/data/dummy-campaign.ts`.
- Pembersihan 17 Nov 2026 menghapus: `PuzzleInteraction.tsx` (testnya pindah ke `tests/stage/stage-puzzle.test.tsx`), state submit di `create-form.ts`, test debug tanpa `expect`, aset bawaan create-next-app di `public/`, CSS layout lama (`.navbar*`, `.sidebar-*`, `.hide-on-*`, `.mobile-full`, `.lore-hairline`, registrasi `--color-*` di `@theme`), dan export tanpa referensi (alias `*FromSchema`, `SceneType`, `LessonVisualKind`, `StoryGenerationContext`, `parseMaterialAnalysisResponse`, dll.).
- Label tombol berubah menjadi "Confirm choice →" hanya untuk pilihan salah yang punya bad branch. Di puzzle demo semua pilihan salah punya bad branch, jadi label "Submit Answer" membocorkan jawaban benar.

Belum dicek (dari sub-agent):
- `StoryFailure.tsx` meng-hardcode HP 5, bukan memakai `MAX_HP`.
- `EndingDisplay.tsx` menggabungkan paragraf `\n\n` menjadi satu.
- `--color-success` (#6fcf97) dari DESIGN.md tidak ada di `globals.css`. Warnanya di-hardcode di beberapa komponen.
- Jawaban salah yang sama bisa disubmit ulang dan memotong HP lagi. Label "Submitting…" tidak pernah tampil.
- Komentar header `dummy-campaign.ts` sudah basi. Test id masih memakai prefix lama `sidebar-`.
- GenrePicker hanya menawarkan fantasy, modern ("Non-fiction") dan science_fiction, padahal tipe `Genre` punya 8 nilai.
