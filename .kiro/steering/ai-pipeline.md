---
inclusion: fileMatch
fileMatchPattern: ["backend/app/ai/**", "frontend/src/app/api/**", "frontend/src/lib/contracts/**", "frontend/src/lib/generation/**", "frontend/src/lib/ingest/**", "frontend/src/lib/setup/**", "frontend/src/lib/types/**"]
---

# Route, alur data, dan generasi AI

## Route
| Route | Lokasi | Isi |
|---|---|---|
| `/` | `frontend/src/app/page.tsx` | Judul LORE di atas satu field chat (`HomeComposer`: satu file materi wajib lewat ikon klip di kanan, teks yang diketik menjadi instruksi tambahan (maks 500 karakter) dan tanpa file muncul peringatan; kirim membuka `/create`), link demo `/game`, dan `SavedStories` (daftar dari IndexedDB). |
| `/create` | `frontend/src/app/create/page.tsx` | Form materi (hanya file, tidak ada tempel teks), lalu GenerationScreen bertahap, simpan, buka `/play/[id]`. File + instruksi dari home masuk lewat `lib/setup/pending-material.ts` (`{file, instructions}`). |
| `/game` | `frontend/src/app/game/page.tsx` | Demo "The Last Beacon" dari `frontend/src/data/dummy-campaign.ts` |
| `/play/[projectId]` | `frontend/src/components/play/PlayProject.tsx` | Load project dari IndexedDB, simpan `campaign_state` tiap berubah. |
| `GET /api/health` | `frontend/src/app/api/health/route.ts` | Liveness proses Next.js (`200 {"status":"ok"}`, `Cache-Control: no-store`). **Satu-satunya route handler di frontend.** |
| `POST /api/v1/ai/analyze-material` | `backend/app/ai/routes.py` (Layer 1) | Dipakai UI |
| `POST /api/v1/ai/plan-campaign` | `backend/app/ai/routes.py` (Layer 2) | Dipakai UI |
| `POST /api/v1/ai/generate-story` | `backend/app/ai/routes.py` (Layer 3) | Dipakai UI |
| `GET /health`, `GET /health/db`, `GET /health/ai`, `GET /api/v1/health` | `backend/app/main.py` | Liveness, readiness Postgres, status key Gemini (`{"configured": bool}`, tanpa memanggil Gemini), dan health publik lewat Caddy. |

Frontend tidak memuat kode server AI, key, maupun env `AI_*`. Browser memanggil `/api/v1/ai/*`. Di production Caddy meneruskannya ke API; di `npm run dev` rewrite di `next.config.ts` meneruskannya ke `LORE_API_ORIGIN` (default `http://localhost:8000`, `proxyTimeout` 330 s).

## Alur data per layer
0. **Ingest** (`frontend/src/lib/ingest`, jalan di browser): file menjadi `ExtractedDocument`, dengan satu section per halaman, slide, atau heading.
   - Library format di-`import()` hanya saat dibutuhkan.
   - Batas (`limits.ts`): file 25 MB, materi 10 sampai 80.000 karakter.
   - `.doc` dan `.ppt` ditolak dengan kode `LEGACY_FORMAT`.
   - `buildMaterialText` menggabungkan section terpilih menjadi `[source_ref] title\ntext`. Backend hanya menerima teks ini, bukan file.
1. **Material Intelligence** menghasilkan `MaterialBlueprint`: daftar concept (definition, principles, methods, prerequisites, misconceptions, source_evidence, dan opsional notation/examples) plus scope_limitations.
2. **Campaign Planner** menghasilkan `CampaignBlueprint`: genre, characters dengan peta ekspresi kaomoji, world_rules, dan `story_sequence` (tiap entri punya `required_knowledge` dan outcomes).
3. **Story Generator** menghasilkan `StoryBlueprint`: chapters berisi scenes, puzzles, endings, continuity_summary, knowledge_mapping.

Kontrak klien ada di `frontend/src/lib/contracts/`: skema Zod (`schemas/*`), skema request (`ai-requests.ts`), `GenerationRequest` (`generation-request.ts`), pesan galat (`error-messages.ts`, `messageForCode`), dan `stableHash` (`hash.ts`). Tipe di `frontend/src/lib/types/*`. Padanan Pydantic di `backend/app/ai/contracts/*`.

Bentuk data penting:
- **Scene** adalah discriminated union:
  - `narrative | learning | interaction | consequence` punya `content[]`, berisi narration, dialogue, atau learning_info (dengan `visual?` opsional);
  - `puzzle` punya `puzzle_id` dan `on_incorrect_scene_id` (peta pilihan salah ke scene bad branch);
  - `ending` punya `ending_id`.
- **`LessonVisual`** (`types/visual.ts`): `vectors | plot | diagram | table | formula`. Berupa JSON yang digambar Remotion, jadi label dan angka selalu persis seperti yang ditulis.
- **Puzzle**: hanya pilihan ganda (`correct_choice_id`, `retry_allowed`).

## Generasi
**Client** (`frontend/src/lib/generation/{generation.ts,use-generation.ts,ai-endpoints.ts}`), berjalan bertahap:
1. analyzing;
2. reviewing: pemain membuang konsep yang tidak perlu. `selectConcepts` juga membuang prerequisite yang menunjuk ke konsep yang dibuang;
3. planning;
4. writing: story ditulis satu per satu, dan continuity summary diteruskan ke story berikutnya;
5. done.

Catatan client:
- `aiUrl(step)` selalu `/api/v1/ai/<step>`. Cookie `lore_device` ikut otomatis (same-origin).
- Retry melanjutkan dari tahap yang gagal.
- Generasi hanya dimulai dari klik, bukan dari effect, supaya double effect React di mode dev tidak mengirim request dua kali.
- `buildWorkflowRequest` (`lib/setup/create-form.ts`) memakai `conceptsPerChapter: 1`, jadi satu konsep = satu chapter.
- Opsi form: short = 3 chapter, medium = 5 chapter; bahasa `en | id`; custom instructions maksimal 500 karakter.
- Client memvalidasi ulang respons dengan Zod (`postBlueprint`). Pesan untuk pengguna berasal dari `messageForCode`.

**Server** (`backend/app/ai/`):
- Per layer: model request Pydantic (`ZodModel`) + `async def run(model, ctx) -> AiOk | AiError` + `AiEndpoint(...)` di `routes.py`, dijalankan `pipeline.handle_ai_request` (baca body berbatas, validasi, limiter, concurrency, envelope).
- Klien Gemini `gemini_client.py` (async `httpx2`): model dicoba berurutan, 2 percobaan per model, deadline total. Key dari `GOOGLE_API_KEY`/`GEMINI_API_KEY` (spasi dibuang; placeholder `__SET_ME__` = belum diatur), tidak pernah masuk log atau respons.
- Provider hanya menulis konten. Struktur (ID, rantai scene, knowledge mapping) dan validasi (`validation/*`) dikerjakan aplikasi.
- Envelope: `{ok:true,data:{blueprint,meta}}` atau `{ok:false,error:{code,message,detail}}`. Status HTTP:

| Status | Kode error |
|---|---|
| 400 | `INVALID_REQUEST` (juga JSON rusak) |
| 413 | `INVALID_REQUEST` (body melebihi batas per endpoint) |
| 422 | Error semantik (`MATERIAL_ANALYSIS_FAILED`, `DUPLICATE_*`, `PREREQUISITE_CYCLE`, `STORY_NOT_IN_CAMPAIGN`, ...) |
| 429 | `RATE_LIMITED` dari limiter API, dengan `Retry-After` |
| 502 | `OUTPUT_PARSE_FAILED`, `VALIDATION_FAILED` |
| 503 | `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_CONFIGURED`, `RATE_LIMITED`/`TIMEOUT` dari Gemini |
| 500 | `UNKNOWN` |

- Batas (env, `limits.py`): `AI_RATE_PER_MINUTE_IP=12`, `AI_RATE_PER_MINUTE_OWNER=12`, `AI_DAILY_PER_IP=200`, `AI_MAX_CONCURRENT_PER_IP=2`, `AI_MAX_CONCURRENT_GLOBAL=8`. Limiter di memori proses.
- Tidak ada provider dummy di runtime. Tanpa key: `PROVIDER_NOT_CONFIGURED` (503), pesan UI "AI belum diatur". Analisis tanpa konsep atau tanpa `source_evidence`: `MATERIAL_ANALYSIS_FAILED` (422).

## Tes
- Backend: `backend/tests/test_ai_*.py` dengan `httpx2.MockTransport` (tanpa jaringan, tanpa Postgres), termasuk parity terhadap snapshot dari kode TS lama dan alur penuh analyze → plan → story.
- Kontrak bersama: fixture `backend/tests/fixtures/ai/*.json` dibaca pytest dan `frontend/tests/contracts/ai-contract.test.ts` (lewat `postBlueprint` asli). Tes klien memakai `frontend/tests/fixtures/backend-fetch.ts` yang melayani fixture yang sama.
- Smoke dengan Gemini asli: `scripts/verify/ai-smoke.py <base-url>` (server harus memegang key).
