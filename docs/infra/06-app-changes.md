# 06 Perubahan aplikasi: container, timeout AI 5 menit, migrasi persistensi

**Tujuan dokumen.** Menjelaskan apa yang harus berubah di kode aplikasi supaya cocok dengan infrastruktur: kontrak container web dan api, health check, timeout AI 5 menit dari ujung ke ujung, dan sketsa migrasi persistensi dari IndexedDB ke backend (Phase B). Tidak ada perubahan kode yang dilakukan oleh dokumen ini. Perubahan dikerjakan di roadmap ([10-implementation-roadmap.md](./10-implementation-roadmap.md)). Kode di dokumen ini adalah ilustrasi: verifikasi saat implementasi.

Status: terimplementasi untuk fase R5–R11 (`frontend/` dan `backend/` terpisah; Phase B R13 menunggu Q4)

## 1. Kontrak container web (Next.js)

### 1.1 `next.config.ts`

Tambahkan `output: "standalone"` tanpa menghapus opsi yang sudah ada. Konfigurasi sekarang memuat `cacheComponents: true`, `partialPrefetching: true`, `reactCompiler: true`, dan `turbopack.rules` untuk loader Tailwind [terverifikasi: pembacaan `next.config.ts`]. Semuanya dipertahankan.

```typescript
const nextConfig: NextConfig = {
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: { /* rules yang sudah ada, tidak berubah */ },
};
```

### 1.2 Dockerfile (`frontend/Dockerfile`)

Multi-stage (aplikasi Next.js dipindah ke direktori `frontend/` sebelum R6). Versi Node mengikuti `frontend/.nvmrc` (`26`).

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=<VERSI_DARI_NVMRC>

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN useradd --create-home --uid 10001 app
COPY --from=build --chown=app /app/.next/standalone ./
COPY --from=build --chown=app /app/.next/static ./.next/static
COPY --from=build --chown=app /app/public ./public
USER app
EXPOSE 3000
LABEL org.opencontainers.image.source="https://github.com/Nnaory/lore"
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
```

Catatan:

- Healthcheck memakai `node` karena image slim tidak punya `curl`.
- Build image tidak membutuhkan secret. `AI_PROVIDER` tanpa key jatuh ke provider `dummy` (kondisi sekarang di `geminiConfigFromEnv`, yang mengembalikan `null` jika key kosong).
- Pastikan `public/` dan `.next/static` tersalin. Server standalone tidak menyajikannya sendiri jika tidak ikut di image.
- Perilaku `HOSTNAME` di server standalone dan env `KEEP_ALIVE_TIMEOUT` [belum diverifikasi]. Cek file `server.js` yang dihasilkan saat R5.

### 1.3 `.dockerignore`

```
.git
.github
.kiro
.next
node_modules
coverage
tests
docs
infra
deploy
backend
.env*
*.md
tsconfig.tsbuildinfo
run_test.bat
```

`.env*` wajib dikecualikan agar tidak ada key yang masuk layer image.

### 1.4 Health route

Route handler `GET /api/health` di `src/app/api/health/route.ts` mengembalikan `{ "status": "ok" }`, dengan test vitest.

Peringatan: aplikasi memakai `cacheComponents`. Handler GET yang tidak mengakses request bisa diperlakukan statis saat build, sehingga health check tidak benar-benar mengevaluasi runtime [belum diverifikasi]. Pastikan handler dievaluasi saat runtime (misalnya membaca `request` atau memakai API yang menandainya dinamis) dan verifikasi dengan `docker run` lalu `curl` setelah build.

## 2. Kontrak container api (FastAPI)

Folder `backend/` (belum ada). Struktur mengikuti `zero-to-prod`: `app/main.py`, `pyproject.toml` dengan ruff dan pytest, `requirements.txt`, `requirements-dev.txt`, `tests/`, `alembic/`.

| Endpoint | Fungsi | Dirouting publik oleh Caddy? |
|---|---|---|
| `GET /health` | Liveness untuk Docker healthcheck | Tidak |
| `GET /health/db` | `SELECT 1` ke Postgres, dipakai `deploy.sh` | Tidak |
| `GET /api/v1/health` | Liveness publik untuk smoke test lewat Caddy, tanpa menyentuh DB | Ya |
| `/api/v1/*` | Semua rute bisnis | Ya |

Aturan:

- Python 3.12-slim, multi-stage, user non-root uid 10001, healthcheck memakai `urllib` (pola `zero-to-prod`).
- `uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=<IP_PRIVAT_WEB>`. Dukungan CIDR pada `--forwarded-allow-ips` bergantung versi uvicorn yang dipin [belum diverifikasi].
- Tanpa CORS karena frontend dan API satu origin lewat Caddy.
- Env sesuai [00-overview.md](./00-overview.md) bagian 6 (`PG*`, `AI_*`, `GOOGLE_API_KEY`).
- Jika Gunicorn dipakai, set worker timeout di atas 300 detik (default 30 detik) dan sesuaikan keep-alive.
- Batasi pool DB dan jumlah worker agar sesuai batas koneksi RDS ([04-database.md](./04-database.md)).
- Label OCI `org.opencontainers.image.source` dan tag image `sha-*` mengikuti [03-compute.md](./03-compute.md).

## 3. Timeout AI 5 menit dari ujung ke ujung

Keputusan: timeout AI menjadi 5 menit supaya model punya waktu untuk reasoning dan menjawab dengan baik.

### 3.1 Kondisi kode sekarang

[terverifikasi: pembacaan `src/lib/ai/providers/gemini-client.ts`, `gemini-story-generator.ts`, `src/lib/generation/generation.ts`, `tests/ai/gemini.test.ts`]

- `geminiConfigFromEnv` membaca `AI_TIMEOUT_MS ?? 30_000` (timeout per request) dan `AI_DEADLINE_MS ?? 90_000` (budget total satu panggilan `generateJson`, lintas model). `attemptsPerModel` adalah 2.
- `attemptOnce` memakai `AbortController` dengan timer yang dibersihkan di `finally` setelah header respons tiba. Pembacaan body (`response.json()`) tidak tercakup timer.
- Timeout menghasilkan `next-model` (model yang lambat dianggap akan tetap lambat), bukan retry pada model yang sama.
- `gemini-story-generator.ts` punya `STORY_TIMEOUT_MS = 90_000` dan `STORY_DEADLINE_MS = 150_000`, dipakai lewat `Math.max(config, konstanta)`. Nilai env yang lebih besar menang, sehingga konstanta itu tidak perlu diubah.
- Request ke Gemini tidak meminta reasoning tertentu: tidak ada `thinkingConfig` di body, hanya filter `p.thought` pada respons.
- Client `postBlueprint` di `generation.ts` tidak punya timeout sendiri. Hanya `AbortSignal` dari pemain.
- Tidak ada test yang menegaskan nilai default timeout (satu-satunya adalah `vi.stubEnv("AI_DEADLINE_MS", "1")`). Mengubah default aman.

### 3.2 Nilai yang dipilih

| Variabel | Nilai |
|---|---|
| `AI_TIMEOUT_MS` | `300000` |
| `AI_DEADLINE_MS` | `300000` |

Default di kode (`30_000` dan `90_000` menjadi `300_000`) dan `.env.example` diubah saat R11. Parameter SSM `AI_TIMEOUT_MS` dan `AI_DEADLINE_MS` di instance diisi dengan nilai yang sama.

Konsekuensi deadline sama dengan timeout:

- Jika model pertama kehabisan waktu pada 300 detik, `remaining` menjadi nol sehingga tidak ada waktu untuk model berikutnya dan hasilnya adalah error `TIMEOUT`.
- Kegagalan cepat (429, 5xx, JSON tidak valid) tetap pindah model atau retry, karena terjadi jauh sebelum 300 detik.
- Alternatif: `AI_DEADLINE_MS=600000` memberi satu kesempatan failover setelah timeout, dengan tunggu maksimum 10 menit per langkah (Q11).

### 3.3 Lapisan yang harus selaras

| Lapisan | Nilai atau perilaku | Lokasi | Catatan |
|---|---|---|---|
| Gemini per request | 300 detik | `AI_TIMEOUT_MS` | Diubah di R11 |
| Gemini total per langkah | 300 detik | `AI_DEADLINE_MS` | Diubah di R11 |
| fetch Node (undici) | Default `headersTimeout` dan `bodyTimeout` 300 detik [belum diverifikasi] | Runtime Node | Bisa berlomba dengan timeout 300 detik kita. Error berubah dari `AbortError` (diperlakukan `next-model`) menjadi `fetch failed` (diperlakukan retry). Opsi: set timeout 295000, atau konfigurasikan dispatcher undici dengan timeout lebih besar. Uji di R11 |
| Caddy ke api | `response_header_timeout 330s`, `flush_interval -1` | `deploy/web/Caddyfile` | Lebih besar dari 300 detik agar Caddy tidak memutus lebih dulu |
| Caddy ke Next.js | `response_header_timeout 330s`, `keepalive off` | `deploy/web/Caddyfile` | `keepalive off` menghindari koneksi upstream basi karena Next memakai keep-alive 5 detik |
| Node server Next.js | `keepAliveTimeout` default pendek | Server standalone | Ditutup oleh `keepalive off` di Caddy. Env `KEEP_ALIVE_TIMEOUT` diverifikasi [belum diverifikasi] |
| uvicorn atau gunicorn | Uvicorn tidak punya timeout request. Gunicorn default worker timeout 30 detik | `backend/` | Atur jika Gunicorn dipakai |
| Klien Gemini di Python | 300 detik | `backend/` | Atur eksplisit pada klien LangChain atau SDK |
| Browser | Sekitar 300 detik tanpa respons (Firefox `network.http.response.timeout` default 300) [belum diverifikasi] | Klien | Request yang nyaris 300 detik bisa gagal di sisi klien walau server berhasil |
| Cloudflare proxy | Menutup request di atas sekitar 100 detik pada plan non-Enterprise [belum diverifikasi] | DNS | Jika domain di belakang Cloudflare, pakai DNS-only |
| ALB (tidak dipakai) | Idle timeout default 60 detik, rentang 1 sampai 4000 detik | - | [terverifikasi: docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html] |

### 3.4 Rekomendasi arsitektur

- Satu request HTTP yang diam selama beberapa menit rapuh (koneksi seluler, laptop tidur, batas browser). Untuk langkah yang bisa melebihi sekitar 2 menit, gunakan SSE dengan heartbeat (sesuai rencana v2 di README: REST dan SSE) atau pola job lalu polling.
- Selama route masih di Next.js, timeout panjang berlaku apa adanya dan risikonya diterima sampai pindah ke backend.
- Generasi di klien berjalan bertahap: analyze, plan, lalu N story. Waktu terburuk adalah (2 + N) langkah kali 5 menit. Dengan `conceptsPerChapter: 1`, mode short (3 chapter) bisa sampai sekitar 25 menit dan medium (5 chapter) sekitar 35 menit pada kasus terburuk. UI bertahap yang sudah ada menampilkan progres.

### 3.5 "Reasoning lebih lama"

Menaikkan timeout hanya memberi ruang. Agar model benar-benar bernalar lebih lama, request perlu meminta reasoning (misalnya lewat `thinkingConfig` pada `generationConfig`). Itu belum ada di kode dan keputusan nilainya ada di Q11. Interaksi reasoning dengan `maxOutputTokens` (token reasoning bisa memakan batas output sehingga JSON terpotong) dicek di dokumentasi Gemini saat implementasi [belum diverifikasi].

## 4. Migrasi persistensi (R13)

Spesifikasi lengkap: `.kiro/specs/r13-persistence-migration/` (`requirements.md`, `design.md`, `tasks.md`). Bagian ini meringkas hasil akhirnya. Pipeline AI **tidak** termasuk R13: route `/api/ai/*` tetap di Next.js.

### 4.1 Kondisi sebelum R13

[terverifikasi: pembacaan `src/lib/state/project-store.ts` dan `idb.ts` sebelum R13]

- Database IndexedDB `lore` v1 dengan store `projects` dan `summaries`, ditulis dalam satu transaksi.
- Fungsi publik: `listProjects`, `loadProject`, `createProject`, `saveCampaignState`, `deleteProject`, `projectStories`.
- Data divalidasi Zod saat dibaca. `campaign_state` yang tidak valid dibuang tanpa menghapus story.
- Ada migrasi sekali jalan dari localStorage lama.
- Pemakai: `src/app/create/page.tsx`, `src/components/home/SavedStories.tsx`, `src/components/play/PlayProject.tsx`.
- `lore:pacing` di localStorage tetap lokal (fitur avatar sudah dihapus 17 Nov 2026).

### 4.2 Rancangan yang diimplementasikan

- **Repository.** Interface `ProjectRepository` (`src/lib/state/repository.ts`) dengan dua implementasi: `IndexedDbRepository` (kode lama, dipindah tanpa perubahan perilaku) dan `HttpRepository`. `project-store.ts` memilih salah satu saat modul dimuat dari flag build `NEXT_PUBLIC_PROJECT_STORE` (`idb` default, `http`). Signature publik tidak berubah; `PlayProject` hanya menambah satu `useEffect` untuk banner error simpan dari server.
- **Local-first.** Di mode `http`, tulisan masuk IndexedDB dulu lalu ke server. Simpan `campaign_state` di-debounce 1,5 detik, dikirim satu per satu, retry 5 detik sampai 60 detik (dua kali lipat), `Retry-After` dihormati untuk `429`. Muat project dari server, jatuh ke salinan lokal bila `404`, error, atau data tidak valid.
- **Sync check** (`src/lib/state/sync.ts`) berjalan sekali tiap page load, tanpa flag "sudah diimport": project lokal yang tidak ada di server diimport (dengan progresnya), project lokal yang lebih baru di-`PUT` state-nya. Import dikirim per batch maksimal 4 MB.
- **Identitas.** Cookie `lore_device` (UUID v4, `HttpOnly`, `SameSite=Lax`, `Path=/`, 1 tahun) dipasang oleh middleware FastAPI pada setiap respons `/api/v1/projects/*`, termasuk respons error. `Secure` mengikuti `X-Forwarded-Proto: https` dari Caddy. Lihat Q4.
- **Konflik.** `PUT .../state` dengan `updated_at` lebih lama ditolak `409` (cek atomik dalam satu `INSERT ... ON CONFLICT ... WHERE`). Kepemilikan selalu dicek sebelum menulis, dan akses ke project milik orang lain menghasilkan `404` yang sama persis dengan id yang tidak ada.

### 4.3 Endpoint

| Method dan path | Fungsi | Sukses | Error |
|---|---|---|---|
| `GET /api/v1/projects` | Daftar ringkasan milik pemanggil, terbaru dulu | `200` | `429` |
| `POST /api/v1/projects` | Buat project (boleh dengan id, timestamp, dan `campaign_state` dari klien) | `201` baris baru, `200` jika id sudah milik pemanggil | `409` id milik orang lain, `413`, `422`, `429` |
| `GET /api/v1/projects/{id}` | Muat project lengkap | `200` | `404`, `429` |
| `DELETE /api/v1/projects/{id}` | Hapus project (cascade) | `204` | `404`, `429` |
| `PUT /api/v1/projects/{id}/state` | Simpan `campaign_state` | `200` `{ updated_at }` | `404`, `409` `{ stored_updated_at }`, `413`, `422`, `429` |
| `POST /api/v1/projects/import` | Import dari IndexedDB | `200` `{ imported, skipped, rejected }` | `413`, `422`, `429` |

Semua endpoint mengembalikan `503` bila database tidak dikonfigurasi. `429` selalu membawa `Retry-After: 60`.

**Batas** (`backend/app/projects.py`, `Limits`; byte desimal, sama dengan Caddy):

| Batas | Nilai |
|---|---|
| Body `POST /projects` | 2.000.000 byte |
| Body `PUT /state` | 500.000 byte |
| Body `POST /import` | 5.000.000 byte (sama dengan `request_body max_size 5MB` di Caddy untuk `/api/v1/*`) |
| Rate limit per IP | 120 request per menit untuk semua endpoint project |
| Rate limit tulis per pemilik | 60 per menit (POST, PUT, DELETE) |
| Import per IP | 5 per menit |
| Kuota create per IP | 100 per hari UTC |
| Storage per pemilik | 100 project dan 50 MB |
| Storage global | 10.000 project |

Body diukur saat streaming, jadi body chunked tanpa `Content-Length` juga kena batas. Rate limiter berada di memori proses (satu instance api) dan memakai `request.client.host` yang sudah diresolusi uvicorn `--proxy-headers` dari Caddy. Ukuran terukur (T0): satu project 25 sampai 42 KB.

### 4.4 File yang terdampak

| File | Dampak |
|---|---|
| `backend/alembic/versions/7c1d9e4a52b8_r13_persistence.py` | Tabel `projects`, `project_stories`, `project_state` |
| `backend/app/owner.py`, `ratelimit.py`, `models.py`, `projects.py`, `main.py` | Middleware cookie, rate limiter, model envelope, router, wiring |
| `deploy/web/Caddyfile` | `request_body { max_size 5MB }` di `handle /api/v1/*` (mengganti instance web saat di-apply) |
| `frontend/src/lib/state/project-model.ts`, `repository.ts`, `indexed-db-repository.ts`, `http-repository.ts`, `sync.ts`, `api-paths.ts` | Model bersama, interface, dua implementasi, sync check |
| `frontend/src/lib/state/project-store.ts` | Pemilihan repository dan `setupSaveErrorHandler` |
| `frontend/src/components/play/PlayProject.tsx` | Banner error simpan dari server |
| `frontend/Dockerfile`, `frontend/.env.example` | `ARG NEXT_PUBLIC_PROJECT_STORE=idb` |
| `.github/workflows/release-web.yml` | Belum diubah; build arg `http` adalah langkah cutover (D5) |

`src/app/create/page.tsx` dan `src/components/home/SavedStories.tsx` tidak berubah.

### 4.5 Strategi test

- Backend: pytest dengan Postgres 16 (service container di CI): migrasi dari kosong dan downgrade, middleware cookie, model, rate limiter (jam disuntikkan), isolasi pemilik, CRUD, konflik dan race, import, batas body (termasuk chunked), storage cap, kuota harian.
- Frontend: vitest dengan `fake-indexeddb` dan `fetch` di-mock untuk `IndexedDbRepository`, `HttpRepository`, sync check, dan pemilihan mode (`vi.stubEnv` + `vi.resetModules`).
- Contract test: `backend/tests/fixtures/project.json` diterima model Pydantic (`test_models.py`) dan skema Zod (`tests/state/project-contract.test.ts`).
- Kode dan test masuk commit terpisah (konvensi repo).
