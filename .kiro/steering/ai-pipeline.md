---
inclusion: fileMatch
fileMatchPattern: ["frontend/src/lib/ai/**", "frontend/src/app/api/**", "frontend/src/lib/generation/**", "frontend/src/lib/ingest/**", "frontend/src/lib/setup/**", "frontend/src/lib/types/**", "frontend/src/lib/validation/**"]
---

# Route, alur data, dan generasi AI

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
