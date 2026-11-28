---
inclusion: fileMatch
fileMatchPattern: ["backend/app/ai/**", "frontend/src/app/api/**", "frontend/src/lib/contracts/**", "frontend/src/lib/generation/**", "frontend/src/lib/ingest/**", "frontend/src/lib/setup/**", "frontend/src/lib/types/**", "frontend/src/lib/animation/**", "animation-verifier/**"]
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
| `POST /api/v1/ai/animations` | `backend/app/ai/routes.py` → `backend/app/ai/animation/endpoint.py` (`create_animation`) | Fitur animasi (R14). Dijawab sebagai stream SSE. Dipakai UI hanya bila Flag_Web `on` dan Flag_Api `true`. |
| `GET /api/v1/animations/{animation_id}` | `backend/app/ai/animation/endpoint.py` (`animations_router`, Reader) | URL presigned S3 300 detik untuk bundle milik Owner. Dipakai Stage saat memutar animasi. |
| `GET /health`, `GET /health/db`, `GET /health/ai`, `GET /api/v1/health` | `backend/app/main.py` | Liveness, readiness Postgres, status key Gemini dan fitur animasi (`{"configured": bool, "animation": {"enabled": bool, "configured": bool}}`, tanpa memanggil Gemini atau AWS), dan health publik lewat Caddy. |

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
- **`animation?`** (opsional) pada `learning_info` dan `puzzle`: `AnimationReference`, pointer kecil ke animasi (`animation_id`, `source_sha256`, `bundle_sha256`, `width`/`height`/`fps`, `duration_in_frames`, `pause_at_frame?`, `contract_version`), bukan kodenya. `learning_info.animation` tanpa `pause_at_frame`, `puzzle.animation` wajib punya. Nilai tidak valid dibuang tanpa menggagalkan blok (lenient, seperti `visual`), dan story lama tanpa `animation` tetap valid. `generate-story` tidak pernah mengeluarkannya: klien menempelkannya sesudah animasi jadi (`attachAnimation`).
- **Puzzle**: hanya pilihan ganda (`correct_choice_id`, `retry_allowed`). Boleh membawa `visual?` (salah satu dari lima primitif `LessonVisual`, dirancang AI sebagai gambar masalahnya, bagian yang ditanyakan ditandai `?`, tidak boleh membocorkan jawaban). Visual tidak valid dibuang tanpa menggagalkan puzzle, dan project lama tanpa `visual` tetap valid (field opsional di Zod dan Pydantic).

## Generasi
**Client** (`frontend/src/lib/generation/{generation.ts,use-generation.ts,ai-endpoints.ts}`), berjalan bertahap:
1. analyzing;
2. reviewing: pemain membuang konsep yang tidak perlu. `selectConcepts` juga membuang prerequisite yang menunjuk ke konsep yang dibuang;
3. planning;
4. writing: story ditulis satu per satu, dan continuity summary diteruskan ke story berikutnya;
5. animating (hanya bila Flag_Web `on` dan ada target; lihat "Animasi Remotion buatan AI"). Flag `off`: tahap ini tidak ada, `write()` langsung `all_stories_ready` lalu `onDone`;
6. done.

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
| 422 | Error semantik (`MATERIAL_ANALYSIS_FAILED`, `DUPLICATE_*`, `PREREQUISITE_CYCLE`, `STORY_NOT_IN_CAMPAIGN`, ...), serta `ANIMATION_QUOTA_EXCEEDED` dan `ANIMATION_VERIFICATION_FAILED` |
| 429 | `RATE_LIMITED` dari limiter API, dengan `Retry-After` |
| 502 | `OUTPUT_PARSE_FAILED`, `VALIDATION_FAILED` |
| 503 | `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_CONFIGURED`, `RATE_LIMITED`/`TIMEOUT` dari Gemini, serta `ANIMATION_NOT_CONFIGURED`, `ANIMATION_TIMEOUT`, `ANIMATION_VERIFIER_UNAVAILABLE`, `ANIMATION_STORAGE_FAILED` |
| 500 | `UNKNOWN` |

- **Batas panjang teks:** semua teks cerita tampil di kotak dialog yang muat 3 baris × 68 karakter, jadi `MAX_CHUNK_CHARS = 180` (`backend/app/ai/chunking.py`, kembar di `frontend/src/lib/dialogue/pagination.ts`, dijaga satu tes). System prompt dan prompt menyebut batas itu serta batas per field (lesson body 400, intro 360, ending 400, `narrative_context` 140, `question` 200, jawaban 80, `explanation` 180, `correct_feedback`/`incorrect_feedback` 140 karakter). `merge_story_content` memecah `narration`, `dialogue`, `learning_info.body`, serta `puzzle.narrative_context` yang melebihi `limit - 33` (memindahkan potongan awal ke narasi scene sebelumnya). Teks legacy/demo yang masih panjang dipaginasi frontend (`paginateText`).
- Batas (env, `limits.py`): `AI_RATE_PER_MINUTE_IP=12`, `AI_RATE_PER_MINUTE_OWNER=12`, `AI_DAILY_PER_IP=200`, `AI_MAX_CONCURRENT_PER_IP=2`, `AI_MAX_CONCURRENT_GLOBAL=8`. Limiter di memori proses.
- Tidak ada provider dummy di runtime. Tanpa key: `PROVIDER_NOT_CONFIGURED` (503), pesan UI "AI belum diatur". Analisis tanpa konsep atau tanpa `source_evidence`: `MATERIAL_ANALYSIS_FAILED` (422).

## Animasi Remotion buatan AI (R14)
Sumber: `.kiro/specs/ai-remotion-animation/`. Dokumen operasi: `docs/infra/12-remotion-animation.md`. **Default mati:** Flag_Api `ANIMATION_ENABLED=false` (api) dan Flag_Web `NEXT_PUBLIC_ANIMATIONS=off` (web). Fitur belum dirilis dan belum dinyalakan; jalur lama (`visual` JSON digambar Remotion) tetap menjadi Fallback_Scene.

**Alur.**
1. Setelah semua story ditulis dan Flag_Web `on`, tahap `animating` (`lib/generation/animating.ts`, `use-generation.ts`) memilih sampai 4 target (`lib/animation/targets.ts`: langkah pelajaran dulu, lalu puzzle yang punya `visual`) dan memanggil `POST /api/v1/ai/animations` per target lewat `createAnimation` (`lib/animation/animation-client.ts`, parser SSE `sse-parser.ts`). Jendela mulai 4 per 60 detik, batas klien per target 270 detik, tombol Skip dan Try again (`AnimationProgress`).
2. Server (`backend/app/ai/animation/endpoint.py`): `pipeline.entry_guard` bersama, lalu `ANIMATION_NOT_CONFIGURED`, `canonical_hash`, pencarian idempoten di registry (Idempotent_Hit: hanya `started` dan `done` dari baris), kuota 200 per Owner, slot serentak, kuota harian, lalu stream. Galat sebelum stream berupa envelope JSON non-200; sesudah stream mulai, galat berupa event `error`.
3. Agent (`agent.py`): graf LangGraph `generate` → `verify` → (`repair` → `verify`)* → `publish` atau `fail`, tanpa checkpointer. Paling banyak 4 panggilan Gemini (mode teks lewat `generate_text`, model dari `AI_ANIMATION_MODEL` → `AI_MODEL` → default), deadline 240 detik. Produksi wajib `run_agent(run, graph=build_graph())`; `run_agent(run)` tanpa graf hanyalah driver untuk tes.
4. Verifier_Lambda (`animation-verifier/`, Node 22, container image, tanpa egress dan tanpa secret) menjalankan tujuh langkah: `size`, `policy` (AST), `eslint`, `tsc`, `esbuild`, `render` (Worker, `vm`, jsdom), `fidelity` (token wajib dan terlarang). Hasil `{ok, diagnostics[], ...}`. Kode `VERIFIER_*` berarti verifier yang bermasalah dan menghentikan run (kecuali `VERIFIER_DEADLINE` dan `VERIFIER_CRASH`); kode lain dipakai untuk prompt `repair`.
5. Lolos: `store.py` menulis `main.ts`, `main.js`, lalu `manifest.json` ke S3 (bersyarat, immutable), `registry.py` menyisipkan baris `animations`, event `done` membawa `AnimationReference`.
6. Stage memuat bundle lewat Reader dan `lib/animation/loader.ts` (cek SHA-256 sebelum eksekusi), lalu menjalankannya di iframe bersandbox (lihat steering `game-engine`).

**Kontrak.** Satu sumber: `animation-verifier/contract/animation-contract.json` (kanvas 1280x720 @30 fps, durasi 30 sampai 900 frame, hanya `react` dan `remotion`, warna hanya token Kit, sumber maks 32768 byte, bundle maks 131072 byte). Salinan byte-identik di `backend/app/ai/animation/` dan `frontend/src/lib/animation/` dijaga `scripts/sync-animation-contract.py --check` (CI `ci/contracts`). Jangan menyunting salinan.

**Modul backend (`backend/app/ai/animation/`).** `contract.py`, `models.py` (request, `AnimationReference`, event SSE, `canonical_hash`), `tokens.py`, `prompts.py`, `limits.py` (parser env digit ASCII, limiter terpisah), `agent.py`, `verifier_client.py` (`boto3` Lambda), `store.py` (S3), `registry.py` (SQL), `sse.py`, `endpoint.py`, `logging_.py`, `logconfig.py`. Perubahan di berkas lama dijaga tidak mengubah perilaku: `pipeline.entry_guard`, `GeminiRequest.response_format` (default `json`), `AiContext.generate_text`, `settings.animation_models_from_env`, kode galat baru di `envelope.py`, `limits.ANIMATION_BODY_BYTES = 65536`.

**Protokol SSE.** `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`, `: ping` tiap 15 detik. Event: `started {max_attempts, deadline_ms, cached}`, `stage {stage, attempt}`, `diagnostics {attempt, ok, error_count, warning_count, items}` (tanpa pesan), `done {animation, cached, attempts}`, `error {code, message, attempts}`. Tepat satu event akhir. `error.code`: `ANIMATION_VERIFICATION_FAILED`, `ANIMATION_TIMEOUT`, `ANIMATION_VERIFIER_UNAVAILABLE`, `ANIMATION_STORAGE_FAILED`, `ANIMATION_QUOTA_EXCEEDED`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `UNKNOWN`. Kode klien saja: `ABORTED`, `NETWORK`, `STREAM_INTERRUPTED`, `UNEXPECTED`, `ANIMATION_ATTACH_FAILED`. Pesan UI lewat `messageForCode`. Fixture bersama `backend/tests/fixtures/animation/sse-stream.txt`; parser tidak boleh memakai `str.splitlines()` (U+2028 disengaja).

**Batas.** Limiter animasi terpisah dari limiter AI lain (`app.state.animation_limiter`): `ANIMATION_RATE_PER_MINUTE_IP=4`, `ANIMATION_DAILY_PER_IP=30`, `ANIMATION_MAX_CONCURRENT_PER_IP=1`, `ANIMATION_MAX_CONCURRENT_GLOBAL=2`, plus `ANIMATION_MAX_ATTEMPTS=4` dan `ANIMATION_DEADLINE_MS=240000`. Request yang ditolak tidak memakai Gemini, Lambda, S3, slot, atau kuota harian. Tidak ada kode sumber, prompt, token, key, cookie, URL presigned, atau pesan Diagnostic di log, event, atau respons.

**Aturan saat mengubah.** Jangan mengimpor `langgraph` atau `boto3` saat impor modul (hanya di dalam `build_graph()` dan fabrik klien); tes subproses menjaganya. Jangan menduplikasi helper bersama (`test_animation_reuse.py`). Tidak ada `delete_object` dan tidak ada penimpaan objek S3. Prompt belum dicoba pada Gemini asli (bukti pertama: run animasi pertama atau `scripts/verify/ai-smoke.py`).

## Tes
- Backend: `backend/tests/test_ai_*.py` dengan `httpx2.MockTransport` (tanpa jaringan, tanpa Postgres), termasuk parity terhadap snapshot dari kode TS lama dan alur penuh analyze → plan → story.
- Kontrak bersama: fixture `backend/tests/fixtures/ai/*.json` dibaca pytest dan `frontend/tests/contracts/ai-contract.test.ts` (lewat `postBlueprint` asli). Tes klien memakai `frontend/tests/fixtures/backend-fetch.ts` yang melayani fixture yang sama.
- Smoke dengan Gemini asli: `scripts/verify/ai-smoke.py <base-url>` (server harus memegang key).
- Animasi: `backend/tests/test_animation_*.py` (Gemini, Lambda, S3, dan registry palsu; `tests/fake_s3.py`, `tests/animation_*_support.py`), `frontend/tests/animation/*`, `frontend/tests/generation/animating*.test.ts`, korpus verifier `animation-verifier/fixtures/{good,bad,warn}` lewat Vitest, dan `scripts/verify/animation-smoke.py <base-url>` (satu animasi sungguhan, hanya dijalankan operator; jangan dalam loop karena limiter berlaku).
