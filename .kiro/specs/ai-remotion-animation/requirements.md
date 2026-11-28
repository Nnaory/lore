# Requirements Document

## Introduction

Fitur ini menambah jalur kedua pada visual pelajaran LORE: Gemini menulis kode animasi, bukan hanya JSON. Visi pengguna (kutipan): "AI men-generate file Remotion, 1 main.ts. Lalu ada agent yang memastikan file itu benar-benar jalan, ada linter dan sebagainya. Akhirnya file disimpan di bucket S3. Lalu dipanggil dan dieksekusi frontend menjadi sebuah animasi. Bikin spec secara mendetail untuk mendevelop ini dari frontend, backend, infra, dan lain-lain. Pastikan reliability, consistency, dan reuse code bila ada."

Alur wajib, dari ujung ke ujung:

1. Gemini menulis satu berkas `main.ts` berisi komposisi Remotion.
2. Agent verifikasi (lint, typecheck, bundle, uji render, perbaikan otomatis oleh AI bila gagal) memastikan berkas itu benar-benar jalan.
3. Berkas yang lolos disimpan di bucket S3.
4. Frontend memanggil berkas itu dari S3 dan mengeksekusinya di dalam sandbox sehingga tampil sebagai animasi di kanvas Stage.

Dokumen ini hanya requirements. Tidak ada kode, Terraform, atau perintah AWS yang dijalankan dalam penulisannya.

### Kondisi sekarang (kode adalah sumber kebenaran)

- AI tidak menghasilkan kode Remotion. Gemini hanya mengisi JSON `visual` (lima jenis: `vectors`, `plot`, `diagram`, `table`, `formula`) yang divalidasi di `backend/app/ai/contracts/visual.py` dan `frontend/src/lib/contracts/schemas/visual.schema.ts`, lalu digambar oleh komposisi buatan manusia di `frontend/src/components/stage/visual-compositions.tsx`, `compositions.tsx`, dan `visual-layout.ts`.
- `StageCanvas` hanya mengenal scene `ambient`, `lesson`, `visual`, `puzzle`, dan `decision`, semuanya lewat `@remotion/player` dengan ukuran `CANVAS_WIDTH` x `CANVAS_HEIGHT` = 1280x720 pada `CANVAS_FPS` = 30. `CanvasPane` memberi `PlayerBar` dan, pada desktop, `ChoiceButton` untuk puzzle. `useCanvasPlayback` hanya memakai `addEventListener`, `removeEventListener`, `play`, `pause`, dan `seekTo` dari `PlayerRef`.
- `backend/app/ai/gemini_client.py` selalu meminta JSON (`responseMimeType: application/json`). `backend/app/ai/pipeline.py` menggabungkan pemeriksaan pintu masuk (rate limit, batas body, JSON, validasi model, key, slot bersamaan, kuota harian) dengan eksekusi layanan JSON.
- Backend berjalan sebagai satu proses uvicorn pada instance `t3.micro` (1 GiB RAM) di subnet privat. Instance `api` memakai IMDSv2 dengan `http_put_response_hop_limit = 1`. S3 gateway endpoint sudah ada pada route table subnet `app`. Role apply `lore-gh-apply`, role deploy `lore-gh-deploy`, dan policy `lore-guardrail-deny` dikelola oleh bootstrap manual (`infra/bootstrap/`).
- Frontend produksi masih memakai flag build `NEXT_PUBLIC_PROJECT_STORE=idb`. Cerita disimpan sebagai JSON opak (`project_stories.blueprint jsonb`).

Jalur JSON lama tetap ada dan menjadi cadangan (Fallback_Scene) untuk setiap kegagalan jalur baru.

### Ruang lingkup

- **Paket baru `animation-verifier/`:** verifier Node/TypeScript yang berjalan sebagai AWS Lambda container image, memuat sumber kebenaran `animation-contract.json`.
- **Backend:** klien Gemini mode teks, agent LangGraph, endpoint `POST /api/v1/ai/animations` (SSE), endpoint baca `GET /api/v1/animations/{animation_id}`, penyimpanan S3, tabel `animations`, limiter, dan perluasan kontrak cerita.
- **Frontend:** kontrak cerita, tahap generasi `animating`, klien SSE, pemuat bundle, sandbox iframe, runtime sandbox, adaptor pemutar, scene `animation`, dan fallback.
- **Infra:** Terraform (S3, ECR, Lambda, log group, security group, IAM, SSM), langkah bootstrap manual, guardrail biaya dan tag.
- **CI/CD dan dokumentasi:** job dan workflow baru, skrip sinkronisasi dan paritas, skrip uji asap, `docs/infra/12-remotion-animation.md`, dan pembaruan steering.

### Di luar lingkup

- Fitur v2 lain: AI grilling, estimasi kredit, chat in-character.
- Primitif interaktif klik-di-kanvas. Animasi tidak menerima masukan pemain; satu-satunya titik interaksi adalah jeda pada `pauseAtFrame`.
- Pembuatan animasi di dalam `generate-story` (terlalu lambat).
- Penentuan benar atau salah oleh AI atau animasi. Mesin game (`validateMultipleChoice`) tetap satu-satunya penentu, dan chip jawaban pilihan ganda tetap.
- Penghapusan animasi, garbage collection objek S3, dan kedaluwarsa objek.
- Audio, gambar, video, font eksternal, dan jaringan dari dalam animasi.
- Penilaian kualitas estetika animasi. Yang diukur hanya hal yang dapat diperiksa mesin (kontrak, kompilasi, render, determinisme, kesetiaan data).
- CDN (CloudFront ada di denylist biaya), domain khusus untuk bucket, dan multi-region.

### Temuan dari pembacaan kode dan keputusan turunannya

- **T-1 (IMDS):** `http_put_response_hop_limit = 1` mencegah container Docker mengambil kredensial role instance. `boto3` di dalam container `api` (presign S3, PutObject, Invoke Lambda) memerlukan kredensial itu. Keputusan: hop limit instance `api` saja menjadi 2 (perubahan in-place pada `metadata_options`, IMDSv2 tetap wajib). Instance `web` dan `nat` tetap 1. Dokumentasi hardening yang menyebut hop limit 1 untuk `api` diperbarui.
- **T-2 (nama aksi IAM):** `HeadObject` bukan aksi IAM tersendiri. HEAD memakai `s3:GetObject`, dan objek yang tidak ada hanya menghasilkan 404 (bukan 403) bila pemanggil punya `s3:ListBucket`. Policy role `api` memakai `s3:PutObject` dan `s3:GetObject` pada `animations/*` ditambah `s3:ListBucket` dengan kondisi prefix.
- **T-3 (log group):** `lore-guardrail-deny` menolak `logs:CreateLogGroup` dan denylist biaya memuat `aws_cloudwatch_log_group`. Log group Lambda dengan retensi 7 hari karena itu butuh pengecualian sempit (satu nama, retensi 7 hari) di checker dan perubahan bootstrap manual.
- **T-4 (izin role apply):** `lore-gh-apply-policy.json` belum mengizinkan pembuatan bucket S3 aplikasi, ECR, Lambda, log group, maupun `iam:PassRole` ke `lambda.amazonaws.com`. Semuanya adalah perubahan bootstrap manual yang menunggu persetujuan pengguna dan harus selesai sebelum PR infra di-merge.
- **T-5 (image Lambda):** fungsi Lambda container image tidak dapat dibuat sebelum image ada di ECR. Terraform membuat Lambda hanya bila variabel `animation_verifier_image_tag` terisi (dua kali apply), dengan `ignore_changes = [image_uri]` agar rilis berikutnya lewat `update-function-code`.
- **T-6 (perubahan `deploy/**`):** `user_data` instance menanam `deploy/**` dengan `user_data_replace_on_change = true`, sehingga mengubah `deploy/common/render-env.sh`, `deploy/api/compose.yml`, atau `deploy/web/Caddyfile` mengganti instance. Fitur ini tidak mengubah berkas-berkas itu: `render-env.sh` sudah membaca semua parameter di bawah `/lore/prod/api/env/` secara generik, dan Caddy sudah memakai `flush_interval -1` pada `/api/v1/*`. Kompresi `encode zstd gzip` dicegah untuk SSE lewat header `Cache-Control: no-store, no-transform` dari API.
- **T-7 (SubtleCrypto):** `crypto.subtle` hanya ada di secure context, sedangkan produksi saat ini melayani HTTP lewat Elastic IP. Verifikasi SHA-256 di browser memakai SubtleCrypto bila ada dan implementasi SHA-256 murni TypeScript bila tidak.
- **T-8 (concurrency Lambda):** akun baru dapat memiliki kuota eksekusi serentak sangat kecil, dan `reserved_concurrent_executions` ditolak bila sisa kuota di bawah 10. Batas serentak ditegakkan di API (`ANIMATION_MAX_CONCURRENT_GLOBAL`), bukan lewat reserved concurrency.
- **T-9 (CSP `'self'`):** perilaku `script-src 'self'` pada dokumen iframe bersandbox tanpa `allow-same-origin` (origin buram) harus dibuktikan di Chromium dan Firefox. Bukti dicatat di runbook sebelum flag web dinyalakan. CSP tidak diubah dari keputusan pengguna.
- **T-10 (batas penulisan agen):** sebagian berkas fitur berada di luar `frontend/src` dan `frontend/tests` (`frontend/sandbox-runtime/`, `frontend/scripts/`, `frontend/next.config.ts`, `frontend/package.json`, `frontend/Dockerfile`, `animation-verifier/`, `scripts/`, `.github/`, `infra/`, `docs/`, `.kiro/steering`). Fase tasks harus menugaskan berkas-berkas itu ke pelaksana yang berwenang.
- **T-11 (PBT backend):** `backend/requirements-dev.txt` tidak memuat Hypothesis. Tes properti backend memakai pola yang sudah ada (`@pytest.mark.parametrize("seed", range(n))` dengan generator acak berbenih), tanpa dependensi dev baru. Frontend dan verifier memakai `fast-check`.
- **T-12 (CSP font dan CSS):** `style-src 'unsafe-inline'` dan `font-src data:` berarti token CSS dan font di sandbox harus inline: CSS token disematkan di `runtime.html` dan font disematkan sebagai `data:` URI.
- **T-13 (isolasi proses):** loop sinkron tak berujung pada frame yang tidak disampel verifier dapat membekukan tab pada browser yang tidak mengisolasi iframe bersandbox ke proses terpisah. Watchdog heartbeat hanya efektif bila iframe terisolasi. Sisa risiko ini dicatat di `known-issues`.
- **T-14 (middleware cookie):** `device_token_middleware` adalah `BaseHTTPMiddleware`, yang dapat menunda perambatan pembatalan ke handler streaming. Pembuktian lewat tes disconnect diwajibkan, dan bila gagal middleware diganti dengan ASGI murni berperilaku sama.
- **T-15 (prefix cookie):** `PROTECTED_PREFIXES` di `backend/app/owner.py` hanya memuat `/api/v1/projects` dan `/api/v1/ai`. Endpoint baca `/api/v1/animations` harus ditambahkan agar cookie `lore_device` terbaca dan terbit.

### Asumsi

Angka di bawah dipilih untuk membuat kriteria dapat diuji. Angka yang diberikan pengguna (misalnya 32768, 131072, 600, 240 detik, 1536 MB, 60 detik) dipakai apa adanya.

- **A-1:** batas waktu render per frame di verifier 2000 ms, batas waktu internal verifier 50000 ms (margin 10 detik di bawah timeout Lambda 60 detik), dan jumlah Diagnostic per hasil maksimal 50.
- **A-2:** batas body request animasi 65536 byte. Request terberat yang sah (visual `plot` dengan 3 seri x 60 titik sekitar 3 KB, teks 2000 karakter sampai 8 KB) kurang dari 16 KB, sehingga 64 KiB memberi ruang sekitar 4 kali lipat.
- **A-3:** `max_output_tokens` Gemini untuk animasi 12000 (sumber 32768 byte sekitar 8000 sampai 11000 token), temperatur 0.3 untuk `generate` dan 0.2 untuk `repair`.
- **A-4:** timeout `boto3`: connect 5 detik, read 75 detik, `max_attempts` 2. Timeout jaringan browser untuk pengambilan URL dan unduhan bundle masing-masing 8000 ms. Server mengirim event akhir SSE paling lambat 250000 ms setelah event `started` (deadline 240000 ms ditambah 10000 ms), sedangkan klien membatasi setiap target hingga 270000 ms. Pesan `frame` dari iframe dibatasi paling sering sekali per 100 ms.
- **A-5:** RSS container `api` selama satu animasi berjalan tidak boleh melebihi 600 MiB (sekitar 60% dari 1 GiB, menyisakan ruang untuk OS, Docker, dan agent SSM).
- **A-6:** tambahan biaya AWS bulanan akibat fitur ini harus di bawah US$5 per bulan menurut estimasi tertulis. Bila estimasi lebih besar, perubahan tidak di-merge tanpa persetujuan pengguna.
- **A-7:** `runtime.js` maksimal 1048576 byte. Cache bundle di browser berupa LRU 16 entri.
- **A-8:** nilai tag `Component=animation` ditambahkan untuk resource baru (Lambda, ECR, S3, log group, security group, role). Parameter env di bawah `/lore/prod/api/env/` tetap `Component=api`.
- **A-9:** kontrak memperluas daftar terlarang dari keputusan pengguna dengan: atribut `dangerouslySetInnerHTML`, `srcDoc`, `xlinkHref`, dan semua properti penangan peristiwa `on*`; anggota `Math.random`; serta nama warna CSS pada properti pembawa warna. Aturan gaya Kit (tanpa sudut membulat, bayangan, gradient, blur, emoji) berstatus peringatan, bukan galat, agar tidak memicu kegagalan verifikasi yang tidak perlu.
- **A-10:** header CSP dari Next menambahkan `frame-ancestors 'self'` (hanya dapat berupa header, bukan `<meta>`). Semua direktif lain identik dengan CSP `<meta>`.
- **A-11:** limiter animasi adalah instance `AiLimiter` terpisah dari limiter AI JSON, dengan batas per-menit per owner sama dengan batas per-menit per IP (tidak ada env owner tersendiri).
- **A-12:** `ANIMATION_MAX_ATTEMPTS` mengikuti Requirement 13 kriteria 4 (bilangan bulat 1 sampai 4 dipakai apa adanya, di atas 4 menjadi 4, dan nilai yang hilang, bukan bilangan bulat, atau kurang dari 1 menjadi 4), dan `ANIMATION_DEADLINE_MS` memakai default 240000 dan dijepit ke rentang 1 sampai 240000 (bukan 300000). Nilai env yang bukan string digit bernilai 1 atau lebih memakai default menurut Requirement 16 kriteria 1.
- **A-13:** `owner_id` pada tabel `animations` bersifat `NOT NULL` (cookie selalu ada pada endpoint ini). `Request_Hash` mencakup `concepts` dan `forbidden_tokens` selain bidang yang disebut pengguna, karena keduanya memengaruhi hasil dan kebocoran jawaban.
- **A-14:** karena aturan urutan target (lesson lebih dulu, lalu puzzle, maksimal 4), puzzle hanya dianimasikan bila jumlah target lesson kurang dari 4.
- **A-15:** tidak ada penghapusan animasi. Batas 200 animasi per owner bersifat seumur cookie, dan kehilangan cookie berarti semua referensi cerita lama menghasilkan 404 lalu memakai cadangan (diterima dan didokumentasikan).
- **A-16:** Lambda memakai arsitektur `x86_64` (runner CI `ubuntu-latest` berarsitektur amd64) dan tanpa reserved concurrency.
- **A-17:** integrasi UI mengikuti API publik `StageCanvas` dan `CanvasPane` yang berlaku saat implementasi. Bila task `ui-redesign` mengubah komponen itu lebih dulu, integrasi mengikuti props `scene`, `sceneKey`, `pacing`, `playerRef`, dan `puzzle` yang ada saat itu.
- **A-18:** aturan AGENTS.md "Never accept images or coordinates from the model" berlaku untuk `SceneBlueprint` (sprite dan scene ASCII). Animasi hanya menggambar di dalam panel `CanvasFrame` dan tidak dapat menyentuh lapisan ASCII. Aturan warna token Kit tetap berlaku penuh dan ditegakkan verifier.

### Konstanta yang dipakai konsisten di seluruh dokumen

| Konstanta | Nilai |
|---|---|
| Ukuran kanvas | 1280 x 720, 30 fps |
| `durationInFrames` | bilangan bulat 30 sampai 900 |
| `pauseAtFrame` | bilangan bulat 1 sampai `durationInFrames - 1` |
| Sumber `main.ts` | maksimal 32768 byte |
| Bundle `main.js` | maksimal 131072 byte |
| Elemen DOM per frame | maksimal 600 |
| Lambda verifier | 1536 MB, timeout 60 detik, Node 22, container image |
| Pemanggilan Gemini per animasi | maksimal 4 (1 generate + 3 repair); `ANIMATION_MAX_ATTEMPTS` 1 sampai 4 apa adanya, di atas 4 atau nilai tak valid menjadi 4 |
| Deadline total agent | 240 detik (240000 ms), default dan maksimum `ANIMATION_DEADLINE_MS` (dijepit ke 1 sampai 240000), di bawah batas Caddy 330 detik |
| Event akhir SSE | paling lambat 250000 ms setelah `started` (deadline + 10000 ms) |
| Batas per target di klien | 270000 ms |
| Batas status `loading` Animation_Scene | 48000 ms sejak mount |
| Batas pesan iframe | 50 pesan per 1000 ms yang lolos pemeriksaan `event.source` dan `event.origin` |
| Antrean SandboxPlayerRef sebelum `loaded` | 16 pemanggilan |
| `: ping` SSE | tiap 15 detik tanpa kejadian |
| Batas animasi | 4 per menit per IP, 30 per hari per IP, 1 serentak per IP, 2 serentak global |
| Kuota per owner | 200 animasi |
| URL presigned | 300 detik |
| Heartbeat sandbox | 1 detik, watchdog 3 detik tanpa heartbeat, 8 detik tanpa `loaded` |
| Target per cerita | maksimal 4 |
| Retensi log group | 7 hari, ECR menyimpan 5 image, abort multipart 7 hari |

### Keputusan hasil QA

Dokumen ini memuat 41 requirement dengan 618 kriteria (dihitung ulang dari dokumen). Tahap QA terakhir menambah 68 kriteria baru pada Requirement 29 sampai 41 di akhir daftar masing-masing, tanpa mengubah nomor kriteria yang sudah ada. Keputusan G1 sampai G5, G8, dan G10 sudah diterapkan langsung pada kriteria oleh tahap sebelumnya dan dicatat di tabel berikut hanya untuk keterlacakan, tanpa mengubah kriteria itu. Keputusan lintas requirement berikut berlaku di seluruh dokumen.

| Kode | Keputusan | Kriteria yang memuatnya |
|---|---|---|
| G1 | Warna dan font: nilai warna hanya `var(--color-<token>)` (sembilan token) dan kata kunci `transparent`, `currentColor`, `none`, `inherit`. `transparent` dan `currentColor` bukan "nama warna CSS" terlarang. Font-family di luar `var(--font-display)` dan `var(--font-mono)` hanya menghasilkan peringatan `ESLINT_LORE_KIT_STYLE`. | 1:8, 1:13, 1:15, 1:17, 2:12, 2:16, 8:11 |
| G2 | Pemindaian literal warna dan skema URL berlaku untuk semua literal string dan template literal, kecuali teks anak langsung `createElement` (argumen ketiga dan seterusnya). Required_Token yang bentuk utuhnya cocok dengan pola hex, `rgb(`/`hsl(`, atau skema URL terlarang dikeluarkan dari Required_Tokens dan dicatat sebagai `skipped_tokens` pada Animation_Manifest. | 1:11, 7:9, 12:2, 12:6, 19:6, Glossary Skipped_Tokens |
| G3 | `require(...)` dan `import x = require()` dilaporkan hanya sebagai `POLICY_DYNAMIC_IMPORT`. Identifier `require` yang tidak dipanggil dilaporkan sebagai `POLICY_FORBIDDEN_IDENTIFIER`. | 1:10, 7:4, 7:20 |
| G4 | Kode ESLint adalah `ESLINT_` diikuti id aturan huruf besar dengan `@` dibuang serta `/` dan `-` menjadi `_`, dan temuan tanpa id aturan menjadi `ESLINT_PARSE_ERROR`. Regex bentuk kode dibangun dari `diagnostic_code_prefixes` (sebelas awalan termasuk `AGENT`; regex Animation_Verifier memakai semua awalan selain `AGENT`). | 2:1, 2:13, 6:8, 6:15, 8:2 |
| G5 | Determinisme verifier (dua run menghasilkan `ok`, `diagnostics`, `bundle`, `meta`, dan `summary` identik selain `ms`) berlaku kecuali untuk `RENDER_FRAME_TIMEOUT`, `RENDER_RESOURCE_LIMIT`, `VERIFIER_DEADLINE`, dan `VERIFIER_INTERNAL`. Pesan Diagnostic tidak memuat durasi atau id invokasi. | 6:12, 38:3 |
| G6 | `ANIMATION_DEADLINE_MS` default 240000 dan dijepit ke 1 sampai 240000. Event akhir SSE tiba paling lambat deadline + 10000 ms setelah `started`. Batas per target di klien 270000 ms. | 13:5, 16:1, 17:14, 24:9, 24:14, 25:11, A-4, A-12 |
| G7 | `ANIMATION_MAX_ATTEMPTS`: 1 sampai 4 dipakai apa adanya, di atas 4 menjadi 4, hilang atau bukan bilangan bulat atau kurang dari 1 menjadi 4. | 13:4, 16:1, 34:18, A-12 |
| G8 | Routing Animation_Agent setelah `verify`, berurutan: sisa waktu 0 atau kurang menuju `ANIMATION_TIMEOUT`; `ok` true menuju `publish`; Gemini_Call di bawah batas percobaan menuju `repair`; selain itu `ANIMATION_VERIFICATION_FAILED`. `VERIFIER_INTERNAL` menuju `ANIMATION_VERIFIER_UNAVAILABLE` tanpa Gemini_Call lagi. `VERIFIER_DEADLINE` dan `VERIFIER_CRASH` dihitung sebagai percobaan gagal. Pembatalan klien berakhir `UNKNOWN` internal yang tidak dikirim. | 13:2, 13:3, 13:13, 13:15, 14:4, 14:10, 14:11 |
| G9 | Urutan pemeriksaan Animation_Endpoint: rate limit, body, JSON, model request, `PROVIDER_NOT_CONFIGURED`, `ANIMATION_NOT_CONFIGURED`, pencarian idempoten, kuota per owner, slot serentak, kuota harian, lalu stream. | 15:6, 16:4, 16:11, 36:5 |
| G10 | Semantik Animation_Registry: konflik `ON CONFLICT (owner_id, request_hash)` mengembalikan baris yang bertahan tanpa pemeriksaan kuota. Kuota diserialisasi per owner. `owner_max_animations` 200 berada di `app.state.animation_limits`. Request non-idempoten pada owner yang penuh dijawab HTTP 422 sebelum stream. Balapan yang terdeteksi saat `publish` menghasilkan event `error` `ANIMATION_QUOTA_EXCEEDED`. | 13:14, 15:6, 18:8, 20:4, 20:5, 20:8, 20:9, 20:10, 39:10, 39:11, Glossary Animation_Limits |
| G11 | Rilis verifier pertama (fungsi belum ada): push image dan tulis tag SSM, lewati `update-function-code` dan invokasi, cetak `[warn]`, keluar 0. `animation_enabled` true tanpa `animation_verifier_image_tag` ditolak plan lewat `precondition`. | 34:20, 36:3, 36:12, 37:6, 37:11, 37:14 |
| G12 | `ready` dan `heartbeat` runtime dikirim sebelum `load` dengan `session` kosong. `load` membawa `session`, dan pesan keluar sesudahnya memakai `session` itu. | 28:13, 29:14, Glossary Session_Id |
| G13 | `attempts` pada log adalah jumlah Gemini_Call yang dimulai di run itu (0 untuk Idempotent_Hit). Pada `done.animation`, Animation_Registry, dan Animation_Manifest, `attempts` adalah nilai tercatat milik animasi itu (untuk Idempotent_Hit sama dengan nilai baris). | 13:16, 17:12, 18:7, 33:11 |

Kontradiksi yang diselesaikan pada tahap ini:

- **Batas waktu klien:** Sebelumnya A-4 menyebut 250000 ms untuk klien, sedangkan Requirement 24 dan 25 memakai 270000 ms. Sekarang 250000 ms hanya batas server untuk event akhir setelah `started`, dan klien membatasi setiap target 270000 ms.
- **Jepitan deadline:** Sebelumnya A-12 menyebut maksimum 300000, sedangkan Requirement 13 dan 16 memakai 240000. Maksimum menjadi 240000 di semua tempat, termasuk A-12.
- **`attempts` pada Idempotent_Hit:** Requirement 17 kriteria 12 menyebut jumlah Gemini_Call yang dimulai, sedangkan Requirement 18 kriteria 7 mengambil nilai dari baris. `done.attempts` memakai nilai baris dan log memakai 0 (G13).
- **Tag SSM saat fungsi belum ada:** Requirement 36 kriteria 3 dan Requirement 37 kriteria 11 disamakan dengan G11, yaitu tag ditulis dan hanya `update-function-code` serta invokasi yang dilewati.
- **Penyebab `ANIMATION_NOT_CONFIGURED`:** Requirement 16 kriteria 4 kini memuat salinan Animation_Contract tidak valid, sama seperti Requirement 15 kriteria 6.
- **Konfirmasi penulisan bersyarat S3:** Requirement 19 kriteria 11 menyerahkannya ke Smoke_Script, padahal Requirement 33 tidak memeriksanya. Konfirmasi menjadi butir daftar periksa manual operator.
- **Default env di Terraform:** Sebelumnya Requirement 34 kriteria 12 merujuk "default pada Requirement 16" tanpa nilai. Nilai eksplisit kini ada pada kriteria 18, dan tag `Name` serta `Component` parameter SSM disamakan dengan A-8 pada kriteria 13.
- **Remount pemutar:** Requirement 29 kriteria 11 menyebut remount pada pergantian mode. Iframe tidak di-remount, hanya `Player` di dalam iframe.
- **Durasi dan `keyframes` saat cadangan:** Requirement 30 kriteria 8 dan 14 serta Requirement 31 kriteria 14 menetapkan bahwa selama Fallback_Scene dirender, `CanvasPane` memakai durasi dan `keyframes` Fallback_Scene.
- **Larangan peluncuran:** Requirement 41 kriteria 3 melarang "diluncurkan" padahal RSS dengan Flag_Api true terukur di langkah 6. Larangan berlaku untuk langkah 7 (Flag_Web `on`).
- **Tes yang "tidak diubah":** Requirement 38 kriteria 7 dikecualikan untuk penambahan eksplisit di `scripts/ci/test-checkers.py` (Requirement 3, 35, 36, 37, dan 41).
- **`import(` dinamis:** Requirement 32 kriteria 1 hanya melarang argumen selain literal string, sehingga `import("mammoth")` lama tetap lolos.

## Glossary

- **Animation_Feature**: Seluruh fitur ini, dipakai sebagai subjek untuk kriteria lintas komponen (keamanan, flag, rilis).
- **Main_File**: Berkas TypeScript tunggal bernama `main.ts` yang ditulis Gemini dan berisi satu komposisi Remotion.
- **Main_Meta**: Ekspor `meta` pada Main_File: `width`, `height`, `fps`, `durationInFrames`, dan opsional `pauseAtFrame`.
- **Animation_Contract**: Berkas `animation-contract.json` beserta semua aturan yang dimuatnya (versi kontrak, impor dan ekspor yang diizinkan, API terlarang, batas angka, ukuran kanvas, token warna, kode diagnostik).
- **Contract_Sync**: Skrip `scripts/sync-animation-contract.py` dengan mode salin (default) dan `--check`.
- **Version_Parity_Check**: Skrip `scripts/ci/check-animation-versions.py` yang membandingkan versi `react`, `react-dom`, `remotion`, dan `@remotion/player` antara paket verifier dan frontend.
- **Animation_Verifier**: Paket `animation-verifier/` berisi tujuh langkah verifikasi, plugin ESLint lokal LORE, dan handler Lambda.
- **Verifier_Lambda**: Fungsi AWS Lambda container image `lore-prod-animation-verifier` yang menjalankan Animation_Verifier.
- **Diagnostic**: Satu temuan verifikasi atau temuan agent berbentuk `{tool, code, severity, line?, column?, message}`. Temuan agent memakai `tool` `agent` dan kode berawalan `AGENT_`.
- **Test_Suites**: Seluruh tes otomatis fitur ini: Pytest di `backend/tests/`, Vitest di `frontend/tests/` dan `animation-verifier/tests/`, dan `unittest` di `scripts/ci/test-checkers.py`.
- **Verifier_Result**: Hasil verifikasi berbentuk `{ok, diagnostics[], bundle?, meta?, summary}`.
- **Required_Tokens**: Daftar string yang harus tampil pada teks frame (judul verbatim dan semua label teks dari JSON `visual`).
- **Forbidden_Tokens**: Daftar string yang tidak boleh tampil pada frame sampai `pauseAtFrame` (teks jawaban benar pada puzzle).
- **Skipped_Tokens**: Daftar `skipped_tokens` berisi Required_Token yang dikeluarkan dari Required_Tokens karena bentuk utuhnya cocok dengan pola hex, `rgb(`, `hsl(`, atau skema URL terlarang (Requirement 12 kriteria 2), dan dicatat pada Animation_Manifest agar tidak ada jalan buntu antara kesetiaan data dan kebijakan.
- **Animation_Prompts**: Modul backend yang membangun prompt `generate` dan `repair`, mengekstrak kode dari respons, dan menurunkan Required_Tokens serta Forbidden_Tokens efektif dari request.
- **Gemini_Client**: Modul `backend/app/ai/gemini_client.py` beserta perluasannya.
- **Gemini_Call**: Satu pemanggilan fungsi generasi Gemini oleh agent. Satu Gemini_Call boleh berisi retry HTTP dan pergantian model internal Gemini_Client selama masih dalam sisa deadline.
- **Animation_Agent**: Graf LangGraph `StateGraph` dengan node `generate`, `verify`, `repair`, `publish`, dan `fail`.
- **Entry_Guard**: Fungsi bersama di `backend/app/ai/pipeline.py` yang menjalankan pemeriksaan pintu masuk untuk handler JSON dan handler streaming.
- **Animation_Endpoint**: `POST /api/v1/ai/animations`, menjawab dengan SSE.
- **Animation_Reader**: `GET /api/v1/animations/{animation_id}`.
- **Animation_Limiter**: Instance `AiLimiter` khusus animasi dengan batas dari env `ANIMATION_*`.
- **Animation_Store**: Lapisan backend yang menulis dan membaca bucket S3 animasi, bersama bucket itu sendiri.
- **Animation_Manifest**: Objek `manifest.json` pada S3.
- **Animation_Registry**: Tabel PostgreSQL `animations` beserta akses datanya.
- **Request_Hash**: SHA-256 heksadesimal dari JSON kanonik masukan animasi (lihat Requirement 18).
- **Animation_Reference**: Objek opsional `animation` pada blok `learning_info` atau `puzzle` di StoryBlueprint: `animation_id`, `source_sha256`, `bundle_sha256`, `width`, `height`, `fps`, `duration_in_frames`, `pause_at_frame?`, `contract_version`.
- **Story_Contract**: Model Pydantic dan skema Zod StoryBlueprint beserta tipe TypeScript-nya.
- **Target_Selector**: Fungsi murni frontend `selectAnimationTargets`, `buildAnimationRequest`, dan `attachAnimation`.
- **Generation_Flow**: Reducer dan hook generasi di `frontend/src/lib/generation/`.
- **Animation_Client**: Klien SSE frontend yang memanggil Animation_Endpoint.
- **Animation_Loader**: Modul frontend yang mengambil URL presigned, mengunduh `main.js`, memverifikasi hash, dan menyimpannya di cache.
- **Sandbox_Runtime**: Halaman statis `/sandbox/runtime.html` dan `/sandbox/runtime.js` yang dibangun dari `frontend/sandbox-runtime/`.
- **Sandbox_Frame**: Komponen React di halaman induk yang memasang iframe sandbox dan mengelola watchdog-nya.
- **Sandbox_Protocol**: Pesan `postMessage` antara halaman induk dan Sandbox_Runtime, divalidasi Zod di kedua sisi.
- **SandboxPlayerRef**: Adaptor yang mengimplementasikan subset `PlayerRef` (`addEventListener`, `removeEventListener`, `play`, `pause`, `seekTo`) di atas Sandbox_Protocol.
- **Animation_Scene**: Jenis scene baru `animation` pada `StageCanvas` yang membawa Animation_Reference dan Fallback_Scene.
- **Fallback_Scene**: Scene `visual`, `lesson`, `puzzle`, atau `decision` yang akan dirender bila tidak ada animasi.
- **Animation_Infra**: Resource Terraform di `infra/` untuk fitur ini.
- **Cost_Guardrails**: `scripts/ci/policy_rules.py`, `check-cost`, `check-cost-static`, `check-tags`, fixture, dan `test-checkers.py`.
- **Bootstrap_Admin_Step**: Perubahan pada `infra/bootstrap/` yang hanya dijalankan manual oleh admin dan menunggu persetujuan pengguna.
- **Verifier_Release**: Workflow `.github/workflows/release-verifier.yml` dan skrip `scripts/ci/verifier-release.sh`.
- **CI_Pipeline**: Workflow `.github/workflows/ci.yml` beserta job baru fitur ini.
- **Smoke_Script**: Skrip `scripts/verify/animation-smoke.py`.
- **Docs_Set**: Dokumen `docs/infra/12-remotion-animation.md`, pembaruan `docs/infra/*`, dan steering di `.kiro/steering`.
- **Backend**: Aplikasi FastAPI di `backend/` (proses `app.main:app`).
- **Frontend**: Aplikasi Next.js di `frontend/`.
- **Web_Release**: Workflow `.github/workflows/release-web.yml`.
- **Owner**: Pemegang cookie `lore_device` (`backend/app/owner.py`).
- **Pacing**: Mode `fast` atau `animate` yang sudah ada di `frontend/src/lib/story/pacing`.
- **Stage**: Layar bermain yang dirender `StoryViewer` dengan `StageCanvas` dan `CanvasPane`.
- **Flag_Api**: Env backend `ANIMATION_ENABLED`.
- **Flag_Web**: Build arg dan env frontend `NEXT_PUBLIC_ANIMATIONS` (`on` atau `off`).
- **Idempotent_Hit**: Request ke Animation_Endpoint yang Owner dan Request_Hash-nya sudah memiliki baris di Animation_Registry, sehingga dijawab dari baris itu tanpa menjalankan Animation_Agent.
- **Animation_Limits**: Dataclass frozen `app.state.animation_limits` dengan field `owner_max_animations` (default 200, tanpa env), terpisah dari `app.state.limits` milik `backend/app/projects.py`.
- **Session_Id**: String 32 karakter heksadesimal huruf kecil dari `crypto.getRandomValues` yang dibangkitkan Sandbox_Frame untuk setiap mount dan dibawa pesan `load`; string kosong dipakai pesan `ready` dan `heartbeat` dari Sandbox_Runtime sebelum `load`.
- **Sandbox_Builder**: Skrip di `frontend/scripts/` yang membundel `frontend/sandbox-runtime/` menjadi `frontend/public/sandbox/runtime.html` dan `runtime.js`, dijalankan oleh `npm run build` dan `predev`.
- **`interaction.isCorrect`**: Nilai boolean milik objek `interaction` yang dikembalikan hook `usePuzzleInteraction` (`frontend/src/components/story/use-puzzle-interaction.ts`), yang menurunkannya dari `validateMultipleChoice`. Animation_Scene hanya membacanya untuk memanggil `resume`, dan tidak pernah menulisnya.
- **Golden_Test**: Tes golden ASCII frontend yang sudah ada (`frontend/tests/ascii-golden.test.ts`, 40 dari 40 lulus), yang tidak boleh diubah oleh fitur ini.

## Requirements

### Requirement 1: Kontrak berkas Main_File

**User Story:** Sebagai developer, saya ingin satu kontrak yang tepat untuk isi `main.ts`, agar Gemini, verifier, dan runtime sandbox menilai berkas yang sama dengan aturan yang sama.

#### Acceptance Criteria

1. THE Animation_Contract SHALL mewajibkan setiap Main_File bernama persis `main.ts` (`file_name`, sensitif huruf), berenkode UTF-8 tanpa BOM (pelanggaran dilaporkan `ENCODING_INVALID`, juga untuk karakter NUL dan lone surrogate), dan ditulis tanpa sintaks JSX termasuk fragmen (pelanggaran dilaporkan `POLICY_JSX_SYNTAX`), sehingga setiap elemen dibuat lewat `createElement` yang diimpor dari `react`, dan SHALL mewajibkan Main_File berupa satu berkas tanpa berkas pendamping.
2. THE Animation_Contract SHALL mewajibkan `export const meta` berupa object literal yang nilainya hanya literal numerik, memuat `width` sama dengan 1280, `height` sama dengan 720, `fps` sama dengan 30, `durationInFrames` bilangan bulat 30 sampai 900, dan opsional `pauseAtFrame` bilangan bulat 1 sampai `durationInFrames - 1`.
3. THE Animation_Contract SHALL mewajibkan `export default function Main(): ReactElement` tanpa parameter, dan SHALL NOT mengizinkan `export` lain selain `meta` dan ekspor default.
4. WHERE jenis animasi adalah `puzzle`, THE Animation_Contract SHALL mewajibkan `pauseAtFrame` pada Main_Meta.
5. WHERE jenis animasi adalah `lesson`, THE Animation_Contract SHALL melarang `pauseAtFrame` pada Main_Meta.
6. THE Animation_Contract SHALL mengizinkan impor hanya dari `react` dan `remotion`, dan SHALL mendaftar nama yang diizinkan per modul: dari `react` nilai `createElement`, `Fragment`, `useMemo` dan tipe `ReactElement`, `CSSProperties`; dari `remotion` nilai `AbsoluteFill`, `Sequence`, `Series`, `Freeze`, `Easing`, `interpolate`, `spring`, `random`, `useCurrentFrame`, `useVideoConfig`.
7. THE Animation_Contract SHALL mewajibkan keluaran Main_File hanya bergantung pada nomor frame dari `useCurrentFrame()` dan konstanta yang dideklarasikan di berkas, tanpa binding `let` atau `var` di level modul dan tanpa penugasan ke binding level modul di dalam `Main`.
8. THE Animation_Contract SHALL mengizinkan nilai warna hanya berupa `var(--color-<token>)` dengan `<token>` salah satu dari `ink`, `smoke`, `gold`, `ember`, `cream`, `muted`, `ink-soft`, `candle`, `candle-ink`, atau kata kunci `transparent`, `currentColor`, `none`, `inherit`, SHALL mengizinkan font-family tanpa peringatan hanya `var(--font-display)` dan `var(--font-mono)`, dan SHALL memperlakukan token lain, termasuk `--color-cloth-*`, sebagai bukan nilai warna yang diizinkan; font-family selain dua variabel itu hanya menghasilkan peringatan `ESLINT_LORE_KIT_STYLE` (kriteria 13), bukan galat.
9. THE Animation_Contract SHALL mengklasifikasikan sebagai pelanggaran bentuk warna hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`, `rgba()`, `hsl()`, `hsla()`, dan nama warna CSS yang dipakai sebagai nilai properti gaya pembawa warna atau atribut cat SVG yang tercantum di kontrak (`color`, `background`, `backgroundColor`, `border`, `borderColor`, `fill`, `stroke`, `stopColor`, `outline`, `outlineColor`, `textDecorationColor`, `caretColor`, `boxShadow`, `textShadow`).
10. THE Animation_Contract SHALL melarang referensi identifier bebas `eval`, `Function`, `require`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `document`, `window`, `parent`, `top`, `self`, `globalThis`, `navigator`, `localStorage`, `sessionStorage`, `indexedDB`, `postMessage`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `Date`, `performance`, `crypto`, `process`, `Buffer`, `Image`, `Audio`, anggota `Math.random`, `import()` dinamis, serta akses properti `constructor`, `__proto__`, dan `prototype`.
11. THE Animation_Contract SHALL melarang tipe elemen `img`, `video`, `audio`, `iframe`, `script`, `link`, `object`, `embed`, atribut `src`, `href`, `srcset`, `srcDoc`, `xlinkHref`, `dangerouslySetInnerHTML`, setiap atribut yang namanya cocok dengan `^on[A-Z]`, fungsi CSS `url(`, dan setiap URL absolut atau URL dengan skema `http`, `https`, `ftp`, `ws`, `wss`, `file`, `data`, `blob`, `javascript`, atau `vbscript`.
12. THE Animation_Contract SHALL menetapkan batas `source_max_bytes` sebesar 32768, `bundle_max_bytes` sebesar 131072, dan `dom_max_elements` sebesar 600.
13. THE Animation_Contract SHALL mengklasifikasikan sebagai peringatan (bukan galat) penyimpangan gaya Kit berikut: `borderRadius` selain 0, `boxShadow` dan `textShadow` selain `none`, fungsi gradient, filter `blur(` dan `drop-shadow(`, `backdropFilter`, karakter emoji, dan font-family selain dua variabel yang diizinkan.
14. IF Main_File kosong, hanya berisi spasi putih, atau hanya berisi komentar, THEN THE Animation_Verifier SHALL melaporkan sedikitnya `POLICY_META_INVALID` dan `POLICY_EXPORT_MISSING`, SHALL menyetel `ok` ke `false`, SHALL NOT melaporkan `ENCODING_INVALID` atau `SIZE_SOURCE_TOO_LARGE`, dan SHALL NOT melempar exception.
15. IF nilai pada properti pembawa warna bukan nilai warna yang diizinkan menurut kriteria 8 (contoh `var(--color-cloth-mira)`, `var(--color-ink, red)`, `oklch(...)`, `color-mix(...)`), THEN THE Animation_Verifier SHALL melaporkan `POLICY_COLOR_LITERAL` dengan `severity` `error`.
16. FOR ALL bilangan bulat `w`, `h`, `f`, `d`, dan `p` pada rentang -10 sampai 2000, Main_File jenis `puzzle` yang valid selain nilai `meta` `{width: w, height: h, fps: f, durationInFrames: d, pauseAtFrame: p}` SHALL menghasilkan nol Diagnostic `POLICY_META_INVALID` jika dan hanya jika `w` sama dengan 1280, `h` sama dengan 720, `f` sama dengan 30, `d` pada rentang 30 sampai 900, dan `p` pada rentang 1 sampai `d - 1`.
17. THE Animation_Contract SHALL mengklasifikasikan `hwb(`, `lab(`, `lch(`, `oklab(`, `oklch(`, `color(`, dan `color-mix(` sebagai pelanggaran bentuk warna tambahan pada kriteria 9 (dilaporkan `POLICY_COLOR_LITERAL`, tanpa memperhatikan huruf besar-kecil, termasuk hex `#FFF`), dan SHALL mengecualikan kata kunci `transparent` dan `currentColor` dari nama warna CSS yang dilarang.
18. THE Animation_Verifier SHALL melaporkan `POLICY_FORBIDDEN_MEMBER` untuk pemanggilan `random` dari `remotion` dengan argumen literal `null`, dan untuk `Math.random` yang diakses lewat `Math['random']`, destructuring, atau alias `Math`.
19. THE Animation_Verifier SHALL menerima nilai pada `meta` hanya berupa literal bilangan bulat desimal tanpa pemisah `_`, eksponen, titik desimal, atau awalan `0x`, `0b`, dan `0o`, dan SHALL melaporkan `POLICY_META_INVALID` dengan `severity` `error` untuk bentuk lain, untuk kunci duplikat pada `meta`, dan untuk lebih dari satu deklarasi `meta`.
20. THE Animation_Contract SHALL melarang elemen SVG `animate`, `animateTransform`, `animateMotion`, dan `set` (dilaporkan `POLICY_FORBIDDEN_ELEMENT`) serta kunci gaya yang berawalan `animation` atau `transition` (dilaporkan `POLICY_FORBIDDEN_ATTRIBUTE`), karena keluaran hanya boleh bergantung pada nomor frame (kriteria 7).
21. THE Animation_Verifier SHALL melaporkan `ESLINT_LORE_NO_MODULE_STATE` untuk pemanggilan `push`, `pop`, `splice`, `sort`, `reverse`, `set`, `add`, `delete`, atau `clear` pada binding level modul, dan untuk penugasan ke properti binding level modul.

### Requirement 2: Satu sumber kebenaran kontrak dan sinkronisasi

**User Story:** Sebagai developer, saya ingin kontrak ditulis sekali dan disalin otomatis ke backend dan frontend, agar tidak ada drift antara prompt, verifier, dan runtime.

#### Acceptance Criteria

1. THE Animation_Contract SHALL ditulis sekali di `animation-verifier/contract/animation-contract.json` dan SHALL memuat `contract_version` (bilangan bulat positif, awalnya 1), `file_name`, `canvas` (`width`, `height`, `fps`), `duration` (`min`, `max`), `limits`, `allowed_imports`, `required_exports`, daftar `forbidden`, `color_tokens`, `color_properties`, `font_variables`, `diagnostic_code_prefixes`, dan `supported_runtime_contract_versions`.
2. THE Contract_Sync SHALL menyalin berkas sumber byte demi byte ke `backend/app/ai/animation/animation-contract.json` dan `frontend/src/lib/animation/animation-contract.json`.
3. WHEN Contract_Sync dijalankan dengan `--check`, THE Contract_Sync SHALL NOT menulis berkas apa pun, SHALL keluar dengan kode 2 bila berkas sumber hilang, bukan JSON yang valid, atau argumen tidak dikenal (kode 2 diutamakan atas kode 1), SHALL keluar dengan kode 1 dan mencetak satu path yang menyimpang per baris ke stderr bila ada salinan yang berbeda atau hilang, dan SHALL keluar dengan kode 0 bila kedua salinan identik byte demi byte dengan berkas sumber.
4. WHEN Contract_Sync dijalankan tanpa `--check`, THE Contract_Sync SHALL menulis kedua salinan dan SHALL mencetak path yang ditulisnya.
5. THE CI_Pipeline SHALL menjalankan `python3 scripts/sync-animation-contract.py --check` dan SHALL menggagalkan job bila kode keluarnya bukan 0.
6. THE Animation_Prompts, THE Animation_Verifier, dan THE Sandbox_Runtime SHALL masing-masing membaca salinan Animation_Contract miliknya dan SHALL NOT menduplikasi nilai kontrak apa pun sebagai literal di kode sumber.
7. THE Test_Suites SHALL memuat satu tes per komponen: tes backend menegaskan bahwa setiap identifier terlarang, nama impor yang diizinkan, batas, dan token warna di kontrak muncul di prompt yang dirender; tes verifier menegaskan bahwa setiap entri `forbidden` menghasilkan Diagnostic galat `POLICY_*` dan bahwa nama impor yang diizinkan tidak menghasilkannya; tes frontend menegaskan bahwa objek shim `require` mengekspos tepat nama `allowed_imports` per modul dan melempar untuk modul lain (shim hanya mengekspos nama impor yang diizinkan, bukan seluruh permukaan kontrak).
8. THE Test_Suites SHALL menegaskan bahwa `CANVAS_WIDTH`, `CANVAS_HEIGHT`, dan `CANVAS_FPS` dari `frontend/src/components/stage/canvas-layout.ts` sama dengan nilai `canvas` pada kontrak.
9. THE Test_Suites SHALL memuat tes snapshot di `animation-verifier/tests/` yang menyimpan `contract_version` bersama SHA-256 JSON kanonik kontrak tanpa bidang `contract_version` (kunci terurut, tanpa spasi, UTF-8), dan tes itu SHALL gagal bila hash berubah sementara `contract_version` sama.
10. IF salinan Animation_Contract gagal validasi skema, THEN THE Animation_Verifier SHALL melaporkan `VERIFIER_INTERNAL`, THE Animation_Endpoint SHALL menjawab HTTP 503 dengan `ANIMATION_NOT_CONFIGURED`, dan THE Sandbox_Runtime SHALL menjawab `error` dengan fase `load`, masing-masing tanpa melempar exception yang tidak tertangani.
11. THE Animation_Contract SHALL dianggap lolos validasi skema oleh Animation_Verifier, Backend, dan Sandbox_Runtime hanya bila semua bidang pada kriteria 1 ada, `contract_version` berupa bilangan bulat positif, `supported_runtime_contract_versions` tidak kosong dan memuat `contract_version`, `canvas.width`, `canvas.height`, dan `canvas.fps` berupa bilangan bulat positif, serta 1 <= `duration.min` <= `duration.max`.
12. THE Test_Suites SHALL memuat tes yang menegaskan bahwa berkas sumber kontrak memuat `file_name` `main.ts`, `canvas` 1280 x 720 pada 30 fps, `duration` 30 sampai 900, `source_max_bytes` 32768, `bundle_max_bytes` 131072, dan `dom_max_elements` 600 pada `limits`, dan tepat sembilan `color_tokens`.
13. THE Animation_Contract SHALL memuat di `diagnostic_code_prefixes` tepat sebelas awalan, yaitu sepuluh awalan pada Requirement 6 kriteria 8 dan `AGENT`; THE Animation_Verifier SHALL membangun regex bentuk kode pada Requirement 6 kriteria 8 dari semua awalan selain `AGENT`, dan THE Test_Suites SHALL menegaskan bahwa regex hasil bangunan itu sama dengan pola literal pada Requirement 6 kriteria 8.
14. WHEN Contract_Sync dijalankan tanpa `--check`, THE Contract_Sync SHALL membuat direktori induk salinan yang belum ada, dan SHALL membaca serta menulis berkas secara biner tanpa konversi newline.
15. IF salinan Animation_Contract gagal validasi skema, THEN THE Animation_Endpoint SHALL NOT memanggil Gemini_Client, SHALL NOT menghitung kuota harian, dan SHALL NOT mengambil slot bersamaan, dan THE Sandbox_Runtime SHALL NOT mengevaluasi bundle.
16. THE Animation_Contract SHALL memuat sebagai bidang tersendiri `color_keywords`, daftar peringatan gaya Kit (Requirement 1 kriteria 13), aturan `pauseAtFrame` per jenis (Requirement 1 kriteria 4 dan 5), skema URL terlarang (Requirement 1 kriteria 11), dan `forbidden` yang terbagi per kategori: identifier, member, property, element, dan attribute.

### Requirement 3: Paritas versi runtime verifikasi dan eksekusi

**User Story:** Sebagai developer, saya ingin versi `react`, `react-dom`, `remotion`, dan `@remotion/player` identik di verifier, frontend, dan sandbox, agar berkas yang lolos verifikasi berperilaku sama di browser.

#### Acceptance Criteria

1. THE Version_Parity_Check SHALL membaca `react`, `react-dom`, `remotion`, dan `@remotion/player` dari `animation-verifier/package.json`, `frontend/package.json`, `animation-verifier/package-lock.json`, dan `frontend/package-lock.json`.
2. THE Version_Parity_Check SHALL mewajibkan keempat paket itu dipin ke versi persis (tanpa `^`, `~`, atau rentang) di kedua `package.json` dan SHALL mewajibkan versi yang ter-resolve di kedua lockfile sama dengan versi pin.
3. WHEN versi salah satu dari keempat paket berbeda antar keempat sumber, THE Version_Parity_Check SHALL keluar dengan kode 1 dan mencetak satu baris per paket yang berbeda, berisi nama paket dan pasangan `<berkas>=<versi>` untuk keempat sumber.
4. WHEN keempat paket identik di keempat sumber, THE Version_Parity_Check SHALL keluar dengan kode 0.
5. THE Cost_Guardrails SHALL memuat di `scripts/ci/test-checkers.py` tes unit untuk Version_Parity_Check dengan fixture versi yang cocok, satu versi yang berbeda, dan satu penentu rentang.
6. THE CI_Pipeline SHALL menjalankan `python3 scripts/ci/check-animation-versions.py` di job `contracts` dan SHALL menggagalkan job bila kode keluarnya bukan 0.
7. THE Animation_Verifier SHALL mencatat versi `react` dan `remotion` yang terpasang di `summary.runtime_version` dan di bidang `runtime_version` pada Animation_Manifest.
8. THE Sandbox_Runtime SHALL dibangun dari versi `react`, `react-dom`, `remotion`, dan `@remotion/player` yang sama dengan yang ter-resolve di `frontend/node_modules`, dan `runtime.js` SHALL memuat tepat satu salinan setiap paket itu, tanpa salinan kedua (diperiksa lewat metafile pada kriteria 13).
9. IF sebuah paket hilang di salah satu sumber, atau sebuah berkas sumber hilang atau bukan JSON yang valid, THEN THE Version_Parity_Check SHALL keluar dengan kode 1 dan mencetak berkas serta paket yang bermasalah.
10. IF lockfile memuat entri bersarang `node_modules/**/node_modules/<paket>` dengan versi yang berbeda dari pin untuk salah satu dari keempat paket, THEN THE Version_Parity_Check SHALL keluar dengan kode 1 dan mencetak path entri itu.
11. IF `react` dan `react-dom` berbeda versi, atau `remotion` dan `@remotion/player` berbeda versi, di sumber mana pun, THEN THE Version_Parity_Check SHALL keluar dengan kode 1 dan mencetak pasangan paket serta berkas yang bersangkutan.
12. THE Test_Suites SHALL memuat tes Vitest di `animation-verifier/tests/` yang menegaskan bahwa `summary.runtime_version.react` dan `summary.runtime_version.remotion` sama dengan `version` pada `node_modules/<paket>/package.json` dan sama dengan pin di `animation-verifier/package.json`.
13. THE Test_Suites SHALL memuat tes yang membaca metafile esbuild dari build Sandbox_Runtime dan menegaskan bahwa setiap input `react`, `react-dom`, `remotion`, dan `@remotion/player` berasal dari `frontend/node_modules/<paket>/` dan tidak ada path `node_modules/**/node_modules/<paket>/`.

### Requirement 4: Klien Gemini mode teks

**User Story:** Sebagai developer backend, saya ingin memakai ulang klien Gemini yang ada untuk keluaran teks, agar retry, urutan model, deadline, dan penyembunyian key tidak diduplikasi.

#### Acceptance Criteria

1. THE Gemini_Client SHALL menambahkan `response_format` (`json` atau `text`, default `json`) sebagai bidang terakhir `GeminiRequest`, sehingga setiap pemanggil dan setiap tes yang ada berperilaku identik tanpa diubah dan body default tetap memuat `responseMimeType` `application/json`.
2. THE Gemini_Client SHALL menyediakan `generate_text` yang mengembalikan objek sukses berisi `text`, `model`, `usage`, dan `latency_ms`, atau `GeminiFailure` yang sudah ada, dan yang menjalankan jalur kode yang sama dengan `generate_json` untuk urutan model, `attempts_per_model`, backoff, klasifikasi status, deadline, dan penyaringan bagian thought.
3. WHEN format respons adalah `text`, THE Gemini_Client SHALL mengirim `responseMimeType` sama dengan `text/plain` dan SHALL NOT mem-parse respons sebagai JSON.
4. IF gabungan teks bagian non-thought pada respons mode teks kosong atau hanya berisi spasi putih, THEN THE Gemini_Client SHALL memperlakukan percobaan itu sebagai `empty response` dan SHALL menerapkan jumlah percobaan, backoff, dan pergantian model yang sama dengan mode JSON.
5. THE Gemini_Client SHALL NOT menyertakan API key di hasil, detail, pesan exception, atau baris log apa pun pada mode teks.
6. THE Backend SHALL membaca daftar model animasi dari `AI_ANIMATION_MODEL` (dipisah koma, setiap entri di-trim, entri kosong dibuang, dicoba berurutan), SHALL memakai `AI_MODEL` dengan aturan pemisahan yang sama bila `AI_ANIMATION_MODEL` tidak diatur atau tidak berisi entri, dan SHALL memakai `gemini-3.5-flash-lite` bila keduanya tidak berisi entri.
7. WHEN Animation_Agent memulai satu Gemini_Call, THE Animation_Agent SHALL memberikan konfigurasi dengan `deadline_ms` dan `timeout_ms` yang sama dengan nilai terkecil dari `AI_DEADLINE_MS` dan `AI_TIMEOUT_MS` yang sudah ada dan milidetik tersisa sebelum deadline animasi (`ANIMATION_DEADLINE_MS`, default 240000).
8. THE Test_Suites SHALL memuat tes yang menegaskan bahwa string `generativelanguage.googleapis.com` muncul di tepat satu modul di bawah `backend/app`, yaitu `gemini_client.py`.
9. WHEN `generate_text` sukses, THE Gemini_Client SHALL mengembalikan `text` berupa gabungan berurutan bagian non-thought tanpa trim dan tanpa pelepasan pagar kode.
10. IF semua percobaan mode teks gagal, THEN THE Gemini_Client SHALL mengembalikan `GeminiFailure` dengan `code` `RATE_LIMITED`, `TIMEOUT`, atau `PROVIDER_UNAVAILABLE` menurut aturan klasifikasi yang sama dengan mode JSON, dan SHALL NOT mengembalikan `OUTPUT_PARSE_FAILED`.
11. THE Gemini_Client SHALL menyertakan `finish_reason` pada objek sukses `generate_text` (nilai `finishReason` dari respons, atau `none` bila tidak ada) dan SHALL tetap menganggap hasil dengan `finish_reason` `MAX_TOKENS` sebagai sukses.
12. THE Test_Suites SHALL memuat tes paritas berparameter pada `httpx2.MockTransport` yang menegaskan bahwa `generate_json` dan `generate_text` menghasilkan jumlah POST, argumen `sleep`, dan `code` kegagalan yang identik untuk skenario 429 lalu 200, 500 lalu 200, 400, 404, 401, 403, timeout, galat jaringan, dan deadline habis.
13. THE Test_Suites SHALL memuat tes dengan API key sentinel yang menegaskan bahwa sentinel tidak ada di `repr`, `detail`, pesan exception, maupun `caplog` mode teks pada skenario sukses, 401, 429, timeout, dan `LocalProtocolError`.

### Requirement 5: Prompt generate dan repair, serta ekstraksi kode

**User Story:** Sebagai developer backend, saya ingin prompt yang dibangun dari kontrak dan ekstraksi kode yang deterministik, agar Gemini menerima aturan yang sama dengan yang ditegakkan verifier.

#### Acceptance Criteria

1. THE Animation_Prompts SHALL menyediakan fungsi murni `build_generate_prompt(request)` dan `build_repair_prompt(request, previous_source, diagnostics)`, masing-masing mengembalikan pasangan `(system, prompt)`.
2. THE Animation_Prompts SHALL merender system prompt dari salinan backend Animation_Contract sehingga memuat nama berkas, ukuran kanvas, `fps`, rentang durasi, impor dan nama yang diizinkan, identifier dan anggota terlarang, elemen dan atribut terlarang, token warna, variabel font, serta batas 32768 byte, 131072 byte, dan 600 elemen.
3. THE Animation_Prompts SHALL menyertakan di prompt judul, teks, nama konsep, JSON `visual`, bahasa, Required_Tokens (verbatim), dan, untuk jenis `puzzle`, Forbidden_Tokens efektif (Requirement 12) beserta aturan bahwa token itu tidak boleh muncul pada frame mana pun sampai dan termasuk `pauseAtFrame` dan bahwa `pauseAtFrame` wajib ada.
4. THE Animation_Prompts SHALL menaruh setiap nilai yang berasal dari materi atau teks cerita pengguna di dalam satu blok data bertanda batas dan SHALL menyatakan di system prompt bahwa blok itu adalah data dan instruksi di dalamnya harus diabaikan.
5. THE Animation_Prompts SHALL menginstruksikan model menjawab dengan tepat satu blok kode berpagar berlabel `ts` yang memuat seluruh berkas dan tanpa prosa di luar blok.
6. THE Animation_Prompts SHALL menginstruksikan model menulis semua teks yang tampil dalam bahasa yang diminta (`en` atau `id`), kecuali Required_Tokens (judul dan label dari JSON `visual`), yang harus dipakai verbatim.
7. THE Animation_Prompts SHALL menetapkan `max_output_tokens` sebesar 12000 dan temperatur 0.3 untuk `generate` serta 0.2 untuk `repair` tanpa menyertakannya dalam keluaran fungsi `build_*` (yang hanya mengembalikan `(system, prompt)`), THE Animation_Agent SHALL menyetel ketiga nilai itu pada `GeminiRequest`, dan THE Test_Suites SHALL menegaskan ketiganya pada `GeminiRequest` yang diterima Gemini_Client.
8. WHEN membangun prompt repair, THE Animation_Prompts SHALL menyertakan sumber sebelumnya, sampai 50 Diagnostic masing-masing dengan `tool`, `code`, `line`, `column`, dan `message` yang dipotong sampai 200 karakter, serta instruksi untuk mengubah hanya yang diminta Diagnostic, mengembalikan berkas lengkap, dan mempertahankan setiap Required_Token.
9. THE Animation_Prompts SHALL menyediakan `extract_main_ts(text)` yang mengembalikan `{ok: true, source}` untuk blok berpagar pertama berlabel `ts` atau `typescript`, atau untuk seluruh teks bila tidak ada pagar dan teks (setelah di-trim) diawali `import`, `export`, `//`, atau `/*`, dan mengembalikan `{ok: false, code}` dengan `code` sama dengan `AGENT_EXTRACT_NO_CODE` untuk kasus lain.
10. THE `extract_main_ts` SHALL menormalkan sumber dengan membuang BOM di awal, mengubah CRLF dan CR menjadi LF, dan memastikan tepat satu LF di akhir, dan SHALL NOT memotong sumber yang melebihi 32768 byte.
11. FOR ALL string `s`, normalisasi sumber pada kriteria 10 SHALL idempoten (menormalkan hasil normalisasi mengembalikan string yang sama), dan FOR ALL `s` yang berisi karakter bukan spasi putih dan tanpa urutan tiga karakter backtick, `extract_main_ts` atas `s` yang dibungkus pagar `ts` SHALL mengembalikan `{ok: true}` dengan sumber ternormalisasi `s` (round-trip).
12. THE `extract_main_ts` SHALL membuang BOM dan menormalkan CRLF dan CR menjadi LF sebelum mendeteksi pagar dan memotong spasi, SHALL mengenali label `ts` dan `typescript` tanpa memperhatikan huruf besar-kecil, SHALL melewati blok berlabel lain, dan SHALL mengembalikan `{ok: false}` dengan `code` `AGENT_EXTRACT_NO_CODE` bila blok `ts` pertama tidak tertutup atau hanya berisi spasi putih.
13. THE Animation_Prompts SHALL memilih penanda batas blok data secara deterministik dari isi masukan sehingga penanda itu tidak terkandung di dalam blok, SHALL menaruh sumber sebelumnya dan pesan Diagnostic di dalam blok data itu, dan SHALL menetralkan teks yang memuat penanda sehingga prompt memuat tepat satu penanda pembuka dan satu penanda penutup per blok.
14. THE Animation_Prompts SHALL menginstruksikan model menampilkan setiap Required_Token sebagai teks pada frame `durationInFrames - 1` dan, untuk jenis `puzzle`, juga pada frame `pauseAtFrame`.
15. THE `build_repair_prompt` SHALL memuat ulang semua data pada kriteria 3, dengan Required_Tokens dan Forbidden_Tokens efektif yang identik dengan yang dimuat `build_generate_prompt` untuk request yang sama.
16. IF `previous_source` kosong, THEN THE `build_repair_prompt` SHALL menyatakan bahwa tidak ada sumber sebelumnya dan SHALL meminta berkas lengkap dari awal.

### Requirement 6: Verifier, pipeline tujuh langkah dan bentuk hasil

**User Story:** Sebagai developer, saya ingin verifier yang selalu mengembalikan hasil terstruktur dan deterministik, agar agent dan tes dapat memutuskan lolos atau perbaikan tanpa menebak.

#### Acceptance Criteria

1. THE Animation_Verifier SHALL berupa paket TypeScript di `animation-verifier/` untuk Node 22 yang mengekspos handler Lambda yang menerima `{source, kind, required_tokens, forbidden_tokens, contract_version}` dan mengembalikan Verifier_Result.
2. IF event bukan object, kehilangan salah satu dari lima bidangnya (`source`, `kind`, `required_tokens`, `forbidden_tokens`, `contract_version`), atau melanggar skema masukan (`source` string, `kind` sama dengan `lesson` atau `puzzle`, setiap larik token berisi paling banyak 200 elemen string yang masing-masing paling banyak 400 karakter, `contract_version` bilangan bulat positif; bidang tambahan diabaikan dan tidak melanggar skema; batas 200 elemen dan 400 karakter hanya perisai, karena skema `visual` menghasilkan paling banyak 68 token berukuran paling banyak 200 karakter), THEN THE Animation_Verifier SHALL mengembalikan `{ok: false}` dengan tepat satu Diagnostic yang `code`-nya `VERIFIER_BAD_INPUT`, SHALL NOT menjalankan langkah apa pun, dan SHALL NOT melempar exception.
3. WHEN `contract_version` berbeda dengan versi pada salinan Animation_Contract milik verifier, THE Animation_Verifier SHALL mengembalikan satu Diagnostic dengan `code` `VERIFIER_CONTRACT_MISMATCH` dan SHALL NOT menjalankan langkah lain.
4. THE Animation_Verifier SHALL menjalankan langkah dengan urutan: (1) ukuran dan encoding, (2) pemindaian kebijakan AST, (3) ESLint, (4) `tsc --noEmit`, (5) bundle esbuild, (6) uji render, (7) gerbang kesetiaan data.
5. WHEN langkah 1 melaporkan galat, THE Animation_Verifier SHALL berhenti setelah langkah 1.
6. WHEN langkah 1 tidak melaporkan galat, THE Animation_Verifier SHALL menjalankan langkah 2, 3, dan 4 dan SHALL melaporkan semua temuannya bersama dalam satu Verifier_Result.
7. WHEN langkah 1 sampai 4 tidak melaporkan Diagnostic galat, THE Animation_Verifier SHALL menjalankan langkah 5, lalu langkah 6 hanya bila langkah 5 berhasil, lalu langkah 7 hanya bila langkah 6 tidak melaporkan galat.
8. THE Animation_Verifier SHALL memberi setiap Diagnostic bidang `tool` (salah satu dari `size`, `policy`, `eslint`, `tsc`, `esbuild`, `render`, `fidelity`, `verifier`), `code` yang cocok dengan `^(SIZE|ENCODING|POLICY|META|ESLINT|TSC|BUNDLE|RENDER|FIDELITY|VERIFIER)_[A-Z0-9_]+$`, `severity` (`error` atau `warning`), `line` dan `column` opsional berbasis 1, dan `message` paling banyak 200 karakter.
9. THE Animation_Verifier SHALL menentukan `ok` sebelum pemotongan, SHALL mengembalikan paling banyak 50 Diagnostic dengan membuang `warning` lebih dulu, SHALL mengurutkan Diagnostic yang dikembalikan menurut langkah (Diagnostic `tool` `verifier` terakhir), lalu `line` (yang tanpa `line` lebih dulu), lalu `column`, lalu `code` secara abjad (Diagnostic `FIDELITY_*` mengikuti urutan pada Requirement 10 kriteria 12), dan SHALL menyetel `summary.truncated` ke `true` bila ada Diagnostic yang dibuang.
10. THE Animation_Verifier SHALL mengembalikan `summary` yang memuat `verifier_version` (dari `package.json`), `contract_version`, `runtime_version` (`react`, `remotion`), `checks` (daftar `{name, ok, ms}` untuk setiap langkah yang berjalan), dan `truncated`.
11. WHEN Verifier_Result tidak memiliki Diagnostic galat, THE Animation_Verifier SHALL menyetel `ok` ke `true` dan SHALL menyertakan `bundle` (teks `main.js`) dan `meta` (Main_Meta yang tervalidasi); selain itu THE Animation_Verifier SHALL menyetel `ok` ke `false` dan SHALL menghilangkan `bundle` dan `meta`.
12. FOR ALL masukan yang tidak memicu `RENDER_FRAME_TIMEOUT`, `RENDER_RESOURCE_LIMIT`, `VERIFIER_DEADLINE`, atau `VERIFIER_INTERNAL`, menjalankan Animation_Verifier dua kali SHALL menghasilkan `ok`, `diagnostics`, `bundle`, `meta`, dan `summary` yang identik selain bidang `ms` (determinisme), dan `message` Diagnostic SHALL NOT memuat durasi atau id invokasi.
13. IF terjadi galat internal apa pun, THEN THE Animation_Verifier SHALL mengembalikan Diagnostic dengan `code` `VERIFIER_INTERNAL` dan `ok` sama dengan `false`, dan SHALL NOT membiarkan exception lolos dari handler.
14. IF event gagal skema masukan atau `contract_version`-nya berbeda dengan versi pada salinan Animation_Contract milik verifier, THEN THE Animation_Verifier SHALL mengembalikan `ok` `false` tanpa `bundle` dan `meta`, dengan `summary.checks` kosong, `summary.truncated` `false`, `summary.contract_version` sama dengan versi salinan kontrak milik verifier, dan `summary.runtime_version` dari paket yang terpasang.
15. THE Animation_Verifier SHALL memberi setiap Diagnostic yang dihasilkannya `code` yang cocok dengan regex pada kriteria 8 dan SHALL memasangkan `tool` dengan awalan `code`: `size` dengan `SIZE_` atau `ENCODING_`; `policy` dengan `POLICY_` atau `META_`; `eslint` dengan `ESLINT_`; `tsc` dengan `TSC_`; `esbuild` dengan `BUNDLE_`; `render` dengan `RENDER_`; `fidelity` dengan `FIDELITY_`; dan `verifier` dengan `VERIFIER_`.
16. THE Animation_Verifier SHALL mengisi `summary.checks[].name` dengan nilai `tool` langkahnya secara berurutan, `ok` `false` bila langkah itu melaporkan galat, dan `ms` berupa bilangan bulat tidak negatif, tanpa entri untuk langkah yang tidak berjalan.
17. THE Animation_Verifier SHALL menyertakan nomor frame dengan format `frame=<n>` di `message` setiap Diagnostic `RENDER_*` atau `FIDELITY_*` yang terkait dengan satu frame.

### Requirement 7: Verifier, ukuran, encoding, dan pemindaian kebijakan AST

**User Story:** Sebagai developer, saya ingin pemindaian kebijakan yang sound pada AST, agar token terlarang tidak lolos karena trik penulisan dan penggunaan sah tidak ditolak.

#### Acceptance Criteria

1. WHEN ukuran UTF-8 `source` melebihi 32768 byte, THE Animation_Verifier SHALL melaporkan `SIZE_SOURCE_TOO_LARGE` dan berhenti.
2. IF `source` memuat karakter NUL, lone surrogate, atau BOM, THEN THE Animation_Verifier SHALL melaporkan `ENCODING_INVALID` dan berhenti.
3. THE Animation_Verifier SHALL mem-parse sumber dengan parser TypeScript dalam mode yang mengenali JSX dan SHALL melaporkan `POLICY_JSX_SYNTAX` pada setiap node JSX.
4. THE Animation_Verifier SHALL melaporkan `POLICY_IMPORT_DISALLOWED` untuk setiap impor yang modulnya bukan `react` atau `remotion`, yang nama impornya tidak ada di daftar yang diizinkan untuk modul itu, atau yang berupa impor namespace, impor default, impor side-effect, atau re-ekspor `export ... from`, dan SHALL melaporkan `POLICY_DYNAMIC_IMPORT` untuk `import()` dan untuk pemanggilan `require`.
5. THE Animation_Verifier SHALL meresolusi identifier lewat tabel simbol TypeScript dan SHALL melaporkan `POLICY_FORBIDDEN_IDENTIFIER` hanya untuk nama terlarang yang dipakai sebagai referensi yang tidak ter-resolve ke deklarasi apa pun di sumber, sehingga nama properti, kunci object literal seperti `top: 10`, atau variabel yang dideklarasikan lokal dengan ejaan yang sama tidak dilaporkan.
6. THE Animation_Verifier SHALL melaporkan `POLICY_FORBIDDEN_MEMBER` untuk `Math.random` dan `POLICY_FORBIDDEN_PROPERTY` untuk akses properti atau akses elemen dengan kunci literal sama dengan `constructor`, `__proto__`, atau `prototype`.
7. THE Animation_Verifier SHALL mengenali pemanggilan `createElement` lewat tabel simbol (termasuk alias impor), SHALL melaporkan `POLICY_DYNAMIC_ELEMENT` untuk referensi `createElement` selain sebagai callee langsung dan untuk argumen pertama selain literal string, `const` berliteral string, `Fragment`, komponen yang diimpor dan diizinkan, atau fungsi yang dideklarasikan lokal, dan SHALL melaporkan `POLICY_FORBIDDEN_ELEMENT` bila literal itu menyebut elemen terlarang.
8. THE Animation_Verifier SHALL melaporkan `POLICY_FORBIDDEN_ATTRIBUTE` untuk setiap kunci properti pada object props yang sama dengan atribut terlarang tanpa memperhatikan huruf besar-kecil atau yang cocok dengan `^on[A-Z]` (sensitif huruf), dan SHALL memindai juga object literal yang disebar dengan `{...p}` pada object props.
9. THE Animation_Verifier SHALL memindai setiap literal string dan template literal terhadap pola di kontrak, kecuali teks anak langsung `createElement` (argumen ketiga dan seterusnya), dan SHALL melaporkan `POLICY_URL_LITERAL` untuk `url(` dan untuk skema URL terlarang di awal string setelah trim tanpa memperhatikan huruf besar-kecil (untuk `data`, `blob`, `javascript`, dan `vbscript`, karakter `:` harus diikuti karakter bukan spasi), serta `POLICY_COLOR_LITERAL` untuk hex 3, 4, 6, atau 8 digit, `rgb(`, `rgba(`, `hsl(`, `hsla(`, dan nama warna pada properti pembawa warna.
10. THE Animation_Verifier SHALL melaporkan `POLICY_META_INVALID` bila `meta` hilang, bukan object literal berisi literal numerik, memiliki kunci selain lima kunci yang diizinkan, atau melanggar rentang pada Requirement 1, SHALL melaporkan `META_PAUSE_REQUIRED` bila jenis `puzzle` dan `pauseAtFrame` tidak ada, dan SHALL melaporkan `META_PAUSE_FORBIDDEN` bila jenis `lesson` dan `pauseAtFrame` ada.
11. THE Animation_Verifier SHALL melaporkan `POLICY_EXPORT_MISSING` bila ekspor default bukan deklarasi fungsi bernama `Main` tanpa parameter, dan `POLICY_EXPORT_UNEXPECTED` untuk ekspor lain apa pun.
12. THE Animation_Verifier SHALL mengumpulkan semua temuan kebijakan dalam satu lintasan, masing-masing dengan baris dan kolom, dan SHALL NOT berhenti pada temuan pertama.
13. FOR ALL identifier, anggota, elemen, dan atribut terlarang di kontrak, menyisipkan pemakaian item itu ke Main_File yang valid SHALL menghasilkan sedikitnya satu Diagnostic dengan `severity` `error` (soundness pemindaian kebijakan).
14. FOR ALL Main_File valid pada korpus bagus, THE Animation_Verifier SHALL melaporkan nol galat `POLICY_*` (tanpa false positive pada korpus).
15. WHEN sebuah nama terlarang hanya ter-resolve ke deklarasi `declare` atau deklarasi tipe, THE Animation_Verifier SHALL melaporkan `POLICY_FORBIDDEN_IDENTIFIER`.
16. THE Animation_Verifier SHALL melipat penjumlahan `+` antar literal string, template literal tanpa substitusi, dan `const` berliteral string (kedalaman paling banyak 8) menjadi satu nilai string sebelum menerapkan aturan pada kriteria 6, 8, dan 9.
17. THE Animation_Verifier SHALL melaporkan `POLICY_FORBIDDEN_MEMBER` untuk `Math["random"]`, untuk alias `Math`, dan untuk destructuring `random` dari `Math`.
18. IF `source` melebihi 32768 byte dan juga memuat encoding yang tidak valid, THEN THE Animation_Verifier SHALL melaporkan hanya `SIZE_SOURCE_TOO_LARGE`, dan `source` berukuran tepat 32768 byte SHALL lolos langkah 1.
19. IF jumlah Diagnostic melebihi 50, THEN THE Animation_Verifier SHALL memilih 50 yang dipertahankan dengan mengurutkan error sebelum warning, lalu baris, lalu kolom, dan SHALL mengembalikan hasil pilihan itu dengan urutan pada Requirement 6 kriteria 9.
20. THE Animation_Verifier SHALL melaporkan pemanggilan `require(...)` dan `import x = require()` hanya sebagai `POLICY_DYNAMIC_IMPORT`, dan SHALL melaporkan identifier `require` yang tidak dipanggil sebagai `POLICY_FORBIDDEN_IDENTIFIER`.

### Requirement 8: Verifier, ESLint, typecheck, dan bundle

**User Story:** Sebagai developer, saya ingin lint, typecheck, dan bundle yang ketat, agar berkas yang lolos benar-benar dapat dikompilasi dan dijalankan.

#### Acceptance Criteria

1. THE Animation_Verifier SHALL menjalankan ESLint (flat config, tanpa aturan type-aware) dengan rule set `eslint:recommended` dan `@typescript-eslint/recommended` ditambah plugin lokal `lore` yang menyediakan aturan `lore/no-module-state` (error), `lore/uses-frame` (error, mewajibkan sedikitnya satu pemanggilan `useCurrentFrame`), dan `lore/kit-style` (warning).
2. THE Animation_Verifier SHALL melaporkan setiap temuan ESLint dengan `code` sama dengan `ESLINT_` diikuti id aturan dalam huruf besar, dengan awalan `@` dibuang serta `/` dan `-` diganti `_` (contoh `@typescript-eslint/no-explicit-any` menjadi `ESLINT_TYPESCRIPT_ESLINT_NO_EXPLICIT_ANY`), SHALL memakai `ESLINT_PARSE_ERROR` untuk temuan tanpa id aturan, dan SHALL memetakan severity ESLint 2 ke `error` dan 1 ke `warning`.
3. THE Animation_Verifier SHALL menjalankan compiler TypeScript dengan `noEmit`, `strict` true, `target` `ES2022`, `module` `ESNext`, `moduleResolution` `Bundler`, `lib` `ES2022` dan `DOM`, `skipLibCheck` true, dan `types` kosong, terhadap deklarasi tipe `react` dan `remotion` yang dipin.
4. THE Animation_Verifier SHALL melaporkan setiap galat compiler dengan `code` sama dengan `TSC_` diikuti kode diagnostik numerik dan dengan baris dan kolom berbasis 1.
5. THE Animation_Verifier SHALL membundel dengan esbuild memakai `bundle` true, `format` `cjs`, `platform` `browser`, `target` `es2022`, `minify` false, `sourcemap` false, dan `external` sama dengan `react` dan `remotion`, dengan versi esbuild yang dipin persis.
6. WHEN bundle melebihi 131072 byte, THE Animation_Verifier SHALL melaporkan `BUNDLE_TOO_LARGE`.
7. IF bundle memuat pemanggilan `require` yang argumennya bukan persis literal `react` atau `remotion`, THEN THE Animation_Verifier SHALL melaporkan `BUNDLE_UNEXPECTED_REQUIRE` dengan `severity` `error`, dan THE Test_Suites SHALL menguji kondisi ini dengan memanggil langkah bundle secara langsung, karena langkah 2 sudah menolak impor lain sehingga kondisi ini jarang tercapai lewat pipeline penuh.
8. IF esbuild gagal, THEN THE Animation_Verifier SHALL melaporkan `BUNDLE_FAILED` dengan lokasi galat pertama dan SHALL NOT melempar exception.
9. THE Animation_Verifier SHALL menghasilkan bundle yang identik byte demi byte untuk sumber yang sama dan versi paket yang sama (build yang dapat direproduksi).
10. THE Animation_Verifier SHALL menjalankan ESLint dengan `noInlineConfig` bernilai true, SHALL melaporkan `ESLINT_INLINE_DIRECTIVE` dengan `severity` `error` untuk komentar `eslint-disable`, `eslint-enable`, `eslint-env`, `eslint`, dan `globals`, dan SHALL melaporkan `TSC_SUPPRESSION_DIRECTIVE` dengan `severity` `error` untuk komentar `@ts-ignore`, `@ts-nocheck`, dan `@ts-expect-error`.
11. THE Animation_Verifier SHALL menjalankan aturan `lore/kit-style` untuk melaporkan setiap penyimpangan gaya Kit pada Requirement 1 kriteria 13 sebagai `warning` `ESLINT_LORE_KIT_STYLE` tanpa mengubah nilai `ok`.
12. THE Animation_Verifier SHALL menjalankan aturan `lore/no-module-state` untuk melaporkan `let` dan `var` di level modul serta penugasan `=`, operator majemuk, `++`, dan `--` pada binding level modul (termasuk `obj.x = ...`) di fungsi mana pun, dan SHALL menjalankan aturan `lore/uses-frame` yang menghitung hanya pemanggilan `useCurrentFrame` yang diimpor dari `remotion` (termasuk lewat alias).
13. THE Animation_Verifier SHALL mem-pin `esbuild`, `typescript`, `eslint`, `@typescript-eslint/*`, dan `@types/react` ke versi persis tanpa `^` atau `~` di `animation-verifier/package.json` dan lockfile, dan THE Test_Suites SHALL memuat tes unit yang menegaskan hal itu.
14. THE Animation_Verifier SHALL menghasilkan `bundle` tanpa path absolut dan tanpa `sourceMappingURL`, dengan SHA-256 yang sama untuk dua nilai `absWorkingDir` atau cwd yang berbeda.
15. THE Animation_Verifier SHALL memberi `tool` `eslint`, `tsc`, dan `esbuild` berturut-turut pada Diagnostic berkode `ESLINT_`, `TSC_`, dan `BUNDLE_`, dan fungsi langkah bundle SHALL menerima batas ukuran sebagai argumen sehingga tes dapat memakai `bundle_max_bytes` yang kecil.

### Requirement 9: Verifier, uji render, determinisme, dan performa

**User Story:** Sebagai developer, saya ingin berkas benar-benar dirender pada beberapa frame di lingkungan yang sama dengan runtime, agar kegagalan runtime terdeteksi sebelum penyimpanan.

#### Acceptance Criteria

1. THE Animation_Verifier SHALL mengevaluasi bundle dengan shim `require` yang hanya mengekspos nama yang diizinkan dari `react` dan `remotion` milik paket terpasang di verifier, dan SHALL merender dengan `Thumbnail` dari `@remotion/player` di dalam jsdom, mengikuti pola `frontend/tests/stage/lesson-visual-board.test.tsx`.
2. THE Animation_Verifier SHALL merender himpunan sampel berisi frame 0, `floor(d/4)`, `floor(d/2)`, `floor(3d/4)`, `d - 1`, dan `pauseAtFrame` bila ada, dengan `d` sama dengan `durationInFrames`, tanpa duplikat dan terurut naik.
3. THE Animation_Verifier SHALL merender himpunan sampel untuk kedua kalinya dengan urutan menurun dan SHALL melaporkan `RENDER_NONDETERMINISTIC` bila HTML frame mana pun berbeda dari HTML frame yang sama pada lintasan pertama.
4. WHEN evaluasi bundle atau render sebuah frame melempar exception, atau React melaporkan galat render yang tidak tertangani, THE Animation_Verifier SHALL melaporkan `RENDER_EXCEPTION` dengan `frame=<n>` (atau `frame=evaluate` untuk exception sebelum frame pertama).
5. WHEN `console.error` dipanggil selama render, THE Animation_Verifier SHALL melaporkan `RENDER_CONSOLE_ERROR`, dan WHEN `console.warn` dipanggil, THE Animation_Verifier SHALL melaporkan `RENDER_CONSOLE_WARN` dengan `severity` `warning`.
6. WHEN kontainer sebuah frame sampel memuat lebih dari 600 elemen, THE Animation_Verifier SHALL melaporkan `RENDER_DOM_LIMIT` beserta nomor frame dan jumlahnya.
7. IF kontainer sebuah frame sampel kosong, atau frame terakhir tidak memiliki konten teks, THEN THE Animation_Verifier SHALL melaporkan `RENDER_EMPTY`.
8. WHEN `meta` pada modul yang dieksekusi tidak deep-equal dengan Main_Meta yang dibaca statis, atau ekspor default bukan fungsi, THE Animation_Verifier SHALL melaporkan `RENDER_META_MISMATCH`.
9. WHEN sebuah frame atau evaluasi bundle tidak selesai dalam 2000 ms (tidak termasuk waktu pembuatan jsdom), THE Animation_Verifier SHALL menghentikan Worker, SHALL melaporkan `RENDER_FRAME_TIMEOUT` dengan `frame=<n>` atau `frame=evaluate`, dan SHALL NOT merender frame lain.
10. THE Animation_Verifier SHALL mencatat milidetik per langkah di `summary.checks`, SHALL mengukur total waktu dengan jam monotonik yang dapat diinjeksi sejak masuk handler dan memeriksanya sebelum setiap langkah dan sebelum setiap frame, dan SHALL melaporkan `VERIFIER_DEADLINE` lalu berhenti ketika total waktu berjalan mencapai 50000 ms.
11. THE Animation_Verifier SHALL mengambil `innerHTML`, `textContent`, dan jumlah elemen turunan (termasuk SVG) setiap frame sampel dari lintasan pertama untuk kriteria 3, 6, dan 7 serta Requirement 10, dan SHALL melewati `RENDER_NONDETERMINISTIC` untuk frame yang bergalat.
12. THE Animation_Verifier SHALL menaruh `frame=<n>` (dan `count=<n>` untuk `RENDER_DOM_LIMIT`) di `message` setiap Diagnostic `RENDER_*` yang terkait dengan frame, tanpa `line`, dengan paling banyak satu Diagnostic per `code` dan per frame.
13. WHERE jenisnya `puzzle`, THE Animation_Verifier SHALL menambahkan frame `floor(pauseAtFrame/2)` dan `pauseAtFrame - 1` ke himpunan sampel pada kriteria 2.
14. THE Test_Suites SHALL memanggil langkah 6 dan pemeriksaan deadline secara langsung, dengan jam palsu pada bundle rekayasa, untuk menguji `RENDER_META_MISMATCH`, `RENDER_NONDETERMINISTIC`, `RENDER_CONSOLE_WARN`, dan `VERIFIER_DEADLINE`, karena langkah render hanya berjalan lewat pipeline penuh bila langkah 1 sampai 4 bersih.
15. THE Test_Suites SHALL menegaskan bahwa total `ms` di `summary.checks` tidak melebihi 30000 untuk setiap berkas di `fixtures/good/`.

### Requirement 10: Verifier, gerbang kesetiaan data

**User Story:** Sebagai pelajar, saya ingin animasi menampilkan angka dan label persis seperti data pelajaran, agar animasi tidak mengubah isi pelajaran.

#### Acceptance Criteria

1. THE Animation_Verifier SHALL membandingkan token dengan normalisasi berikut: Unicode NFKC, `toLowerCase()` tanpa locale, dan penghapusan setiap karakter `\s` ECMAScript (termasuk U+FEFF), diterapkan pada token dan pada teks gabungan berurutan sebuah frame, dan sebuah token SHALL dianggap terkandung bila bentuk ternormalisasinya adalah substring dari teks frame ternormalisasi.
2. WHEN sebuah Required_Token tidak terkandung dalam teks frame terakhir (`d - 1`), THE Animation_Verifier SHALL melaporkan `FIDELITY_TOKEN_MISSING` satu kali per token yang hilang.
3. WHERE jenisnya `puzzle`, THE Animation_Verifier SHALL juga mewajibkan setiap Required_Token terkandung dalam teks frame `pauseAtFrame`, dan SHALL melaporkan `FIDELITY_TOKEN_MISSING` yang `message`-nya memuat nomor frame `pauseAtFrame` bila token hilang di frame itu, digabung dengan kriteria 2 menjadi satu Diagnostic per token (token yang hilang di kedua frame tetap menghasilkan satu Diagnostic).
4. WHERE jenisnya `puzzle`, WHEN sebuah Forbidden_Token terkandung dalam teks frame sampel mana pun yang nomornya kurang dari atau sama dengan `pauseAtFrame`, THE Animation_Verifier SHALL melaporkan `FIDELITY_FORBIDDEN_TOKEN_VISIBLE`.
5. THE Animation_Verifier SHALL membuang dari Forbidden_Tokens setiap token yang juga ada di Required_Tokens (setelah normalisasi) dan SHALL mencatat setiap pembuangan sebagai Diagnostic dengan `code` `FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED` dan `severity` `warning`.
6. THE Animation_Verifier SHALL NOT menerapkan aturan Forbidden_Token pada frame setelah `pauseAtFrame`, sehingga jawaban boleh diungkap setelah jawaban benar.
7. FOR ALL daftar Required_Token ternormalisasi yang tidak kosong, unik, dan tanpa substring antartoken, Main_File yang teks frame akhirnya (dan teks frame `pauseAtFrame` untuk `puzzle`) berupa gabungan token berspasi SHALL menghasilkan nol Diagnostic `FIDELITY_TOKEN_MISSING`, dan membuang satu token mana pun dari teks yang dirender SHALL menghasilkan tepat satu Diagnostic seperti itu untuk token tersebut.
8. THE Animation_Verifier SHALL menurunkan teks frame dari `textContent` kontainer dengan mengecualikan subtree elemen `title`, `desc`, `style`, dan elemen yang style inline-nya `display: none`, `visibility: hidden`, atau `opacity: 0`.
9. THE Animation_Verifier SHALL mengabaikan token yang kosong setelah normalisasi tanpa membuat Diagnostic.
10. WHERE jenisnya `puzzle`, WHEN bentuk ternormalisasi sebuah Forbidden_Token adalah substring dari bentuk ternormalisasi sebuah Required_Token, THE Animation_Verifier SHALL menghapus semua kemunculan Required_Token itu (yang terpanjang lebih dulu) dari teks frame ternormalisasi sebelum mencocokkan Forbidden_Token.
11. THE Animation_Verifier SHALL melaporkan `FIDELITY_TOKEN_MISSING` dan `FIDELITY_FORBIDDEN_TOKEN_VISIBLE` dengan `tool` `fidelity`, `severity` `error`, satu Diagnostic per token, dan `message` yang memuat 80 karakter pertama token serta nomor frame.
12. THE Animation_Verifier SHALL mengurutkan Diagnostic `FIDELITY_*` menurut `code` dengan urutan `FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED`, `FIDELITY_TOKEN_MISSING`, lalu `FIDELITY_FORBIDDEN_TOKEN_VISIBLE`, dan di dalam satu `code` menurut urutan token pada masukan.
13. THE Test_Suites SHALL memuat fixture bersama berisi sedikitnya 20 vektor normalisasi (termasuk U+FEFF, U+200B, dan `İ`) yang menghasilkan keluaran identik pada Pytest (`required_tokens`) dan pada Vitest (verifier).

### Requirement 11: Isolasi dan batas sumber daya eksekusi verifier

**User Story:** Sebagai pemilik sistem, saya ingin kode buatan LLM yang dieksekusi verifier terkurung dan terbatas, agar loop tak berujung, memori besar, atau akses jaringan tidak membahayakan.

#### Acceptance Criteria

1. THE Animation_Verifier SHALL mengeksekusi langkah render di dalam Worker Node `worker_threads` yang dibuat dengan `resourceLimits` `maxOldGenerationSizeMb` sebesar 512 dan `env` kosong, dan thread induk SHALL menghentikan Worker bila tidak ada pesan kemajuan selama 2000 ms.
2. THE Animation_Verifier SHALL mengevaluasi bundle di dalam konteks `vm` yang dibuat dengan `codeGeneration` untuk string dan WebAssembly dinonaktifkan, dan yang objek globalnya tidak mengekspos `process`, `Buffer`, `require` Node, `fs`, maupun API jaringan.
3. WHEN mengevaluasi atau merender bundle menghabiskan heap Worker, THE Animation_Verifier SHALL melaporkan `RENDER_RESOURCE_LIMIT` dan SHALL mengembalikan Verifier_Result alih-alih membuat proses Lambda crash.
4. THE Verifier_Lambda SHALL berjalan dengan memori 1536 MB dan timeout 60 detik, dengan `vpc_config` hanya pada subnet `data_a` dan `data_b`, security group tanpa rule ingress dan egress (Requirement 34 kriteria 8), tanpa secret, tanpa blok `environment` yang berkunci cocok dengan `(?i)(key|secret|token|password|credential)`, dan dengan `process.env` Worker kosong (runtime Lambda sendiri menyuntikkan kredensial role; yang dilarang adalah variabel yang didefinisikan Animation_Infra, dan Worker tidak melihat env apa pun).
5. THE Verifier_Lambda SHALL dieksekusi dengan role eksekusi yang hanya mengizinkan `logs:CreateLogStream` dan `logs:PutLogEvents` pada ARN log group miliknya serta lima aksi `ec2:` pada Requirement 34 kriteria 9, tanpa `logs:CreateLogGroup` dan tanpa managed policy.
6. THE Animation_Verifier SHALL menulis ke stdout tepat satu baris log JSON terstruktur per invokasi (baris platform Lambda dikecualikan) yang memuat `request_id` (AWS request id), `ok`, milidetik per langkah, dan jumlah Diagnostic per `code`, dan SHALL NOT menulis sumber, bundle, token, atau pesan Diagnostic apa pun.
7. WHEN thread induk menghentikan Worker, THE Animation_Verifier SHALL mengembalikan Verifier_Result `ok` `false` dalam 1000 ms sejak keputusan itu, dan SHALL memakai Worker dan konteks `vm` baru pada invokasi berikutnya di proses yang sama (tes: sumber `for(;;){}` diikuti fixture bagus secara berurutan).
8. THE Animation_Verifier SHALL mengirim pesan kemajuan dari Worker sebelum evaluasi bundle serta sebelum dan sesudah setiap frame sampel, dan IF thread induk tidak menerima pesan selama 2000 ms, THEN THE Animation_Verifier SHALL melaporkan `RENDER_FRAME_TIMEOUT` dengan nomor frame yang sedang berjalan atau `evaluate`.
9. WHILE langkah render berjalan, IF RSS proses melebihi 1200 MB (diperiksa setiap 50 ms), THEN THE Animation_Verifier SHALL menghentikan Worker dan melaporkan `RENDER_RESOURCE_LIMIT` (tes: `new Uint8Array(1.4e9).fill(1)`).
10. THE Test_Suites SHALL memuat bundle uji yang memanggil `require('react').createElement['con'+'structor']('return Object.keys(process.env).length')()` dan menegaskan hasilnya 0 atau `RENDER_EXCEPTION`, dan THE Docs_Set SHALL mendokumentasikan bahwa `vm` bukan batas keamanan, sedangkan batas keamanannya adalah isolasi Lambda (microVM, tanpa egress, tanpa secret).
11. THE Animation_Verifier SHALL menangkap semua pemanggilan `console.log`, `console.info`, `console.debug`, `console.warn`, dan `console.error` oleh bundle tanpa menulis satu byte pun ke stdout atau stderr (tes: 1000 pemanggilan dengan string sentinel menghasilkan keluaran hanya berupa satu baris JSON).
12. FOR ALL nama dalam himpunan {`process`, `Buffer`, `fs`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `WebAssembly`}, `typeof` nama itu di global konteks `vm` SHALL bernilai `undefined`, dan `require` untuk modul selain `react` dan `remotion` SHALL melempar exception (jsdom hanya dipakai sebagai host DOM, dan API jaringannya dihapus dari global yang terlihat oleh bundle).

### Requirement 12: Penurunan Required_Tokens dan Forbidden_Tokens

**User Story:** Sebagai pelajar, saya ingin gerbang kesetiaan data memakai daftar token yang diturunkan secara objektif dari data pelajaran, agar pemeriksaan tidak bergantung pada tafsiran.

#### Acceptance Criteria

1. THE Animation_Prompts SHALL menyediakan fungsi murni `required_tokens(request)` yang mengembalikan judul verbatim diikuti setiap nilai teks pada objek `visual`: untuk semua jenis `caption`; untuk `vectors` setiap `label` vektor dan setiap `label` titik; untuk `plot` `x_label`, `y_label`, dan setiap `label` seri; untuk `diagram` setiap `label` dan `detail` node serta setiap `label` edge; untuk `table` setiap header dan setiap sel yang tidak kosong; untuk `formula` `expression`, setiap `symbol` dan `meaning` term, serta `example`.
2. THE `required_tokens` SHALL membuang nilai yang kosong setelah normalisasi pada Requirement 10 dan duplikat menurut bentuk ternormalisasi, SHALL mengembalikan string asli kemunculan pertama tanpa trim tambahan, SHALL mempertahankan urutan kemunculan pertama, dan SHALL deterministik, sehingga dua pemanggilan dengan request yang sama mengembalikan daftar yang sama; Required_Token yang bentuk utuhnya (setelah trim, tanpa memperhatikan huruf besar-kecil) berupa hex 3, 4, 6, atau 8 digit, diawali `rgb(`, `rgba(`, `hsl(`, atau `hsla(`, atau diawali skema URL terlarang pada Requirement 1 kriteria 11, SHALL dikeluarkan dari Required_Tokens dan dilaporkan terpisah sebagai `skipped_tokens` yang dicatat pada Animation_Manifest.
3. THE `required_tokens` SHALL NOT menyertakan koordinat numerik visual `vectors` dan `plot`, karena nilai itu digambar dan belum tentu ditulis sebagai teks (keterbatasan gerbang kesetiaan yang didokumentasikan).
4. THE Animation_Prompts SHALL menyediakan fungsi murni `effective_forbidden_tokens(request, required)` yang mengembalikan `forbidden_tokens` request tanpa token yang sama dengan Required_Token setelah normalisasi, tanpa duplikat, dengan urutan dipertahankan.
5. THE Animation_Agent SHALL memberikan Required_Tokens yang sama dan Forbidden_Tokens efektif yang sama ke prompt dan ke Verifier_Lambda pada setiap percobaan dalam satu run.
6. FOR ALL request valid dengan objek `visual` yang valid, setiap string tak kosong (setelah normalisasi) pada field `caption`, `label`, `x_label`, `y_label`, `detail`, header, sel, `symbol`, `meaning`, `expression`, `example`, serta `title` request SHALL memiliki bentuk ternormalisasi yang sama dengan sedikitnya satu elemen `required_tokens` atau `skipped_tokens` (properti cakupan).
7. THE `effective_forbidden_tokens` SHALL membuang token yang kosong setelah normalisasi dan duplikat (mempertahankan string asli kemunculan pertama), sehingga `["  ","Ya","ya"]` menghasilkan `["Ya"]`.
8. THE `effective_forbidden_tokens` SHALL membuang Forbidden_Token yang bentuk ternormalisasinya adalah substring dari Required_Token mana pun, sehingga `["4"]` dengan judul `Pick 4 items` menghasilkan `[]`.
9. FOR ALL request valid, `required_tokens` SHALL mengembalikan paling banyak 68 string yang masing-masing paling banyak 200 karakter (diuji dengan tabel 6 kolom x 10 baris berisi nilai terpanjang).
10. THE `required_tokens` SHALL mengurutkan hasil menurut judul, `caption`, lalu field khusus jenis sesuai urutan pada kriteria 1, dengan per elemen `label` lalu `detail` (node) dan `symbol` lalu `meaning` (term), dan untuk tabel header lalu sel per baris dari kiri ke kanan; THE Test_Suites SHALL mencocokkan urutan itu dengan fixture emas di `backend/tests/fixtures/animation/` untuk kelima jenis `visual`.
11. FOR ALL request valid pada sedikitnya 40 benih, `effective_forbidden_tokens` SHALL mengembalikan himpunan bagian dari `forbidden_tokens` request, SHALL NOT memutasi request, dan SHALL NOT mengembalikan elemen yang sama dengan atau menjadi substring dari Required_Token ternormalisasi.

### Requirement 13: Animation_Agent, graf LangGraph generate, verify, repair

**User Story:** Sebagai pemilik sistem, saya ingin agent dengan loop terbatas yang selalu berhenti, agar biaya Gemini dan Lambda terkendali dan hasilnya selalu lolos verifikasi atau gagal dengan kode yang jelas.

#### Acceptance Criteria

1. THE Animation_Agent SHALL dibangun sebagai `StateGraph` LangGraph dengan node `generate`, `verify`, `repair`, `publish`, dan `fail`, dikompilasi sekali ketika run animasi pertama membutuhkannya dan tidak pernah bila Flag_Api false (Requirement 41 kriteria 1), tanpa checkpointer, dengan state run disimpan di memori selama satu request.
2. THE Animation_Agent SHALL menghubungkan node sebagai: awal ke `generate`; `generate` ke `verify`; `verify` ke `publish` bila Verifier_Result memiliki `ok` true; `verify` ke `repair` bila `ok` false, jumlah Gemini_Call di bawah batas percobaan, dan waktu masih tersisa; `verify` ke `fail` untuk kondisi lain; `repair` ke `verify`; `publish` dan `fail` ke akhir.
3. THE Animation_Agent SHALL menentukan routing setelah `verify` dengan fungsi murni dari `ok`, jumlah Gemini_Call, batas percobaan, dan milidetik tersisa.
4. THE Animation_Agent SHALL menetapkan batas percobaan dari `ANIMATION_MAX_ATTEMPTS` dengan aturan: bilangan bulat 1 sampai 4 dipakai apa adanya, nilai di atas 4 menjadi 4, dan nilai yang hilang, bukan bilangan bulat, atau kurang dari 1 menjadi 4; THE Animation_Agent SHALL melakukan paling banyak sejumlah batas itu Gemini_Call per run (satu `generate` dan paling banyak tiga `repair`), dengan hitungan bertambah saat sebuah Gemini_Call dimulai.
5. THE Animation_Agent SHALL menegakkan deadline total `ANIMATION_DEADLINE_MS` (default 240000, dijepit ke rentang 1 sampai 240000) yang diukur dengan jam monotonik yang dapat diinjeksi sejak run dimulai, SHALL memastikan event akhir SSE tiba paling lambat `ANIMATION_DEADLINE_MS` ditambah 10000 ms setelah event `started`, dan SHALL NOT memulai Gemini_Call, verifikasi, atau unggahan bila sisa waktu 0 atau kurang.
6. WHEN deadline tercapai, THE Animation_Agent SHALL mengakhiri run di `fail` dengan kode `ANIMATION_TIMEOUT`.
7. IF `extract_main_ts` tidak mengembalikan kode, THEN THE Animation_Agent SHALL menghitung percobaan itu gagal dengan Diagnostic ber-`tool` `agent` dan `code` `AGENT_EXTRACT_NO_CODE`, SHALL melewati pemanggilan verifier, dan SHALL melakukan routing sebagai verifikasi gagal, yang mengarah ke `repair` dengan sumber sebelumnya kosong bila percobaan masih tersisa.
8. IF SHA-256 byte UTF-8 sumber hasil `repair` (setelah normalisasi `extract_main_ts`) sama dengan SHA-256 sumber sebelumnya, THEN THE Animation_Agent SHALL melewati pemanggilan verifier, SHALL mencatat Diagnostic dengan `tool` `agent`, `code` `AGENT_REPAIR_UNCHANGED`, dan `severity` `error`, dan SHALL melakukan routing sebagai verifikasi gagal.
9. IF sebuah Gemini_Call mengembalikan `GeminiFailure`, THEN THE Animation_Agent SHALL mengakhiri run di `fail` tanpa percobaan lanjutan, dengan memetakan `RATE_LIMITED` ke `RATE_LIMITED`, `TIMEOUT` ke `ANIMATION_TIMEOUT`, dan `PROVIDER_UNAVAILABLE` ke `PROVIDER_UNAVAILABLE`.
10. WHEN batas percobaan tercapai, sisa waktu lebih dari 0, dan verifikasi terakhir gagal, THE Animation_Agent SHALL mengakhiri run di `fail` dengan kode `ANIMATION_VERIFICATION_FAILED` dan SHALL menyimpan semua Diagnostic verifikasi terakhir (paling banyak 50) di state.
11. THE Animation_Agent SHALL mengakhiri setiap run di tepat satu state akhir, yaitu `published` dengan sebuah Animation_Reference atau `failed` dengan satu kode dari himpunan tertutup `ANIMATION_VERIFICATION_FAILED`, `ANIMATION_TIMEOUT`, `ANIMATION_VERIFIER_UNAVAILABLE`, `ANIMATION_STORAGE_FAILED`, `ANIMATION_QUOTA_EXCEEDED`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `UNKNOWN`.
12. FOR ALL urutan hasil dari klien Gemini palsu dan verifier palsu (sukses, gagal, exception, tunda), THE Animation_Agent SHALL berhenti, SHALL melakukan tidak lebih dari batas percobaan Gemini_Call, dan SHALL NOT memulai langkah apa pun setelah deadline (properti terminasi).
13. THE Animation_Agent SHALL menentukan routing setelah `verify` dengan urutan keputusan berikut: sisa waktu 0 atau kurang menuju `fail` dengan `ANIMATION_TIMEOUT`; `ok` true menuju `publish`; jumlah Gemini_Call di bawah batas percobaan menuju `repair`; selain itu menuju `fail` dengan `ANIMATION_VERIFICATION_FAILED`, dan THE Test_Suites SHALL memuat tes tabel yang mencakup semua kombinasi masukan.
14. IF `publish` gagal, THEN THE Animation_Agent SHALL mengakhiri run di `fail` dengan `ANIMATION_STORAGE_FAILED` atau `ANIMATION_QUOTA_EXCEEDED` sesuai penyebabnya, dan SHALL NOT melakukan Gemini_Call atau verifikasi lagi.
15. WHEN run dibatalkan, THE Animation_Agent SHALL NOT memulai unggahan, penyisipan registry, atau pengiriman event, dan SHALL mengakhiri run di `failed` dengan `UNKNOWN` internal yang tidak dikirim ke klien.
16. THE Animation_Agent SHALL menyetel `attempts` pada event `done`, event `error`, Animation_Manifest, dan Animation_Registry sama dengan jumlah Gemini_Call yang dimulai (0 sampai 4), dan `model` sama dengan model dari Gemini_Call yang menghasilkan sumber yang dipublikasikan.
17. WHEN verifier dilewati menurut kriteria 7 atau 8, THE Animation_Agent SHALL memancarkan tepat satu event `diagnostics` dengan `ok` `false`, `error_count` 1, dan `items` `[{tool: "agent", code}]`.
18. IF `GeminiFailure` ber-`code` `OUTPUT_PARSE_FAILED` atau exception tak terduga terjadi di node mana pun, THEN THE Animation_Agent SHALL mengakhiri run di `failed` dengan `UNKNOWN`.

### Requirement 14: Pemanggilan Verifier_Lambda, klasifikasi kegagalan, dan pembatalan

**User Story:** Sebagai pemilik sistem, saya ingin pemanggilan Lambda yang membedakan "kode salah" dari "verifier tidak tersedia", agar kegagalan infrastruktur tidak membakar token Gemini.

#### Acceptance Criteria

1. THE Animation_Agent SHALL memanggil Verifier_Lambda lewat klien Lambda `boto3` dengan `InvocationType` `RequestResponse`, nama fungsi dari `ANIMATION_VERIFIER_FUNCTION`, region dari `AWS_REGION`, `connect_timeout` 5 detik, `read_timeout` 75 detik, dan mode retry `standard` dengan `max_attempts` 2, dibuat sekali dan dipakai ulang.
2. THE Animation_Agent SHALL menjalankan setiap pemanggilan `boto3` yang memblokir lewat `asyncio.to_thread`, SHALL menunggu paling lama sisa deadline pada saat pemanggilan dimulai (diukur dengan jam monotonik yang dapat diinjeksi), dan SHALL NOT memulai invokasi bila sisa waktu 0 atau kurang, sehingga event loop tidak pernah terblokir (tes: tugas lain di event loop tetap berjalan selama invoke palsu memblokir 1 detik).
3. IF invokasi tidak mengembalikan `FunctionError` dan payload kosong, bukan JSON, atau gagal validasi dengan model Pydantic yang sama dengan bentuk Verifier_Result, THEN THE Animation_Agent SHALL mengakhiri run di `fail` dengan `ANIMATION_VERIFIER_UNAVAILABLE` tanpa Gemini_Call lagi.
4. IF invokasi mengembalikan `FunctionError`, THEN THE Animation_Agent SHALL mencatat Diagnostic dengan `tool` `verifier`, `code` `VERIFIER_CRASH`, `severity` `error`, tanpa `line`, dan dengan `message` tetap yang tidak memuat `errorMessage` atau `stackTrace`, dan SHALL memperlakukan percobaan itu sebagai verifikasi gagal yang dihitung terhadap batas percobaan.
5. IF invokasi melempar galat setelah retry klien (throttling, galat layanan, kegagalan jaringan, atau akses ditolak), THEN THE Animation_Agent SHALL mengakhiri run di `fail` dengan `ANIMATION_VERIFIER_UNAVAILABLE` dan SHALL NOT melakukan Gemini_Call lagi.
6. IF Verifier_Result memuat Diagnostic `VERIFIER_CONTRACT_MISMATCH` atau `VERIFIER_BAD_INPUT`, THEN THE Animation_Agent SHALL mengakhiri run di `fail` dengan `ANIMATION_VERIFIER_UNAVAILABLE`, karena repair tidak dapat memperbaiki ketidakcocokan deployment.
7. WHEN run dibatalkan, THE Animation_Agent SHALL NOT memulai Gemini_Call atau invokasi lagi, SHALL membatalkan request HTTP Gemini yang sedang berjalan dalam 1 detik, dan SHALL membiarkan invokasi Lambda yang sedang berjalan selesai dalam timeout fungsi 60 detik tanpa memakai hasilnya.
8. THE Animation_Agent SHALL mencatat di log hanya nama endpoint, nomor percobaan, nilai `tool` dan `code` Diagnostic, jumlah, dan milidetik berjalan, dan SHALL NOT mencatat kode sumber, prompt, API key, Required_Tokens, atau pesan Diagnostic.
9. IF deadline habis saat invokasi berjalan, THEN THE Animation_Agent SHALL mengakhiri run di `fail` dengan `ANIMATION_TIMEOUT` (bukan `ANIMATION_VERIFIER_UNAVAILABLE`), SHALL membuang hasil invokasi, dan SHALL NOT menulis ke S3 atau Animation_Registry.
10. IF Verifier_Result memuat Diagnostic `VERIFIER_INTERNAL`, THEN THE Animation_Agent SHALL mengakhiri run di `fail` dengan `ANIMATION_VERIFIER_UNAVAILABLE` tanpa Gemini_Call lagi.
11. IF Verifier_Result memuat Diagnostic `VERIFIER_DEADLINE`, THEN THE Animation_Agent SHALL memperlakukannya sebagai verifikasi gagal yang dihitung terhadap batas percobaan, bukan sebagai `ANIMATION_VERIFIER_UNAVAILABLE`.
12. THE Animation_Agent SHALL mengirim ke Verifier_Lambda payload yang berisi tepat lima kunci `source`, `kind`, `required_tokens`, `forbidden_tokens`, dan `contract_version`, dengan token yang identik pada setiap percobaan dalam satu run dan `contract_version` dari salinan Animation_Contract milik Backend.
13. WHEN run dibatalkan saat invokasi berjalan, THE Animation_Agent SHALL mengakhiri run dalam 1 detik tanpa menunggu invokasi selesai dan tanpa menulis ke S3 atau Animation_Registry, dan `AiLimiter.in_flight()` SHALL kembali ke nilai sebelum request (diuji dengan invoke palsu yang memblokir 5 detik).

### Requirement 15: Animation_Endpoint dan Entry_Guard bersama

**User Story:** Sebagai developer backend, saya ingin endpoint streaming memakai pemeriksaan pintu masuk yang sama dengan endpoint JSON, agar perilaku keamanan dan batas tidak terduplikasi atau menyimpang.

#### Acceptance Criteria

1. THE Animation_Endpoint SHALL berupa `POST /api/v1/ai/animations`, didaftarkan di router AI yang ada dengan `include_in_schema=False`, dideklarasikan tanpa parameter body sehingga batas body berjalan sebelum parsing apa pun, dan tercakup oleh `device_token_middleware` yang ada.
2. THE `CreateAnimationRequest` SHALL memuat `kind` (`lesson` atau `puzzle`), `title` (1 sampai 200 karakter setelah di-trim), `text` (1 sampai 2000 karakter), `concepts` (0 sampai 5 string masing-masing 1 sampai 80 karakter), `visual` (valid menurut `parse_lesson_visual`), `language` (`en` atau `id`), dan `forbidden_tokens` (0 sampai 8 string masing-masing 1 sampai 80 karakter, diterima hanya bila `kind` adalah `puzzle`), dan skema Zod di `frontend/src/lib/contracts/animation-requests.ts` SHALL menerima dan menolak masukan yang sama.
3. IF request melanggar model, THEN THE Animation_Endpoint SHALL menjawab HTTP 400 dengan `INVALID_REQUEST` dan `detail` kompatibel Zod, dan WHEN body melebihi 65536 byte, THE Animation_Endpoint SHALL menjawab HTTP 413 dengan `INVALID_REQUEST`.
4. THE Entry_Guard SHALL diekstrak dari `backend/app/ai/pipeline.py` sebagai satu fungsi yang menjalankan, berurutan, pemeriksaan rate per menit, pembacaan body berbatas, parsing JSON, validasi model, dan pemeriksaan provider siap, dan mengembalikan `AiError` atau request yang diterima, dan `handle_ai_request` SHALL ditulis ulang di atasnya tanpa mengubah respons, status, header, atau urutan pemeriksaan apa pun.
5. THE Test_Suites SHALL mempertahankan setiap berkas tes AI backend yang ada tanpa diubah dan tetap lulus setelah ekstraksi Entry_Guard, dan SHALL memuat tes baru yang menegaskan dengan spy urutan panggilan bahwa handler JSON dan handler streaming memanggil fungsi Entry_Guard yang sama.
6. THE Animation_Endpoint SHALL menerapkan pemeriksaan dengan urutan berikut dan berhenti pada kegagalan pertama: rate limit, body, JSON, model request, `PROVIDER_NOT_CONFIGURED` (HTTP 503), `ANIMATION_NOT_CONFIGURED` (HTTP 503; mencakup Flag_Api false, env `ANIMATION_BUCKET`, `ANIMATION_VERIFIER_FUNCTION`, atau `AWS_REGION` kosong, salinan Animation_Contract tidak valid, dan engine database tidak ada), pencarian idempoten (Idempotent_Hit melewati tiga langkah berikutnya), kuota per owner (HTTP 422), slot serentak (HTTP 429), kuota harian (HTTP 429, dengan slot dilepas), lalu stream; Animation_Endpoint SHALL memakai `app.state.animation_limiter`, terpisah dari `app.state.ai_limiter`.
7. WHILE sebuah stream berjalan, THE Animation_Endpoint SHALL menahan slot serentak, dan SHALL melepasnya tepat sekali (jumlah `try_acquire` yang berhasil sama dengan jumlah `release`) untuk setiap hasil akhir: selesai normal, galat, pembatalan, klien terputus, respons yang generator-nya tidak pernah diiterasi, penolakan kuota harian, dan exception tak terduga, sehingga `AiLimiter.in_flight()` kembali ke nilai sebelum request.
8. THE Animation_Endpoint SHALL menjalankan setiap pemanggilan database dan `boto3` di luar event loop.
9. WHEN klien putus disimulasikan lewat ASGI test client dan `device_token_middleware`, THE Animation_Endpoint SHALL membatalkan agent dalam 1 detik, dan IF itu tidak dapat dicapai dengan `BaseHTTPMiddleware` saat ini, THEN `device_token_middleware` SHALL diganti dengan middleware ASGI murni berperilaku cookie identik dan tes yang ada identik.
10. IF terjadi exception tak terduga sebelum stream dimulai, THEN THE Animation_Endpoint SHALL menjawab HTTP 500 dengan `UNKNOWN` dan `message` tetap yang tidak memuat nama kelas, path, atau teks exception; IF terjadi exception tak terduga setelah stream dimulai dan event akhir belum terkirim, THEN THE Animation_Endpoint SHALL mengirim tepat satu event `error` dengan kode `UNKNOWN`; IF terjadi exception tak terduga setelah event akhir terkirim, THEN THE Animation_Endpoint SHALL NOT mengirim event lagi.
11. THE Backend SHALL memasukkan `/api/v1/animations` ke `PROTECTED_PREFIXES` di `backend/app/owner.py`, agar cookie `lore_device` terbaca dan terbit untuk endpoint baca.
12. THE `CreateAnimationRequest` SHALL mengukur panjang setiap string dalam unit kode UTF-16 dan SHALL men-trim `title` dengan `js_trim`, THE Test_Suites SHALL memuat satu fixture bersama (berisi emoji di batas 200 karakter `title` dan di batas 80 karakter pada `concepts` dan `forbidden_tokens`) yang memberi keputusan sama di Pydantic dan di Zod, dan IF sebuah string pada body mengandung surrogat tunggal (misalnya `\ud800`), THEN THE Animation_Endpoint SHALL menjawab HTTP 400 dengan `INVALID_REQUEST` sebelum Request_Hash dihitung.
13. IF `kind` bernilai `lesson` dan `forbidden_tokens` berisi sedikitnya 1 entri, THEN THE Animation_Endpoint SHALL menjawab HTTP 400 dengan `INVALID_REQUEST`, dan THE `CreateAnimationRequest` SHALL memperlakukan `forbidden_tokens` yang hilang sebagai `[]` sehingga Request_Hash sama dengan request yang mengirim `forbidden_tokens` `[]`.
14. THE Entry_Guard SHALL memakai limiter yang diberikan pemanggilnya, sehingga request ke Animation_Endpoint hanya mengubah `app.state.animation_limiter` dan request ke endpoint AI JSON hanya mengubah `app.state.ai_limiter`, dan THE Test_Suites SHALL menegaskannya lewat `in_flight()` dan jendela rate kedua instance.
15. IF salah satu pemeriksaan pada kriteria 6 menolak request sebelum stream dimulai, THEN THE Animation_Endpoint SHALL menjawab dengan envelope JSON non-200 berheader `Cache-Control: no-store` dan bukan `text/event-stream`, dan SHALL membiarkan `AiLimiter.in_flight()` pada nilai sebelum request.
16. FOR ALL pasangan pemeriksaan pada kriteria 6 yang gagal bersamaan, THE Animation_Endpoint SHALL menjawab dengan kode dan status pemeriksaan yang lebih awal pada urutan itu, diuji dengan tes parametris atas semua pasangan.
17. WHILE fungsi database atau klien `boto3` palsu yang disuntikkan memblokir selama 500 ms, THE Animation_Endpoint SHALL membiarkan ticker pada event loop yang sama tertunda tidak lebih dari 100 ms, diuji dengan tes yang mengukur penundaan terbesar ticker.

### Requirement 16: Batas, kuota, konfigurasi, dan status kesehatan

**User Story:** Sebagai pemilik sistem, saya ingin batas penggunaan dan konfigurasi animasi terpisah dari AI JSON, agar biaya Gemini dan Lambda terkendali dan fitur dapat dimatikan.

#### Acceptance Criteria

1. THE Backend SHALL membaca nilai env `ANIMATION_RATE_PER_MINUTE_IP` (default 4), `ANIMATION_DAILY_PER_IP` (default 30), `ANIMATION_MAX_CONCURRENT_PER_IP` (default 1), `ANIMATION_MAX_CONCURRENT_GLOBAL` (default 2), `ANIMATION_MAX_ATTEMPTS` (default 4), dan `ANIMATION_DEADLINE_MS` (default 240000), SHALL menganggap sah hanya nilai berupa string digit ASCII yang bernilai 1 atau lebih setelah di-trim, dan SHALL memakai default bila nilai hilang atau tidak sah; `ANIMATION_MAX_ATTEMPTS` SHALL mengikuti aturan Requirement 13 kriteria 4 (nilai sah di atas 4 menjadi 4), dan `ANIMATION_DEADLINE_MS` SHALL dijepit ke maksimum 240000.
2. THE Backend SHALL membaca `ANIMATION_ENABLED` (default `false`, true hanya untuk nilai `true` tanpa memperhatikan huruf besar-kecil), `ANIMATION_BUCKET`, `ANIMATION_VERIFIER_FUNCTION`, dan `AWS_REGION` sebagai string tidak kosong.
3. THE Animation_Limiter SHALL berupa instance `AiLimiter` yang disimpan di `app.state.animation_limiter`, terpisah dari `app.state.ai_limiter`, dengan batas per menit per owner sama dengan `ANIMATION_RATE_PER_MINUTE_IP`.
4. IF `ANIMATION_ENABLED` tidak true, atau `ANIMATION_BUCKET`, `ANIMATION_VERIFIER_FUNCTION`, atau `AWS_REGION` kosong, atau salinan Animation_Contract tidak valid (Requirement 2 kriteria 10), atau engine database tidak ada, THEN THE Animation_Endpoint SHALL menjawab HTTP 503 dengan `ANIMATION_NOT_CONFIGURED`.
5. IF key Gemini tidak dikonfigurasi, THEN THE Animation_Endpoint SHALL menjawab HTTP 503 dengan `PROVIDER_NOT_CONFIGURED` yang sudah ada.
6. THE Backend SHALL menambahkan ke peta status envelope pemetaan `ANIMATION_NOT_CONFIGURED` ke 503, `ANIMATION_QUOTA_EXCEEDED` ke 422, `ANIMATION_VERIFICATION_FAILED` ke 422, `ANIMATION_TIMEOUT` ke 503, `ANIMATION_VERIFIER_UNAVAILABLE` ke 503, dan `ANIMATION_STORAGE_FAILED` ke 503, tanpa mengubah pemetaan yang sudah ada.
7. WHEN batas per menit, kuota harian, atau slot serentak (per IP atau global) menolak request, THE Animation_Endpoint SHALL menjawab HTTP 429 dengan `RATE_LIMITED`, cakupan di `detail`, dan header `Retry-After`, memakai `denied_to_error` yang sudah ada.
8. THE Animation_Endpoint SHALL menghitung kuota harian dan mengambil slot serentak hanya ketika run agent dimulai, dan SHALL NOT menghitungnya untuk request yang gagal validasi, mengenai cache idempoten, atau ditolak pemeriksaan sebelumnya.
9. THE `/health/ai` SHALL mengembalikan `{"configured": <bool>, "animation": {"enabled": <bool>, "configured": <bool>}}`, dengan `configured` tidak berubah, dan SHALL NOT memanggil Gemini atau AWS.
10. THE Animation_Limiter SHALL menerima jam monotonik dan jam dinding yang diinjeksi, sehingga Test_Suites menjalankannya dengan jam palsu seperti pada `AiLimiter` yang sudah ada.
11. IF kriteria 4 dan kriteria 5 sama-sama berlaku, THEN THE Animation_Endpoint SHALL menjawab HTTP 503 dengan `PROVIDER_NOT_CONFIGURED`, karena pemeriksaan provider mendahului pemeriksaan konfigurasi animasi pada urutan di Requirement 15 kriteria 6.
12. THE `/health/ai` SHALL mengembalikan `animation.enabled` true hanya bila `ANIMATION_ENABLED` true, dan `animation.configured` true hanya bila `animation.enabled` true, `ANIMATION_BUCKET`, `ANIMATION_VERIFIER_FUNCTION`, dan `AWS_REGION` tidak kosong, dan engine database ada.
13. WHEN Animation_Limiter menolak request, THE Animation_Endpoint SHALL mengisi `detail.scope` dengan salah satu dari `ip`, `owner`, `daily`, `concurrency-ip`, dan `concurrency-global`, dan SHALL mengisi `Retry-After` dengan bilangan bulat 1 atau lebih, yaitu tepat 5 untuk kedua scope `concurrency-*`.
14. IF kuota harian menolak request setelah slot serentak diambil, THEN THE Animation_Endpoint SHALL melepas slot itu sehingga `AiLimiter.in_flight()` kembali ke nilai sebelum request.
15. THE Animation_Limiter SHALL mencatat hitungan per menit untuk setiap request ke Animation_Endpoint, termasuk request yang gagal validasi dan Idempotent_Hit, dan SHALL NOT berbagi hitungan dengan `app.state.ai_limiter`.

### Requirement 17: Protokol SSE

**User Story:** Sebagai developer frontend, saya ingin aliran kejadian yang tetap dan dapat diuraikan tanpa ambiguitas, agar UI menampilkan progres dan hasil akhir dengan benar.

#### Acceptance Criteria

1. THE Animation_Endpoint SHALL menjawab request yang diterima dengan HTTP 200, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform`, dan `X-Accel-Buffering: no`.
2. THE Animation_Endpoint SHALL menulis setiap event sebagai `event: <nama>` dan `data: <JSON satu baris>` diikuti baris kosong, dengan JSON diserialisasi tanpa baris baru dan dengan karakter non-ASCII tidak di-escape.
3. THE Animation_Endpoint SHALL mengirim event `started` dengan `{max_attempts, deadline_ms, cached}`; `stage` dengan `{stage, attempt}` yang `stage`-nya salah satu dari `generating`, `verifying`, `repairing`, dan `publishing`; `diagnostics` dengan `{attempt, ok, error_count, warning_count, items}` yang `items`-nya paling banyak 10 entri `{tool, code, line?}` tanpa teks pesan; `done` dengan `{animation, cached, attempts}` yang `animation`-nya Animation_Reference; dan `error` dengan `{code, message, attempts}`.
4. THE Animation_Endpoint SHALL mengirim `started` paling awal dan tepat satu event akhir, `done` atau `error`, paling akhir, dan SHALL NOT mengirim event apa pun setelah event akhir.
5. THE Animation_Endpoint SHALL mengirim satu event `diagnostics` setelah setiap verifikasi dan SHALL menjaga setiap event paling besar 8192 byte.
6. WHEN 15000 ms berlalu tanpa event apa pun, THE Animation_Endpoint SHALL menulis baris komentar `: ping` diikuti baris kosong.
7. THE Animation_Endpoint SHALL NOT menyertakan kode sumber, prompt, isi Required_Tokens atau Forbidden_Tokens, API key, nilai cookie `lore_device`, URL presigned, atau pesan Diagnostic di event apa pun.
8. WHEN klien terputus, THE Animation_Endpoint SHALL membatalkan Animation_Agent, SHALL melepas slot serentak, dan SHALL berhenti menulis.
9. FOR ALL urutan event, mem-parse stream terserialisasi dengan parser frontend SHALL mengembalikan urutan event yang sama dan mengabaikan baris komentar (properti round-trip), diverifikasi terhadap fixture yang dipakai bersama oleh tes backend dan frontend.
10. THE Animation_Endpoint SHALL mengisi `message` pada event `error` dengan kalimat bahasa biasa yang tetap per `code` dan SHALL NOT memuat detail internal.
11. IF salah satu pemeriksaan pada Requirement 15 kriteria 6 menolak request, THEN THE Animation_Endpoint SHALL menjawab non-200 berupa envelope JSON dan bukan `text/event-stream`, sehingga kriteria 1 hanya berlaku untuk request yang lolos seluruh pemeriksaan itu.
12. FOR ALL percobaan n dari 1 sampai `max_attempts`, THE Animation_Endpoint SHALL mengirim `stage` `generating` (n sama dengan 1) atau `repairing` (n lebih dari 1), lalu `stage` `verifying` (dilewati bila verifier dilewati menurut Requirement 13 kriteria 7 atau 8), lalu `diagnostics` (dilewati untuk percobaan yang berakhir `ANIMATION_VERIFIER_UNAVAILABLE`), SHALL mengirim `stage` `publishing` hanya setelah `ok` true, dan SHALL mengisi `attempts` dengan jumlah Gemini_Call yang dimulai di run itu; untuk Idempotent_Hit THE Animation_Endpoint SHALL mengirim hanya `started` dan `done` sesuai Requirement 18 kriteria 7, dengan `done.attempts` berisi nilai tercatat pada baris Animation_Registry (bukan 0, yang hanya berlaku untuk log pada Requirement 33 kriteria 11).
13. WHILE stream terbuka dan event akhir belum terkirim, THE Animation_Endpoint SHALL menulis `: ping` diikuti baris kosong tiap 15000 ms sejak penulisan terakhir, diukur dengan jam yang diinjeksi, dan SHALL NOT menulisnya setelah event akhir.
14. THE Animation_Endpoint SHALL mengirim event akhir paling lambat `deadline_ms` ditambah 10000 ms setelah event `started`, dengan `error.code` salah satu anggota himpunan tertutup pada Requirement 13 kriteria 11.
15. FOR ALL pemotongan chunk atas stream terserialisasi (setiap offset byte, termasuk di dalam karakter UTF-8 dan di dalam pemisah CRLF), THE Animation_Client SHALL menghasilkan urutan event yang sama dengan fixture `backend/tests/fixtures/animation/sse-stream.txt`, dan IF stream berakhir tanpa event akhir, THEN THE Animation_Client SHALL mengembalikan `STREAM_INTERRUPTED`.

### Requirement 18: Idempotensi dan Request_Hash

**User Story:** Sebagai pemilik sistem, saya ingin permintaan identik dari owner yang sama dijawab dari catatan, agar tidak ada pembayaran ganda untuk Gemini dan Lambda.

#### Acceptance Criteria

1. THE Animation_Endpoint SHALL menghitung Request_Hash sebagai SHA-256, dalam heksadesimal huruf kecil, dari JSON kanonik `{contract_version, kind, title, text, concepts, visual, language, forbidden_tokens}` yang dibangun dari model tervalidasi: `title` ter-trim; `concepts` dan `forbidden_tokens` bernilai `[]` bila tidak dikirim; urutan `concepts` dipertahankan; `visual` adalah hasil `parse_lesson_visual`; tanpa normalisasi Unicode; kunci terurut; pemisah `,` dan `:` tanpa spasi; UTF-8 dengan karakter non-ASCII tidak di-escape; bilangan bernilai bulat ditulis tanpa bagian pecahan (`2.0` menjadi `2`, `-0.0` menjadi `0`); boolean ditulis `true` atau `false`; dan `forbidden_tokens` diurutkan menurut titik kode lalu dideduplikasi.
2. FOR ALL request valid, mengubah urutan kunci JSON masukan atau urutan dan duplikat `forbidden_tokens` SHALL NOT mengubah Request_Hash, dan mengubah isi himpunan `forbidden_tokens` atau nilai bidang lain mana pun (termasuk urutan `concepts` dan `contract_version`) SHALL mengubahnya (properti stabilitas dan sensitivitas).
3. WHEN Animation_Registry sudah memiliki baris untuk Owner dan Request_Hash yang sama, THE Animation_Endpoint SHALL mengirim `started` dengan `cached` true diikuti `done` dengan `cached` true, dan SHALL NOT memanggil Gemini, Verifier_Lambda, maupun S3, dan SHALL NOT mengambil slot serentak atau menghitung kuota harian.
4. WHEN dua request dengan Owner dan Request_Hash yang sama selesai bersamaan, THE Animation_Registry SHALL menyimpan tepat satu baris, dan kedua stream SHALL berakhir dengan `animation_id` yang sama.
5. IF sebuah run berakhir di `fail`, THEN THE Animation_Endpoint SHALL NOT menulis baris Animation_Registry, sehingga percobaan ulang menjalankan agent lagi.
6. THE Animation_Endpoint SHALL memperlakukan request dari Owner yang berbeda dengan Request_Hash yang sama sebagai request baru.
7. WHEN pencarian idempoten menemukan baris untuk Owner dan Request_Hash yang sama, THE Animation_Endpoint SHALL mengirim hanya `started` dengan `cached` true lalu `done` dengan `cached` true dan `attempts` dari baris itu, dengan `animation` dibangun dari kolom Animation_Registry.
8. WHEN penyisipan mengenai `ON CONFLICT (owner_id, request_hash)`, THE Animation_Registry SHALL mengembalikan baris yang bertahan tanpa memeriksa kuota per owner pada Requirement 20.
9. WHEN sebuah run kalah balapan penyisipan, THE Animation_Endpoint SHALL mengirim `done` dengan `cached` false serta `animation_id`, `source_sha256`, dan `bundle_sha256` milik baris yang bertahan.
10. IF sebuah string pada body request mengandung surrogat tunggal, THEN THE Animation_Endpoint SHALL menjawab HTTP 400 dengan `INVALID_REQUEST` sebelum Request_Hash dihitung.
11. THE Test_Suites SHALL memuat fixture `backend/tests/fixtures/ai/animation-request-hash.json` berisi sedikitnya 6 vektor beserta SHA-256 yang diharapkan, yang mencakup bidang opsional tidak dikirim, `forbidden_tokens` tak berurutan dan duplikat, `2.0` dibanding `2`, `true` dibanding `1`, `-0.0`, dan `é`.

### Requirement 19: Penyimpanan S3 dan Animation_Manifest

**User Story:** Sebagai pemilik sistem, saya ingin berkas animasi tersimpan immutable dan terverifikasi integritasnya, agar frontend selalu mengeksekusi persis berkas yang lolos verifikasi.

#### Acceptance Criteria

1. THE Animation_Store SHALL menulis objek di bawah kunci `animations/v1/<dua karakter heksadesimal pertama source_sha256>/<source_sha256>/main.ts`, `.../main.js`, dan `.../manifest.json`, dengan `source_sha256` adalah SHA-256 byte UTF-8 sumber yang sudah dinormalkan.
2. THE Animation_Store SHALL menghitung `bundle_sha256` atas byte UTF-8 teks bundle yang dikembalikan Verifier_Lambda, dan SHALL mengirim setiap unggahan dengan checksum SHA-256 sehingga S3 menolak data yang rusak.
3. THE Animation_Store SHALL mengunggah `main.ts`, lalu `main.js`, lalu `manifest.json` paling akhir, sehingga keberadaan manifest berarti dua objek lain ada, dengan content type `text/typescript; charset=utf-8`, `application/javascript; charset=utf-8`, dan `application/json; charset=utf-8`.
4. THE Animation_Store SHALL menulis setiap objek dengan kondisi `If-None-Match: *` menurut urutan `main.ts`, `main.js`, lalu `manifest.json` terakhir, dan WHEN S3 menjawab 412, THE Animation_Store SHALL membaca ulang `manifest.json`: bila manifest ada, THE Animation_Store SHALL mengikuti kriteria 5; bila hasilnya 404 dan objek yang ditolak adalah `main.ts` atau `main.js`, THE Animation_Store SHALL mengunduh objek yang ada, membandingkan SHA-256-nya dengan yang lokal, melanjutkan bila sama, dan menggagalkan run dengan `ANIMATION_STORAGE_FAILED` bila berbeda; untuk hasil pembacaan ulang lain, THE Animation_Store SHALL menggagalkan run dengan `ANIMATION_STORAGE_FAILED`.
5. WHEN `manifest.json` sudah ada untuk kunci itu, THE Animation_Store SHALL membacanya, SHALL mengadopsi nilainya (termasuk `bundle_sha256`), SHALL NOT menimpa satu pun dari tiga objek, dan SHALL menjadikan nilai yang diadopsi sebagai nilai yang dikembalikan di Animation_Reference.
6. THE Animation_Manifest SHALL memuat `schema_version` (1), `contract_version`, `runtime_version` (`react`, `remotion`), `source_sha256` dan `bundle_sha256` (masing-masing 64 karakter heksadesimal huruf kecil), `source_bytes`, `bundle_bytes`, `meta` (Main_Meta dengan kunci camelCase), `verification` (`verifier_version`, `checks` yang sama dengan `summary.checks` pada Verifier_Result, dan `warnings` berisi Diagnostic ber-`severity` `warning`), `skipped_tokens` (Skipped_Tokens), `model`, `attempts` (1 sampai 4), `request_hash`, dan `created_at` (UTC ISO 8601 berakhiran `Z`).
7. THE Animation_Store SHALL memakai klien S3 `boto3` yang dikonfigurasi dengan `signature_version` `s3v4`, `addressing_style` `virtual`, region dari `AWS_REGION`, `connect_timeout` 5 detik, `read_timeout` 75 detik, dan mode retry `standard` dengan `max_attempts` 2.
8. IF penulisan S3 mana pun gagal setelah retry klien, THEN THE Animation_Store SHALL menggagalkan run dengan `ANIMATION_STORAGE_FAILED` tanpa menulis baris Animation_Registry.
9. THE Animation_Store SHALL NOT menghapus, menimpa, atau mendaftar objek di bucket.
10. FOR ALL sumber yang valid, menulis lalu membaca kembali tiga objek SHALL mengembalikan byte yang identik yang SHA-256-nya sama dengan `source_sha256` dan `bundle_sha256` (properti round-trip terhadap S3 palsu).
11. IF S3 menjawab HTTP 501 terhadap header `If-None-Match` di region target, THEN THE Animation_Store SHALL beralih ke pemeriksaan `HeadObject` sebelum setiap penulisan dan SHALL memperlakukan objek yang ada seperti pada kriteria 4 dan 5, dan THE Docs_Set SHALL menandai ketersediaan penulisan bersyarat di `ap-southeast-3` sebagai `[belum diverifikasi]` sampai operator mengonfirmasinya lewat satu butir daftar periksa manual di `docs/infra/12-remotion-animation.md` (bukan lewat Smoke_Script).
12. WHEN node `publish` dimulai, THE Animation_Store SHALL membaca `manifest.json` dengan satu GET dan SHALL menganggap hanya status 404 sebagai belum ada; IF status selain 200 dan 404 (termasuk 403), JSON tidak valid, `schema_version` bukan 1, atau `source_sha256` berbeda dari kunci, THEN THE Animation_Store SHALL menggagalkan run dengan `ANIMATION_STORAGE_FAILED` tanpa menulis objek apa pun.
13. IF S3 menjawab 409 `ConditionalRequestConflict` untuk sebuah penulisan, THEN THE Animation_Store SHALL mengulang penulisan itu satu kali, dan IF penulisan ulang menjawab 409 lagi, THEN THE Animation_Store SHALL menggagalkan run dengan `ANIMATION_STORAGE_FAILED`.
14. THE Animation_Store SHALL membatasi setiap panggilan S3 dengan sisa deadline dan SHALL NOT memulai unggahan setelah run dibatalkan, dan IF deadline habis selama `publish`, THEN THE Animation_Store SHALL menggagalkan run dengan `ANIMATION_TIMEOUT` tanpa menulis `manifest.json` dan tanpa menulis baris Animation_Registry.
15. WHEN `publish` selesai, THE Animation_Registry SHALL menyimpan `bundle_sha256`, `bundle_bytes`, `meta`, `attempts`, `model`, `verifier_version`, `contract_version`, dan `runtime_version` yang sama dengan Animation_Manifest yang berlaku untuk kunci itu, yaitu yang baru ditulis atau yang diadopsi menurut kriteria 5.

### Requirement 20: Tabel animations, kepemilikan, dan kuota per owner

**User Story:** Sebagai pemilik sistem, saya ingin catatan animasi per owner dengan kuota, agar akses terisolasi dan penyimpanan tidak tumbuh tanpa batas.

#### Acceptance Criteria

1. THE Animation_Registry SHALL dibuat oleh revisi Alembic baru yang ditulis tangan dengan `down_revision` sama dengan `7c1d9e4a52b8`, expand-only, dengan `downgrade` yang berfungsi, dan tanpa mengubah revisi yang sudah ada.
2. THE Animation_Registry SHALL mendefinisikan tabel `animations` dengan kolom `id` (text primary key, string UUID), `owner_id` (uuid, not null), `request_hash` (text, 64 karakter heksadesimal), `source_sha256` (text), `bundle_sha256` (text), `s3_prefix` (text), `kind` (text, dibatasi ke `lesson` atau `puzzle`), `meta` (jsonb), `attempts` (integer), `model` (text), `verifier_version` (text), `contract_version` (integer), `runtime_version` (jsonb), `source_bytes` (integer), `bundle_bytes` (integer), dan `created_at` (bigint, milidetik).
3. THE Animation_Registry SHALL memberi tabel `animations` constraint unik pada (`owner_id`, `request_hash`) dan indeks pada (`owner_id`, `created_at` menurun).
4. THE Animation_Registry SHALL menyisipkan dengan `ON CONFLICT (owner_id, request_hash) DO NOTHING` dan SHALL membaca baris yang bertahan, sehingga penyisipan identik yang bersamaan menghasilkan satu baris.
5. WHEN seorang Owner sudah memiliki 200 baris dan request bukan Idempotent_Hit, THE Animation_Endpoint SHALL menjawab HTTP 422 dengan `ANIMATION_QUOTA_EXCEEDED` sebelum stream dimulai, tanpa mengambil slot serentak, tanpa menghitung kuota harian, dan tanpa memanggil Gemini, Verifier_Lambda, maupun S3, dan penyisipan SHALL memeriksa ulang hitungan secara atomik, mengakhiri run dengan `ANIMATION_QUOTA_EXCEEDED` pada event `error` bila penyisipan bersamaan telah memenuhi kuota.
6. THE Test_Suites SHALL menjalankan `alembic upgrade head`, `alembic downgrade -1`, dan `alembic upgrade head` terhadap Postgres di CI dan SHALL menegaskan bahwa setiap perintah selesai tanpa galat, bahwa setelah `downgrade` tabel `animations` beserta indeks dan constraint-nya tidak ada, `alembic_version` sama dengan `7c1d9e4a52b8`, dan tabel `projects` tetap ada, dan bahwa setelah `upgrade` kedua tabel `animations` ada kembali.
7. IF pencarian idempoten, penghitungan kuota, penyisipan, atau pembacaan Animation_Registry gagal (galat SQLAlchemy, atau koneksi tidak terbentuk dalam `DB_CONNECT_TIMEOUT`), THEN THE Animation_Endpoint SHALL menjawab HTTP 503 dengan `ANIMATION_STORAGE_FAILED` bila stream belum dimulai, THE Animation_Agent SHALL mengakhiri run dengan event `error` `ANIMATION_STORAGE_FAILED` bila stream sudah dimulai, dan THE Animation_Registry SHALL NOT menulis baris untuk request itu.
8. THE Animation_Registry SHALL menyerialisasi penghitungan kuota dan penyisipan per `owner_id` (misalnya dengan `pg_advisory_xact_lock`), SHALL menghitung hanya baris dengan `owner_id` yang sama, dan SHALL mengembalikan baris yang bertahan tanpa memeriksa kuota bila penyisipan mengenai `ON CONFLICT (owner_id, request_hash)`.
9. THE Test_Suites SHALL menegaskan terhadap Postgres bahwa dua request identik yang bersamaan pada Owner dengan 199 baris berakhir dengan `animation_id` yang sama dan 200 baris, dan bahwa dua request berbeda yang bersamaan pada Owner dengan 199 baris menghasilkan tepat 200 baris dan tepat satu event `error` dengan `ANIMATION_QUOTA_EXCEEDED`.
10. THE Animation_Registry SHALL membaca batas 200 baris per Owner dari field `owner_max_animations` pada Animation_Limits.
11. THE Animation_Registry SHALL mendefinisikan semua kolom tabel `animations` sebagai `NOT NULL`, `id` sebagai UUID huruf kecil 36 karakter, CHECK `^[0-9a-f]{64}$` pada `request_hash`, `source_sha256`, dan `bundle_sha256`, `attempts` antara 1 dan 4, `source_bytes` antara 1 dan 32768, `bundle_bytes` antara 1 dan 131072, dan `s3_prefix` sama dengan `animations/v1/<dua karakter heksadesimal pertama source_sha256>/<source_sha256>/`, dan Postgres SHALL menolak penyisipan yang melanggar salah satunya.
12. WHEN Animation_Store mengadopsi manifest yang sudah ada menurut Requirement 19 kriteria 5, THE Animation_Registry SHALL menyimpan `bundle_sha256`, `bundle_bytes`, `meta`, `attempts`, `model`, dan `verifier_version` dari manifest itu.

### Requirement 21: Animation_Reader dan URL presigned

**User Story:** Sebagai pemain, saya ingin browser mengambil animasi milik saya lewat URL berumur pendek, agar bucket tetap privat dan hanya pemilik yang dapat membaca.

#### Acceptance Criteria

1. THE Animation_Reader SHALL berupa `GET /api/v1/animations/{animation_id}`, tercakup oleh `device_token_middleware` dan oleh batas per-IP `limit_ip` yang sudah dipakai endpoint baca projects.
2. WHEN Animation_Registry memiliki baris dengan `animation_id` itu dan Owner tersebut, THE Animation_Reader SHALL menjawab HTTP 200 dengan `{"ok": true, "data": {"animation": <Animation_Reference>, "manifest": <ringkasan>, "urls": {"bundle": <url>, "manifest": <url>}, "expires_in": 300}}` dan `Cache-Control: no-store`, dengan `manifest` berupa ringkasan yang memuat tepat `contract_version`, `runtime_version`, `source_bytes`, `bundle_bytes`, `meta`, `verifier_version`, `model`, dan `attempts` dari kolom Animation_Registry, tanpa `checks`, `warnings`, `request_hash`, dan `created_at`.
3. THE Animation_Reader SHALL membangun `urls` sebagai URL GET presigned SigV4 (`X-Amz-Algorithm=AWS4-HMAC-SHA256`, `X-Amz-Expires=300`) untuk `main.js` dan `manifest.json` pada host `<bucket>.s3.<AWS_REGION>.amazonaws.com`, memakai konfigurasi klien S3 yang sama dengan Requirement 19 kriteria 7, dihitung lokal dengan kredensial role, dan SHALL NOT melakukan panggilan jaringan ke S3 selain pengambilan kredensial dari IMDS.
4. IF `animation_id` bukan UUID yang valid, tidak ada, atau milik Owner lain, THEN THE Animation_Reader SHALL menjawab HTTP 404 dengan badan identik `{"detail": "animation not found"}` pada ketiga kasus.
5. IF `ANIMATION_ENABLED` tidak true, atau bucket atau region kosong, atau engine database tidak ada, THEN THE Animation_Reader SHALL menjawab HTTP 503 dengan `ANIMATION_NOT_CONFIGURED`.
6. THE Animation_Reader SHALL NOT menulis URL presigned atau badan respons ke log apa pun, dan logger `botocore` dan `boto3` SHALL disetel ke `WARNING` atau lebih tinggi.
7. THE Animation_Reader SHALL NOT memanggil operasi S3 apa pun selain pembuatan URL presigned, sehingga latensinya tidak bergantung pada S3, dan THE Test_Suites SHALL menegaskannya dengan klien S3 palsu yang mencatat nol panggilan `get_object`, `head_object`, dan `list_objects_v2`.
8. THE Test_Suites SHALL mencakup tiga kasus 404 dengan badan yang identik byte demi byte dan SHALL mencakup URL presigned yang host-nya endpoint S3 virtual-hosted regional dan yang `X-Amz-Expires`-nya sama dengan 300.
9. THE Animation_Reader SHALL menjalankan pemeriksaan dengan urutan berikut dan berhenti pada kegagalan pertama: `limit_ip` (request ke-121 dari satu IP dalam 60 detik dijawab HTTP 429 dengan badan `{"detail": "rate limit exceeded"}`), konfigurasi (kriteria 5), format `animation_id`, lalu pencarian Animation_Registry.
10. IF `animation_id` tidak cocok dengan `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, THEN THE Animation_Reader SHALL menjawab HTTP 404 tanpa query database dan tidak pernah HTTP 422, dan badan 404 untuk id yang tidak valid, tidak ada, dan milik Owner lain SHALL identik byte demi byte.
11. IF kriteria 5 terpenuhi, THEN THE Animation_Reader SHALL menjawab `{"ok": false, "error": {"code": "ANIMATION_NOT_CONFIGURED", "message": <kalimat tetap>}}`, dan respons 404 serta 503 SHALL membawa `Cache-Control: no-store`.
12. WHILE `ANIMATION_ENABLED` true, `ANIMATION_BUCKET` dan `AWS_REGION` tidak kosong, dan engine database ada, THE Animation_Reader SHALL menjawab menurut kriteria 2 atau 4 walaupun `ANIMATION_VERIFIER_FUNCTION` kosong, karena Animation_Reader sengaja tidak memeriksa env fungsi verifier.
13. FOR ALL baris Animation_Registry yang valid, `data.animation` SHALL sama dengan `animation` pada event `done` untuk baris yang sama dan lolos skema pada Requirement 22 kriteria 2, `pause_at_frame` SHALL dihilangkan (bukan `null`) bila `meta` tidak memuat `pauseAtFrame`, dan kunci objek pada `urls` SHALL berupa `animations/v1/<dua karakter heksadesimal pertama>/<source_sha256>/main.js` dan `.../manifest.json`.
14. THE Animation_Reader SHALL menjalankan pembacaan database dan pembuatan URL lewat `asyncio.to_thread`, ditegaskan dengan spy, dan IF `ANIMATION_ENABLED` tidak true, THEN THE Animation_Reader SHALL menjawab HTTP 503 yang sama untuk setiap `animation_id`, termasuk yang bukan UUID, tanpa query database.

### Requirement 22: Kontrak cerita, field animation pada learning_info dan puzzle

**User Story:** Sebagai developer, saya ingin cerita membawa referensi animasi yang opsional dan lenient, agar cerita lama tetap valid dan referensi rusak tidak menggagalkan cerita.

#### Acceptance Criteria

1. THE Story_Contract SHALL menambahkan field opsional `animation` pada blok konten `learning_info` dan pada objek `puzzle` di model Pydantic (`backend/app/ai/contracts/story.py`), di skema Zod (`scene.schema.ts`, `puzzle.schema.ts`), dan di tipe TypeScript.
2. THE Animation_Reference SHALL memuat `animation_id` (string UUID), `source_sha256` dan `bundle_sha256` (64 karakter heksadesimal huruf kecil), `width` (1280), `height` (720), `fps` (30), `duration_in_frames` (bilangan bulat 30 sampai 900), `pause_at_frame` opsional (bilangan bulat 1 sampai `duration_in_frames - 1`), dan `contract_version` (bilangan bulat positif).
3. IF nilai `animation` (termasuk `null`) gagal validasi, THEN THE Story_Contract SHALL membuang nilai itu di Pydantic dan di Zod serta menjaga blok atau puzzle tetap valid, dengan cara lenient yang sama seperti field `visual` yang sudah ada, dan SHALL menerima serta mempertahankan cerita yang tidak memiliki field `animation`.
4. IF `animation` pada blok `learning_info` memiliki kunci `pause_at_frame` (dengan nilai apa pun, termasuk `null`), atau `animation` pada `puzzle` tidak memiliki `pause_at_frame`, THEN THE Story_Contract SHALL membuang seluruh objek `animation` itu dan menjaga blok atau puzzle tetap valid.
5. THE Story_Contract SHALL membuang kunci yang tidak dikenal pada Animation_Reference dan SHALL menghilangkan `animation` yang tidak ada saat serialisasi.
6. THE Story_Contract SHALL menerima dan menolak masukan yang sama di model Pydantic dan di skema Zod, diverifikasi oleh satu set fixture Animation_Reference valid dan tidak valid di `backend/tests/fixtures/animation/` yang dibaca oleh Pytest dan Vitest.
7. THE `generate-story` SHALL NOT mengeluarkan `animation`, dan seluruh `backend/tests/test_ai_*.py` yang ada SHALL lulus tanpa perubahan pada fixture atau snapshot yang sudah ada di `backend/tests/fixtures/ai/`, dengan teks prompt identik byte demi byte.
8. WHEN cerita yang memuat Animation_Reference disimpan dan dimuat lewat `/api/v1/projects`, THE Story_Contract SHALL menjaga JSON cerita tetap tidak berubah (round-trip), tanpa perubahan pada `backend/app/projects.py` atau `backend/app/models.py`.
9. WHEN `readProject` memuat cerita yang memuat nilai `animation` yang tidak valid, THE Story_Contract SHALL mempertahankan cerita dan membuang hanya field itu.
10. IF `animation_id` tidak cocok dengan `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (termasuk huruf besar, kurung kurawal, awalan `urn:uuid:`, dan tanpa tanda hubung), THEN THE Story_Contract SHALL menganggap `animation` tidak valid di Pydantic dan di Zod.
11. IF `width`, `height`, `fps`, `duration_in_frames`, `pause_at_frame`, atau `contract_version` bertipe string, boolean, `null`, atau pecahan (misalnya 30.5), THEN THE Story_Contract SHALL menganggap `animation` tidak valid di Pydantic (mode strict) dan di Zod.
12. THE Test_Suites SHALL memuat fixture di `backend/tests/fixtures/animation/` dengan awalan nama `valid-` atau `invalid-` yang mencakup `duration_in_frames` 29, 30, 900, dan 901; `pause_at_frame` 0, 1, `duration_in_frames - 1`, dan `duration_in_frames`; `source_sha256` dan `bundle_sha256` dengan 63, 64, dan 65 karakter heksadesimal serta dengan huruf besar; `width` 1279; `fps` 24; `contract_version` 0; dan `animation: null`, dan Pytest dan Vitest SHALL memberi keputusan yang sama untuk setiap berkas.
13. IF respons Gemini untuk `generate-story` memuat kunci `animation` pada blok konten atau puzzle mana pun, THEN THE `generate-story` SHALL menghasilkan blueprint tanpa kunci `animation` pada blok atau puzzle mana pun.
14. WHEN project dengan Animation_Reference valid disimpan lalu dimuat lewat `readProject` pada repository `idb` dan repository `http`, THE Story_Contract SHALL mengembalikan referensi yang deep-equal dengan aslinya.
15. WHEN cerita tanpa kunci `animation` dimuat, THE Story_Contract SHALL menerimanya dan SHALL NOT menambahkan kunci `animation` pada blok atau puzzle mana pun.

### Requirement 23: Pemilihan target dan pembuatan request di frontend

**User Story:** Sebagai pemain, saya ingin hanya beberapa visual terpenting yang dianimasikan secara stabil, agar biaya dan waktu tunggu terbatas dan hasilnya dapat diulang.

#### Acceptance Criteria

1. THE Target_Selector SHALL menyediakan fungsi murni `selectAnimationTargets(story)` yang mengembalikan paling banyak 4 target, masing-masing diidentifikasi oleh id yang stabil: `{kind: "lesson", scene_id, block_index}` atau `{kind: "puzzle", puzzle_id}`.
2. THE `selectAnimationTargets` SHALL menelusuri `story.chapters`, `scenes`, dan `content` menurut urutan array (`block_index` berbasis nol pada `scene.content`), SHALL menjadikan kandidat setiap blok `learning_info` ber-`visual` valid yang tidak satu pun `concept_ids`-nya ada di gabungan `concept_ids` kandidat sebelumnya, lalu setiap puzzle ber-`visual` di `story.puzzles` menurut urutan array, SHALL mempertahankan 4 kandidat pertama (kandidat yang sudah ber-`animation` tetap menempati slotnya), dan SHALL mengembalikan kandidat yang belum ber-`animation`.
3. FOR ALL cerita, THE `selectAnimationTargets` SHALL mengembalikan hasil yang sama untuk masukan yang sama, SHALL NOT pernah mengembalikan duplikat, dan SHALL NOT pernah mengembalikan target yang tidak termasuk 4 kandidat pertama, juga setelah animasi lain dilekatkan (properti stabilitas).
4. THE Target_Selector SHALL menyediakan `buildAnimationRequest(target, story, material, language)` yang mengembalikan `CreateAnimationRequest` atau `{ok: false, reason}`, dan SHALL memvalidasi request dengan skema Zod sebelum mengembalikannya.
5. WHEN jenis target adalah `lesson`, THE `buildAnimationRequest` SHALL menyetel `title` ke `title` blok, `text` ke `body` blok, `visual` ke `visual` blok, dan `concepts` ke `name` konsep materi yang `concept_id`-nya ada di `concept_ids` blok, menurut urutan `concept_ids`, tanpa duplikat dan tanpa id yang tidak ditemukan, paling banyak 5 yang pertama.
6. WHEN jenis target adalah `puzzle`, THE `buildAnimationRequest` SHALL menyetel `title` ke `question` puzzle, `text` ke `narrative_context` puzzle, `visual` ke `visual` puzzle, dan `forbidden_tokens` ke teks pilihan yang `choice_id`-nya sama dengan `correct_choice_id`.
7. THE Target_Selector SHALL menyediakan `attachAnimation(story, target, reference)` yang mengembalikan `{ok: true, story}` berisi salinan baru tanpa memutasi masukan, dan `{ok: false}` bila target tidak dikenal atau `reference` gagal skema Animation_Reference yang strik (menolak, bukan membuang diam-diam seperti pembacaan lenient pada Requirement 22 kriteria 3).
8. FOR ALL cerita dan target, THE `attachAnimation` SHALL membiarkan setiap bagian cerita selain `animation` yang dilekatkan tetap deep-equal dengan masukan (properti preservasi).
9. IF target tidak ada (id tidak cocok, bukan blok `learning_info`, atau tanpa `visual`), THEN THE `buildAnimationRequest` SHALL mengembalikan `{ok: false, reason: "TARGET_NOT_FOUND"}`.
10. IF `title` ter-trim lebih dari 200 karakter, `text` lebih dari 2000 karakter, atau request gagal skema Zod, THEN THE `buildAnimationRequest` SHALL mengembalikan `{ok: false, reason: "REQUEST_INVALID"}` dan SHALL NOT memotong teks apa pun, karena `title` adalah Required_Token verbatim.
11. IF target `puzzle` tidak memiliki tepat satu pilihan ber-`choice_id` sama dengan `correct_choice_id`, atau teks pilihan itu lebih dari 80 karakter ter-trim, THEN THE `buildAnimationRequest` SHALL mengembalikan `{ok: false, reason: "ANSWER_TOKEN_INVALID"}`.
12. WHEN jenis target adalah `puzzle`, THE `buildAnimationRequest` SHALL menyetel `concepts` dari `concept_ids` puzzle dengan aturan urutan, duplikat, dan batas yang sama seperti kriteria 5, dan WHEN jenis target adalah `lesson`, THE `buildAnimationRequest` SHALL NOT menyertakan `forbidden_tokens`.
13. FOR ALL cerita, materi, bahasa, dan target, THE `buildAnimationRequest` SHALL mengembalikan hasil yang deep-equal pada dua panggilan tanpa memutasi masukan yang di-deep-freeze, sehingga Request_Hash sama.
14. IF `reference` memuat `pause_at_frame` untuk target `lesson`, tidak memuatnya untuk target `puzzle`, atau target sudah ber-`animation`, THEN THE `attachAnimation` SHALL mengembalikan `{ok: false}` tanpa mengubah cerita.

### Requirement 24: Tahap generasi animating

**User Story:** Sebagai pemain, saya ingin pembuatan animasi menjadi tahap yang jelas, dapat dilewati, dan tidak pernah menggagalkan cerita, agar saya selalu mendapat cerita yang dapat dimainkan.

#### Acceptance Criteria

1. THE Generation_Flow SHALL menambahkan tahap `animating` ke `GenerationStage` di antara `writing` dan `done`, dengan aksi reducer untuk target mulai, progres, siap, gagal, dilewati, dan selesai, dan reducer SHALL tetap exhaustive terhadap union aksi.
2. WHEN Flag_Web `on` dan sedikitnya satu target ada setelah tahap `writing`, THE Generation_Flow SHALL memasuki `animating`, dan selain itu SHALL berpindah dari `writing` ke `done` persis seperti sebelumnya.
3. THE Generation_Flow SHALL memproses target satu per satu (konkurensi 1) menurut urutan seleksi di seluruh cerita menurut urutan `campaign.story_sequence`, memakai satu request Animation_Client per target.
4. THE Generation_Flow SHALL menyimpan untuk setiap target satu status `pending`, `running`, `ready`, `failed`, atau `skipped`, label tahap dan nomor percobaan terkini dari event `stage`, dan hitungan `k / n` target yang sudah terselesaikan.
5. IF `createAnimation` untuk sebuah target mengembalikan `{ok: false}` dengan `code` selain `ABORTED`, THEN THE Generation_Flow SHALL menandai target itu `failed` dan memulai target berikutnya, kecuali `code` `ANIMATION_NOT_CONFIGURED`, `ANIMATION_QUOTA_EXCEEDED`, atau `RATE_LIMITED`, yang SHALL menandai semua target `pending` menjadi `skipped` tanpa memulai target berikutnya; WHEN `createAnimation` mengembalikan `ABORTED` akibat kontrol `animation-skip`, THE Generation_Flow SHALL menandai target itu `skipped`.
6. WHEN pemain mengaktifkan kontrol dengan `data-testid` `animation-skip`, THE Generation_Flow SHALL membatalkan request yang sedang berjalan, menandai setiap target yang belum selesai `skipped`, dan mengakhiri tahap dengan hasil yang sudah diperoleh.
7. WHEN pemain mengaktifkan kontrol dengan `data-testid` `animation-retry`, THE Generation_Flow SHALL menjalankan ulang hanya target yang `failed` atau `skipped`, dengan mempertahankan yang `ready`.
8. WHEN tidak ada target `pending` atau `running` dan semua target `ready` atau kontrol `animation-skip` sudah diaktifkan, THE Generation_Flow SHALL memanggil `attachAnimation` untuk setiap target `ready`, lalu memanggil `onDone` tepat sekali dengan cerita yang sudah diperbarui.
9. THE Generation_Flow SHALL membatalkan request Animation_Client yang tidak menghasilkan event akhir 270000 ms setelah dimulai dan SHALL menandai targetnya `failed` dengan kode `ANIMATION_TIMEOUT`.
10. THE `messageForCode` SHALL mengembalikan, untuk setiap kode `ANIMATION_NOT_CONFIGURED`, `ANIMATION_QUOTA_EXCEEDED`, `ANIMATION_VERIFICATION_FAILED`, `ANIMATION_TIMEOUT`, `ANIMATION_VERIFIER_UNAVAILABLE`, `ANIMATION_STORAGE_FAILED`, `STREAM_INTERRUPTED`, dan `NETWORK`, string bahasa biasa yang tidak kosong, paling banyak 160 karakter, dan bukan `BUILD_MESSAGES.unexpected`, dengan `NETWORK` sama dengan `BUILD_MESSAGES.network`, dan keluaran untuk kode yang sudah ada SHALL tidak berubah.
11. THE Generation_Flow SHALL merender tahap `animating` dengan komponen layar generasi yang ada dan token Kit, SHALL NOT menambah warna di luar token Kit, dan SHALL memasang `data-testid` pada setiap elemen interaktif.
12. FOR ALL urutan aksi, THE Generation_Flow SHALL mengembalikan state yang valid tanpa melempar exception, dan SHALL mencapai tahap `done` hanya bila tidak ada target `pending` atau `running` (properti totalitas).
13. WHEN tidak ada target `pending` atau `running`, sedikitnya satu target `failed` atau `skipped`, dan kontrol `animation-skip` belum diaktifkan, THE Generation_Flow SHALL menahan `onDone` dan menampilkan kontrol `animation-retry` dan `animation-skip`.
14. IF 270000 ms berlalu tanpa event akhir untuk sebuah target, THEN THE Generation_Flow SHALL menandai target itu `failed` dengan kode `ANIMATION_TIMEOUT`, dan hasil `ABORTED` yang menyusul pembatalan itu SHALL NOT mengubah status target.
15. WHILE empat request Animation_Client telah dimulai dalam 60000 ms terakhir, THE Generation_Flow SHALL menahan target berikutnya dalam status `pending` sampai 60000 ms sejak start request tertua pada jendela itu, selaras dengan batas 4 per menit pada Requirement 16 kriteria 1.
16. THE Generation_Flow SHALL NOT mengirim aksi `failed` yang sudah ada untuk galat target animasi, sehingga `state.status` SHALL NOT pernah bernilai `failed` pada tahap `animating`.
17. IF `attachAnimation` mengembalikan `{ok: false}` untuk sebuah target `ready` pada langkah kriteria 8, THEN THE Generation_Flow SHALL menandai target itu `failed`, mempertahankan cerita tanpa animasi itu, dan tetap memanggil `onDone` tepat satu kali.

### Requirement 25: Animation_Client, klien SSE frontend

**User Story:** Sebagai developer frontend, saya ingin klien SSE yang tangguh terhadap potongan data dan kegagalan jaringan, agar UI selalu menerima hasil akhir yang terdefinisi.

#### Acceptance Criteria

1. THE Animation_Client SHALL menyediakan `createAnimation(request, {signal, fetchImpl, onEvent})` yang mengirim `POST /api/v1/ai/animations` dengan body JSON dan mengembalikan `{ok: true, animation, cached, attempts}` atau `{ok: false, code, message, retryAfterSeconds?}`, dan SHALL NOT melempar exception.
2. THE Animation_Client SHALL men-decode body respons dengan `TextDecoder` streaming dan parser inkremental murni, sehingga event yang terpotong di batas byte mana pun, termasuk di dalam karakter multi-byte, tersusun kembali dengan benar.
3. THE Animation_Client SHALL memvalidasi payload event `started`, `stage`, `diagnostics`, `done`, dan `error` dengan Zod, SHALL melewati event bukan-akhir yang payload-nya bukan JSON atau gagal Zod tanpa memanggil `onEvent`, SHALL mengabaikan nama event lain dan baris komentar, dan SHALL mengembalikan `{ok: false, code: "UNEXPECTED"}` bila payload `done` atau `error` tidak valid.
4. WHEN status respons bukan 200, THE Animation_Client SHALL membaca envelope JSON dan mengembalikan `error.code` dan `error.message`-nya, SHALL menyertakan `retryAfterSeconds` dari header `Retry-After` pada HTTP 429 bila nilainya bilangan bulat tak negatif dan menghilangkan field itu bila tidak, dan IF body bukan envelope yang valid, THEN THE Animation_Client SHALL mengembalikan `{ok: false, code: "UNEXPECTED"}`.
5. IF signal dibatalkan di titik mana pun, THEN THE Animation_Client SHALL mengembalikan `ABORTED` (diutamakan atas `NETWORK` dan `STREAM_INTERRUPTED`); IF `fetchImpl` menolak sebelum header diterima, THEN THE Animation_Client SHALL mengembalikan `NETWORK`; IF pembacaan body menolak atau stream berakhir tanpa event akhir (termasuk body `null` pada respons 200), THEN THE Animation_Client SHALL mengembalikan `STREAM_INTERRUPTED`.
6. THE Animation_Client SHALL memanggil `onEvent` untuk setiap event valid menurut urutan kedatangan.
7. FOR ALL urutan event dan semua pemotongan bentuk terserialisasinya, THE Animation_Client SHALL mengembalikan event yang sama (properti invarian pemotongan dan round-trip), diverifikasi dengan fixture SSE yang dipakai bersama backend.
8. WHEN event `done` yang valid diterima, THE Animation_Client SHALL memanggil `reader.cancel()` dan mengembalikan `{ok: true, animation, cached, attempts}` dari payload `done` (bukan dari `started`); WHEN event `error` yang valid diterima, THE Animation_Client SHALL mengembalikan `{ok: false, code, message}`; dan THE Animation_Client SHALL mengabaikan byte setelah event akhir.
9. THE Animation_Client SHALL memanggil `fetchImpl` tepat sekali dengan `method` `POST`, `credentials` `same-origin`, header `Content-Type: application/json` dan `Accept: text/event-stream`, dan `signal` masukan, dan IF signal sudah dibatalkan sebelum pemanggilan, THEN THE Animation_Client SHALL mengembalikan `ABORTED` tanpa memanggil `fetchImpl`.
10. IF `onEvent` melempar exception, THEN THE Animation_Client SHALL menelan exception itu, SHALL tetap memproses event berikutnya, dan SHALL mengembalikan hasil yang sama seperti tanpa exception.
11. THE Animation_Client SHALL NOT memiliki timer sendiri, dan IF signal dibatalkan oleh sebab apa pun (termasuk batas 270000 ms pada Requirement 24 kriteria 9), THEN THE Animation_Client SHALL mengembalikan `ABORTED`.
12. THE Animation_Client SHALL menerima pemisah baris `\n`, `\r\n`, dan `\r`, SHALL menggabungkan baris `data:` yang berurutan dengan `\n`, SHALL mengabaikan baris `id:` dan `retry:`, dan SHALL membuang event terakhir yang tidak diakhiri baris kosong.

### Requirement 26: Animation_Loader, URL, unduhan, integritas, dan cache

**User Story:** Sebagai pemain, saya ingin bundle animasi diverifikasi hash-nya sebelum dijalankan, agar berkas yang dimanipulasi atau rusak tidak pernah dieksekusi.

#### Acceptance Criteria

1. THE Animation_Loader SHALL menyediakan `loadAnimation(reference, {fetchImpl, signal})` yang mengembalikan `{ok: true, bundle, meta, runtimeMismatch}` atau `{ok: false, phase, reason}` dengan `phase` sama dengan `urls`, `fetch`, atau `integrity`, dan SHALL NOT melempar exception.
2. WHEN cache memuat bundle terverifikasi untuk `reference.bundle_sha256`, THE Animation_Loader SHALL mengembalikannya tanpa request jaringan apa pun.
3. THE Animation_Loader SHALL meminta `GET /api/v1/animations/{animation_id}` dengan `credentials: "same-origin"` dan timeout 8000 ms, SHALL memvalidasi `data.animation`, `data.manifest.runtime_version`, dan `data.urls.bundle` dengan Zod, dan SHALL mengembalikan fase `urls` bila status bukan 200 (termasuk 404 dan 503), body tidak valid, jaringan gagal, atau timeout.
4. IF `data.animation.bundle_sha256` atau `data.animation.source_sha256` pada respons tidak sama persis dengan `reference`, THEN THE Animation_Loader SHALL mengembalikan fase `integrity` dengan `reason` `hash_mismatch` tanpa mengunduh bundle.
5. THE Animation_Loader SHALL mengunduh `urls.bundle` dengan `fetch` memakai `credentials: "omit"` dan `referrerPolicy: "no-referrer"`, timeout 8000 ms, dan SHALL mengembalikan fase `fetch` untuk status tidak sukses, body lebih besar dari 131072 byte, kegagalan jaringan, atau timeout.
6. WHEN unduhan dijawab HTTP 403, THE Animation_Loader SHALL meminta URL baru satu kali dan mengulang unduhan satu kali.
7. THE Animation_Loader SHALL menghitung SHA-256 byte yang diunduh dan SHALL mengembalikan fase `integrity` bila berbeda dari `reference.bundle_sha256`.
8. THE Animation_Loader SHALL menyimpan hanya bundle yang terverifikasi di cache memori halaman paling banyak 16 entri, berkunci `bundle_sha256`, dengan eviksi least-recently-used (cache hit memperbarui kebaruan), dan SHALL berbagi satu load yang sedang berjalan hanya di antara request dengan pasangan (`animation_id`, `bundle_sha256`) yang sama dan melepaskannya saat load selesai, termasuk saat gagal.
9. THE Animation_Loader SHALL menyediakan `sha256Hex(bytes)` yang memakai `crypto.subtle` bila ada dan implementasi SHA-256 TypeScript murni bila tidak ada, dan kedua jalur SHALL mengembalikan digest yang sama.
10. WHEN `runtime_version` pada respons berbeda dari versi yang dipin aplikasi, THE Animation_Loader SHALL tetap mengembalikan bundle dengan `runtimeMismatch` true.
11. THE Animation_Loader SHALL NOT menyimpan URL presigned melebihi durasi satu load dan SHALL NOT mencatatnya di log.
12. FOR ALL string byte, THE implementasi `sha256Hex` SHALL sama satu sama lain dan SHALL cocok dengan vektor uji NIST untuk pesan kosong, `abc`, dan pesan 448-bit (properti ekuivalensi).
13. IF signal dibatalkan, THEN THE Animation_Loader SHALL mengembalikan `{ok: false, phase: <fase aktif>, reason: "aborted"}` tanpa menulis cache dan tanpa menggagalkan pemanggil lain yang berbagi load itu, dan SHALL membatalkan request jaringan yang sedang berjalan hanya bila tidak ada pemanggil lain yang berbagi load itu.
14. THE Animation_Loader SHALL mengembalikan `reason` salah satu dari `status`, `invalid_body`, `network`, `timeout`, `too_large`, `hash_mismatch`, dan `aborted`, dan SHALL NOT memuat URL presigned, query string, atau teks `X-Amz-` pada hasil mana pun.
15. WHEN sebuah load terverifikasi, THE Animation_Loader SHALL mengembalikan `meta` berupa `{width, height, fps, durationInFrames, pauseAtFrame?}` yang diturunkan dari `reference` dan `runtimeMismatch` (true bila `react` atau `remotion` pada `runtime_version` respons berbeda dari pin build), dan SHALL menyimpan keduanya bersama entri cache sehingga cache hit dan cache miss mengembalikan nilai yang sama.
16. IF `urls.bundle` bukan URL berskema `https:`, THEN THE Animation_Loader SHALL mengembalikan fase `urls` dengan `reason` `invalid_body` tanpa mengirim request unduhan.
17. IF `Content-Length` lebih dari 131072 atau stream unduhan melewati 131072 byte, THEN THE Animation_Loader SHALL berhenti membaca paling banyak pada 131073 byte dan mengembalikan fase `fetch` dengan `reason` `too_large`, dan timeout 8000 ms SHALL mencakup pembacaan body.
18. IF `crypto.subtle` tidak ada atau `digest` ditolak, THEN `sha256Hex` SHALL memakai jalur TypeScript murni, kedua jalur SHALL menghasilkan digest yang sama untuk masukan sepanjang 0, 55, 56, 63, 64, 65, dan 131072 byte, dan `sha256Hex` untuk masukan `abc` SHALL menghasilkan `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`.

### Requirement 27: Sandbox iframe, CSP, dan pembangunan runtime

**User Story:** Sebagai pemilik sistem, saya ingin kode buatan AI hanya berjalan di iframe bersandbox yang terkunci CSP, agar kode itu tidak pernah dapat menyentuh origin aplikasi.

#### Acceptance Criteria

1. THE Sandbox_Frame SHALL merender `iframe` dengan `sandbox` sama dengan persis `allow-scripts`, `src` sama dengan `/sandbox/runtime.html`, `referrerPolicy` `no-referrer`, `title` yang tidak kosong, `tabIndex` -1, `pointer-events: none`, dan `data-testid` `sandbox-frame`, dan SHALL NOT memberikan `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`, atau `allow-modals`.
2. THE Sandbox_Runtime SHALL mendeklarasikan di `<meta http-equiv="Content-Security-Policy">` kebijakan `default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`.
3. THE Frontend SHALL mengirim kebijakan yang sama dengan tambahan direktif `frame-ancestors 'self'`, ditambah `X-Content-Type-Options: nosniff`, sebagai header respons untuk `/sandbox/:path*` lewat `headers()` di `next.config.ts`, dan SHALL mendefinisikan string kebijakan sekali dalam konstanta bersama yang dipakai oleh pembangunan halaman dan oleh `next.config.ts`.
4. THE Sandbox_Runtime SHALL membuat halaman `runtime.html` memuat satu elemen `<style>` inline berisi variabel warna dan font Kit serta aturan `@font-face` bersumber `data:`, tepat satu `<script src="/sandbox/runtime.js">`, nol skrip inline, nol `@import`, nol `url(` selain `url(data:`, dan nol atribut `href` atau `src` lain, dan THE Test_Suites SHALL menegaskan semuanya.
5. THE Sandbox_Runtime SHALL membangkitkan variabel `:root` dari blok `@theme` di `frontend/src/app/lore-tokens.css`, dan THE Test_Suites SHALL memanggil fungsi pembangkit halaman secara in-process (tanpa membaca `frontend/public/sandbox/`) dan menegaskan bahwa setiap token palet pada Animation_Contract, `--font-display`, dan `--font-mono` ada dengan nilai yang sama seperti di `lore-tokens.css`.
6. THE Sandbox_Runtime SHALL dibangun oleh skrip yang membundel `frontend/sandbox-runtime/` dengan esbuild menjadi `frontend/public/sandbox/runtime.html` dan `frontend/public/sandbox/runtime.js`, dengan `npm run build` menjalankan skrip itu sebelum `next build`, keluaran diabaikan git, dan ukuran berkas `runtime.js` paling besar 1048576 byte.
7. THE Sandbox_Runtime SHALL membundel `react`, `react-dom`, `remotion`, `@remotion/player`, dan skema protokol Zod dari versi yang terpasang di `frontend/node_modules`.
8. THE Sandbox_Frame SHALL membuang iframe, membersihkan semua timer, dan melepas semua listener ketika di-unmount.
9. THE Docs_Set SHALL mencatat daftar periksa browser manual untuk Chromium dan Firefox yang membuktikan bahwa halaman memuat `/sandbox/runtime.js` di bawah kebijakan tanpa `allow-same-origin` dan mencatat hasilnya per browser (temuan T-9).
10. THE Test_Suites SHALL menegaskan string kebijakan CSP persis, nilai atribut `sandbox` persis, header yang dihasilkan `headers()` untuk `/sandbox/:path*`, dan bahwa tidak ada entri `headers()` yang mencakup rute lain.
11. THE Sandbox_Builder SHALL membangun `runtime.js` dengan esbuild berpengaturan `bundle` true, `format` `iife`, `platform` `browser`, `target` `es2022`, `minify` true, `sourcemap` false, dan `define` `process.env.NODE_ENV` sama dengan `"production"`.
12. IF `runtime.js` melebihi 1048576 byte, atau token palet pada `color_tokens` Animation_Contract, `--font-display`, `--font-mono`, atau berkas font sumber tidak ditemukan, THEN THE Sandbox_Builder SHALL menghentikan `npm run build` dengan kode keluar bukan 0 tanpa menulis keluaran.
13. WHEN `npm run dev` dijalankan, THE Sandbox_Builder SHALL dijalankan lewat `predev` sebelum `next dev`, dan THE Test_Suites SHALL NOT membaca `frontend/public/sandbox/*` kecuali setelah memanggil Sandbox_Builder di `beforeAll`, sehingga urutan langkah CI tidak bergantung pada keluaran build.
14. WHEN Sandbox_Frame di-unmount, THE Sandbox_Frame SHALL NOT memanggil callback pemilik atau `postMessage` sesudahnya, dan setiap mount SHALL memakai Session_Id baru sehingga pesan ber-`session` lama diabaikan.
15. IF `window.origin` bukan `"null"` saat Sandbox_Runtime dimuat (artinya dimuat sebagai dokumen tingkat atas), THEN THE Sandbox_Runtime SHALL NOT mendaftarkan listener `message`, SHALL NOT mengevaluasi bundle, dan SHALL NOT mengirim pesan.

### Requirement 28: Sandbox_Protocol dan watchdog

**User Story:** Sebagai developer frontend, saya ingin protokol pesan yang ketat dan watchdog yang membuang iframe bermasalah, agar halaman induk tidak pernah menunggu atau mempercayai iframe tanpa batas.

#### Acceptance Criteria

1. THE Sandbox_Protocol SHALL mendefinisikan pesan dari induk ke iframe: `load` (`session`, `bundle`, `meta`, `contract_version`), `play`, `pause`, `seek` (`frame`), `setMode` (`mode`), dan `resume`; serta pesan dari iframe ke induk: `ready`, `loaded` (`duration_in_frames`), `frame` (`frame`, `playing`), `paused` (`reason` sama dengan `interaction` atau `end`, `frame`), `ended`, `error` (`phase` sama dengan `load` atau `runtime`, `code`), dan `heartbeat`.
2. THE Sandbox_Protocol SHALL memberi setiap pesan bidang `source` sama dengan `lore-sandbox`, `version` sama dengan 1, `type`, dan `session`, SHALL mendefinisikan pesan sebagai skema Zod ketat di `frontend/src/lib/animation/protocol.ts`, dan SHALL membatasi `load.bundle` sampai 131072 karakter.
3. THE Sandbox_Frame SHALL menerima pesan hanya bila `event.source` sama dengan jendela iframe miliknya, `event.origin` sama dengan `"null"`, pesan lolos skema Zod, dan `session` sama dengan Session_Id yang dibangkitkannya untuk iframe ini (kecuali pesan `ready` dan `heartbeat` sebelum `load`, yang ber-`session` kosong), dan SHALL mengabaikan setiap pesan lain tanpa mengubah state atau timer dan tanpa melempar exception.
4. THE Sandbox_Runtime SHALL menerima pesan hanya bila `event.source` sama dengan `window.parent` dan pesan lolos skema Zod, dan SHALL mengabaikan setiap pesan lain.
5. THE Sandbox_Frame SHALL mengirim pesan dengan target origin `*` karena origin iframe bersifat buram, dan SHALL mengirim hanya data yang bukan rahasia.
6. THE Sandbox_Runtime SHALL mengirim pesan `frame` secara periodik selama pemutaran dengan selisih sedikitnya 100 ms antarpesan, dan SHALL mengirim satu pesan `frame` tambahan di luar batas selisih itu saat jeda, akhir, dan seek selesai, dikirim sebelum pesan `paused` atau `ended` yang menyertainya.
7. WHEN 8000 ms berlalu setelah iframe di-mount tanpa `ready`, atau 8000 ms berlalu setelah `load` dikirim tanpa `loaded`, THE Sandbox_Frame SHALL gagal dengan fase `timeout`.
8. THE Sandbox_Runtime SHALL mengirim `heartbeat` tiap 1000 ms sejak `ready`, dan WHEN 3000 ms berlalu tanpa heartbeat selagi status `ready`, `playing`, atau `paused`, THE Sandbox_Frame SHALL gagal dengan fase `timeout`.
9. WHEN Sandbox_Frame gagal (selain karena unmount) atau menerima pesan `error`, THE Sandbox_Frame SHALL membuang iframe dari DOM, menyetel status ke `failed`, memanggil callback kegagalan milik komponen Animation_Scene tepat satu kali dengan `phase`, dan mengabaikan semua pesan berikutnya.
10. FOR ALL nilai, THE Sandbox_Protocol SHALL mengembalikan hasil tidak-ok tanpa melempar exception kecuali nilai itu pesan yang valid, dan pesan yang valid SHALL bertahan tidak berubah setelah serialisasi dan parsing (properti ketahanan dan round-trip).
11. THE Sandbox_Protocol SHALL menolak kunci yang tidak dikenal dan nilai di luar batas berikut: `session` berupa string kosong atau 32 karakter heksadesimal huruf kecil (dibangkitkan Sandbox_Frame dari `crypto.getRandomValues`); `frame` 0 sampai 899; `duration_in_frames` 30 sampai 900; `seek.frame` bilangan bulat aman (dijepit oleh Sandbox_Runtime); `error.code` 1 sampai 64 karakter `[A-Z0-9_]`; dan `load.meta` berkunci `width`, `height`, `fps`, `duration_in_frames`, dan `pause_at_frame?`.
12. THE Sandbox_Frame SHALL memakai status `loading` (sampai `loaded`), `ready` (sampai `frame` atau `paused` pertama), `playing`, `paused` (setelah `paused`, `ended`, atau `frame` ber-`playing` false), dan `failed`, SHALL menghitung 3000 ms heartbeat dari `loaded` atau `heartbeat` valid terakhir, dan SHALL mengabaikan `ready` atau `loaded` yang kedua serta `frame`, `paused`, atau `ended` yang diterima saat status `loading`.
13. THE Sandbox_Runtime SHALL mengirim `ready` dan `heartbeat` dengan `session` kosong sebelum menerima `load`, SHALL memproses `load` tepat sekali, SHALL memakai `session` dari `load` itu pada semua pesan keluar sesudahnya, dan SHALL mengabaikan pesan induk yang ber-`session` lain.
14. IF `loaded.duration_in_frames` berbeda dari `load.meta.duration_in_frames`, THEN THE Sandbox_Frame SHALL gagal dengan fase `load`.

### Requirement 29: Sandbox_Runtime, eksekusi bundle dan perilaku pemutaran

**User Story:** Sebagai pemain, saya ingin animasi diputar sesuai mode fast atau animate dan berhenti di titik soal pada puzzle, agar animasi menjadi bagian alur belajar.

#### Acceptance Criteria

1. WHEN Sandbox_Runtime menerima `load`, THE Sandbox_Runtime SHALL memeriksa bahwa `contract_version` ada di `supported_runtime_contract_versions`, SHALL mengevaluasi bundle dengan `new Function("require", "module", "exports", bundle)`, dan SHALL memberikan shim `require` yang hanya untuk `react` dan `remotion` mengembalikan objek beku yang hanya mengekspos nama yang diizinkan Animation_Contract dan yang melempar untuk id modul lain.
2. THE Sandbox_Runtime SHALL membaca `meta` dan ekspor default dari modul yang dievaluasi, SHALL memvalidasi `meta` terhadap Animation_Contract (kanvas 1280 x 720 pada 30 fps, `durationInFrames` bilangan bulat 30 sampai 900, dan `pauseAtFrame` opsional bilangan bulat 1 sampai `durationInFrames - 1`) dan agar sama dengan `meta` pada pesan `load`, SHALL mewajibkan ekspor default berupa fungsi, dan SHALL menjawab `error` dengan fase `load` pada pelanggaran itu, pada `contract_version` yang tidak didukung, atau bila evaluasi bundle melempar exception.
3. THE Sandbox_Runtime SHALL merender `Main` dengan `Player` dari `@remotion/player` memakai `meta` untuk ukuran, `fps`, dan `durationInFrames`, `controls` false, `clickToPlay` false, `loop` false, `moveToBeginningWhenEnded` false, dan `acknowledgeRemotionLicense`, di dalam error boundary.
4. WHEN render melempar exception, atau `window.onerror` atau `unhandledrejection` terpicu, THE Sandbox_Runtime SHALL menjawab `error` dengan fase `runtime`.
5. WHEN frame pertama sudah dirender, THE Sandbox_Runtime SHALL mengirim `loaded` dan SHALL tetap berhenti di frame 0 sampai menerima `setMode`.
6. WHEN Sandbox_Runtime menerima `setMode` dengan `animate` dan animasi adalah lesson, THE Sandbox_Runtime SHALL memutar dari frame 0 sampai frame terakhir, mengirim `ended`, dan menahan frame terakhir.
7. WHEN Sandbox_Runtime menerima `setMode` dengan `fast` dan animasi adalah lesson, THE Sandbox_Runtime SHALL menampilkan frame `duration_in_frames - 1` dan mengirim `paused` dengan alasan `end`.
8. WHEN Sandbox_Runtime menerima `setMode` dengan `animate` dan animasi memiliki `pause_at_frame`, THE Sandbox_Runtime SHALL memutar dari frame 0, dan WHEN frame mencapai `pause_at_frame`, SHALL menjeda, seek ke tepat `pause_at_frame`, dan mengirim `paused` dengan alasan `interaction`.
9. WHEN Sandbox_Runtime menerima `setMode` dengan `fast` dan animasi memiliki `pause_at_frame`, THE Sandbox_Runtime SHALL seek ke `pause_at_frame`, menjeda, dan mengirim `paused` dengan alasan `interaction`.
10. WHEN Sandbox_Runtime menerima `resume` setelah jeda dengan alasan `interaction`, THE Sandbox_Runtime SHALL memutar sampai frame terakhir dan mengirim `ended` pada mode `animate`, dan SHALL seek ke frame terakhir dan mengirim `paused` dengan alasan `end` pada mode `fast`.
11. WHEN Sandbox_Runtime menerima `setMode` lagi, THE Sandbox_Runtime SHALL menerapkan perilaku kriteria 6 sampai 9 untuk mode baru dari frame 0 dengan me-remount `Player` di dalam iframe (iframe tidak di-remount) dan menghapus status jeda sebelumnya, seperti `StageCanvas` yang ada me-remount player-nya saat pacing berubah.
12. WHEN Sandbox_Runtime menerima `play` selagi jeda dengan alasan `interaction` belum di-resume, THE Sandbox_Runtime SHALL memutar ulang dari frame 0 sampai `pause_at_frame` lalu mengirim `paused` dengan alasan `interaction`, dan WHEN menerima `seek`, THE Sandbox_Runtime SHALL menjepit frame ke rentang 0 sampai `duration_in_frames - 1`, dan selama jeda itu ke rentang 0 sampai `pause_at_frame`, sehingga `seek` tidak dapat melewati titik jeda sebelum `resume` dan jawaban tidak bocor.
13. THE Sandbox_Runtime SHALL merender halamannya dengan `var(--color-ink)` sebagai latar, margin 0, dan overflow tersembunyi, SHALL NOT melakukan request jaringan apa pun, dan SHALL NOT pernah membiarkan exception lolos sebagai galat tak tertangani.
14. THE Sandbox_Runtime SHALL mengirim tepat satu `ready` (ber-`session` kosong menurut Requirement 28 kriteria 13) setelah listener `message`, `window.onerror`, dan `unhandledrejection` terpasang, SHALL mengabaikan `load` kedua serta `play`, `pause`, `seek`, `setMode`, dan `resume` yang tiba sebelum `loaded`, dan SHALL memakai `session` dari `load` pertama untuk semua pesan keluar berikutnya.
15. IF `resume` diterima tanpa jeda `interaction` yang belum di-resume, atau `play` diterima di frame `duration_in_frames - 1`, THEN THE Sandbox_Runtime SHALL membiarkan frame tidak berubah dan SHALL NOT mengirim `paused` atau `ended` tambahan.
16. WHEN Sandbox_Runtime sudah mengirim `error`, THE Sandbox_Runtime SHALL menghentikan pemutaran dan heartbeat dan SHALL NOT mengirim pesan lain.
17. THE Sandbox_Runtime SHALL NOT memanggil `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, atau `navigator.sendBeacon`, dan THE Test_Suites SHALL menegaskannya dengan spy yang mencatat nol pemanggilan selama `load` dan pemutaran.
18. FOR ALL urutan acak `play`, `pause`, `seek` (bilangan bulat aman apa pun, termasuk negatif), `setMode`, dan `resume` setelah `loaded`, THE Sandbox_Runtime SHALL hanya mengirim `frame` pada rentang 0 sampai `duration_in_frames - 1`, SHALL mengirim `ended` paling banyak sekali per pemutaran, dan SHALL NOT melempar exception (properti ketahanan).

### Requirement 30: Integrasi pemutar, adaptor, dan scene animation

**User Story:** Sebagai developer frontend, saya ingin animasi masuk ke Stage lewat adaptor yang memakai ulang CanvasPane, PlayerBar, dan logika fast/animate, agar tidak ada jalur pemutar kedua.

#### Acceptance Criteria

1. THE SandboxPlayerRef SHALL mengimplementasikan `addEventListener` dan `removeEventListener` untuk event `frameupdate` (dengan `detail.frame`), `play`, `pause`, dan `ended`, serta metode `play`, `pause`, dan `seekTo`, ditambah `resume` dan `setMode`, dengan menerjemahkannya ke dan dari pesan Sandbox_Protocol.
2. THE SandboxPlayerRef SHALL memancarkan `play` dan `pause` ketika flag `playing` pada pesan `frame` berubah, `frameupdate` untuk setiap pesan `frame` yang diterima, dan `ended` untuk pesan `ended`, SHALL mengantrekan paling banyak 16 pemanggilan metode yang dibuat sebelum `loaded` (pemanggilan tertua dibuang bila antrean penuh) dan menerapkannya berurutan, dan WHILE status Sandbox_Frame adalah `failed`, SHALL mengabaikan setiap pemanggilan tanpa mengirim pesan dan tanpa memancarkan event.
3. THE `useCanvasPlayback` dan `CanvasPane` SHALL menerima tipe struktural yang hanya mendaftar anggota player yang mereka pakai, dengan `PlayerRef` tetap dapat ditugaskan, dan SHALL berperilaku identik untuk setiap scene yang ada.
4. THE `CanvasScene` SHALL mendapat `{kind: "animation", props: {animation: Animation_Reference, fallback}}` dengan `fallback` berupa scene berjenis `lesson`, `visual`, `puzzle`, atau `decision` (bukan `ambient` atau `animation`), dan `sceneDurationFrames` SHALL mengembalikan `animation.duration_in_frames` untuknya.
5. WHILE Animation_Loader belum mengembalikan hasil, atau status Sandbox_Frame adalah `loading` atau `failed`, THE Animation_Scene SHALL merender Fallback_Scene, dan WHILE status adalah `loading` iframe SHALL ter-mount di kotak yang sama dengan `visibility: hidden` dan bukan `display: none`, agar browser tetap merendernya.
6. WHEN `loaded` tiba, THE Animation_Scene SHALL menampilkan iframe satu kali, berhenti merender Fallback_Scene, menyerahkan SandboxPlayerRef ke callback referensi player milik `StageCanvas`, dan mengirim `setMode` dengan Pacing saat ini.
7. WHILE iframe ditampilkan, THE `StageCanvas` SHALL merendernya di kotak 16:9 yang sama dengan player Remotion dan SHALL menyetel `data-canvas-kind` ke `animation`.
8. THE `CanvasPane` SHALL memberikan `[pause_at_frame / duration_in_frames * 100]` sebagai `keyframes` ke `PlayerBar` untuk Animation_Scene yang iframe-nya ditampilkan dan memiliki `pause_at_frame`, dan `[]` untuk Animation_Scene yang iframe-nya ditampilkan tanpa `pause_at_frame`; untuk scene selain `animation` dan selama Fallback_Scene dirender, nilainya SHALL tetap seperti sekarang (`[100]` untuk `puzzle` dan `decision`, `[]` untuk yang lain).
9. WHEN nilai `Pacing` berubah selagi iframe ditampilkan, THE Animation_Scene SHALL mengirim `setMode` dengan nilai baru ke iframe tanpa me-remount-nya.
10. WHEN `interaction.isCorrect` menjadi true selagi scene animasi dengan `pause_at_frame` ditampilkan, THE Animation_Scene SHALL memanggil `resume`, dan jawaban salah SHALL NOT mengirim apa pun ke iframe.
11. THE `StoryViewer` SHALL membangun Animation_Scene hanya bila Flag_Web `on` dan blok pelajaran atau puzzle memuat Animation_Reference yang lolos skema, dengan scene yang seharusnya dibangun sebagai `fallback`.
12. THE Stage SHALL mempertahankan pilihan jawaban, `PuzzleActions`, HP, dan keputusan benar-salah persis seperti sekarang, tanpa pesan dari iframe yang dapat mengubah HP, skor, atau kebenaran.
13. WHILE Flag_Web `off`, THE Stage SHALL mengabaikan setiap Animation_Reference dan SHALL NOT membuat request ke `/api/v1/animations`.
14. WHILE Fallback_Scene dirender oleh Animation_Scene, THE `CanvasPane` SHALL memakai `sceneDurationFrames(fallback)` untuk `useCanvasPlayback`, dan THE `StageCanvas` SHALL menyetel `data-canvas-kind` ke `fallback.kind`.
15. WHEN pesan `paused` beralasan `interaction` diterima dan `interaction.isCorrect` true, THE Animation_Scene SHALL memanggil `resume` tepat sekali per jeda itu, termasuk bila `interaction.isCorrect` sudah true sebelum `loaded`, sebelum jeda tercapai, atau setelah `setMode` ulang.
16. WHEN status Sandbox_Frame menjadi `failed` setelah iframe ditampilkan, THE Animation_Scene SHALL menyerahkan ref Player milik Fallback_Scene ke callback referensi player milik `StageCanvas` pada commit yang sama, dan THE SandboxPlayerRef SHALL melepas semua listener-nya.
17. FOR ALL pesan iframe yang valid (diuji dengan `fast-check`), THE Stage SHALL membiarkan HP dan `interaction.isCorrect` tidak berubah dan SHALL NOT memanggil `validateMultipleChoice`.

### Requirement 31: Fallback total

**User Story:** Sebagai pemain, saya ingin cerita selalu dapat dimainkan walau animasi gagal di fase mana pun, agar fitur baru tidak pernah menurunkan keandalan yang sudah ada.

#### Acceptance Criteria

1. IF pemuatan gagal di fase `urls`, `fetch`, `integrity`, `load`, `runtime`, atau `timeout`, THEN THE Animation_Scene SHALL merender Fallback_Scene tanpa crash.
2. THE Fallback_Scene SHALL identik, dalam jenis dan props, dengan scene yang dirender Stage ketika tidak ada Animation_Reference.
3. THE `StageCanvas` SHALL menyetel `data-animation-status` pada pembungkus kanvas ke `off` untuk scene selain `animation`, dan ke status Animation_Scene (`loading`, `playing`, `paused`, atau `failed:<fase>`) untuk scene `animation`.
4. WHEN status Animation_Scene menjadi `failed:<fase>`, THE Animation_Scene SHALL memanggil `console.warn` tepat satu kali dengan satu argumen string `animation failed:<fase>` (tanpa URL, teks bundle, atau isi pesan) dan SHALL NOT memanggilnya lagi pada mount yang sama.
5. THE Animation_Scene SHALL membungkus Sandbox_Frame dengan React error boundary yang merender Fallback_Scene, dan tidak ada promise rejection yang dibiarkan tak tertangani di fase mana pun.
6. THE Animation_Scene SHALL NOT mencoba ulang otomatis dalam satu mount, kecuali pengulangan unduhan setelah HTTP 403 di dalam Animation_Loader (Requirement 26 kriteria 6), dan mount baru SHALL memanggil `loadAnimation` lagi, yang memakai cache hanya untuk bundle terverifikasi.
7. WHILE bilah player menampilkan player cadangan dan scene berpindah ke iframe, THE `useCanvasPlayback` SHALL berlangganan ulang ke referensi player baru sehingga progres dan jam mengikuti player yang aktif.
8. FOR EACH fase pada kriteria 1, THE Test_Suites SHALL menyuntikkan kegagalan itu dan SHALL menegaskan bahwa Fallback_Scene dirender, tidak ada exception yang sampai ke test runner, dan game dapat terus menjawab puzzle.
9. FOR ALL urutan acak pesan protokol yang valid dan tidak valid serta lompatan timer, THE Animation_Scene SHALL berakhir di salah satu state sandbox (`playing` atau `paused`) atau Fallback_Scene, dan tidak di state lain (properti totalitas).
10. THE Animation_Scene SHALL melaporkan status `loading` dari mount sampai `loaded` (termasuk status `ready` Sandbox_Frame), `playing` bila pesan `frame` terakhir ber-`playing` true, dan `paused` setelah `loaded`, `paused`, atau `ended` bila tidak sedang memutar.
11. IF 48000 ms berlalu sejak mount dan status Animation_Scene masih `loading`, THEN THE Animation_Scene SHALL gagal dengan fase `timeout` dan SHALL mengabaikan pesan sandbox sesudahnya.
12. IF error boundary menangkap exception, THEN THE Animation_Scene SHALL gagal dengan fase `runtime`, menyetel status ke `failed:runtime`, dan memanggil `console.warn` satu kali menurut kriteria 4.
13. WHEN kegagalan fase `runtime` atau `timeout` terjadi setelah `loaded`, THE Animation_Scene SHALL membuang iframe dan merender Fallback_Scene, THE `useCanvasPlayback` SHALL berlangganan ke player cadangan, dan HP, jawaban terpilih, serta hasil `validateMultipleChoice` SHALL deep-equal dengan keadaan sebelum kegagalan.
14. WHILE status Animation_Scene adalah `loading` atau `failed:<fase>`, THE `CanvasPane` SHALL memakai durasi dan `keyframes` milik Fallback_Scene.
15. WHEN Animation_Scene di-unmount sebelum hasil akhir, THE Animation_Scene SHALL membatalkan `signal` loader dan membuang iframe, dan SHALL NOT memanggil `console.warn` atau mengatur state.

### Requirement 32: Keamanan lintas komponen

**User Story:** Sebagai pemilik sistem, saya ingin batas keamanan yang nyata dan terdokumentasi untuk kode buatan LLM, agar pemain, data, dan kredensial tetap aman walau kode itu berniat buruk atau salah.

#### Acceptance Criteria

1. THE Animation_Feature SHALL mengeksekusi kode tulisan Gemini hanya di dalam Verifier_Lambda (di konteks `vm` dalam Worker) dan di dalam iframe Sandbox_Runtime, dan sebuah tes frontend SHALL menegaskan bahwa tidak ada berkas di `frontend/src` di luar `frontend/sandbox-runtime/` yang memuat `eval(`, `new Function(`, atau `import(` dengan argumen selain literal string (kode lama seperti `import("mammoth")` tetap lolos).
2. THE Animation_Feature SHALL memperlakukan batas keamanan yang sebenarnya sebagai iframe `sandbox` tanpa `allow-same-origin`, CSP pada Requirement 27, validasi pesan pada Requirement 28, dan isolasi Verifier_Lambda, dan SHALL mendokumentasikan pemindaian kebijakan statis pada Requirement 7 sebagai pertahanan berlapis dan gerbang kualitas, bukan sebagai batas keamanan.
3. THE Animation_Feature SHALL memperlakukan teks materi dan teks cerita yang ditaruh di prompt sebagai data, seperti pada Requirement 5 kriteria 4.
4. THE Animation_Feature SHALL menjaga kode sumber, prompt, Required_Tokens, key Gemini, teks materi, teks cerita, dan URL presigned di luar semua keluaran log, dan sebuah tes SHALL menjalankan run lengkap yang sukses, gagal, dan dibatalkan dengan string sentinel pada setiap masukan itu dan SHALL menegaskan bahwa tidak ada sentinel yang muncul di keluaran log yang ditangkap.
5. THE Animation_Reader SHALL membatasi pembacaan pada Owner animasi, seperti pada Requirement 21.
6. THE Animation_Feature SHALL membatasi sumber daya dengan sumber paling besar 32768 byte, bundle paling besar 131072 byte, 2000 ms per frame, deadline verifier 50000 ms, timeout Lambda 60 detik, heap Worker 512 MB, dan watchdog sandbox pada Requirement 28, dan SHALL mengakhiri verifikasi yang render-nya tidak berhenti dengan menghentikan Worker.
7. THE Animation_Feature SHALL menetapkan (pin) setiap dependensi baru ke versi persis di `backend/requirements.txt`, `animation-verifier/package.json`, dan `frontend/package.json`, dan THE Test_Suites SHALL menegaskan bahwa setiap dependensi baru di `backend/requirements.txt` memakai `==`, dan di `animation-verifier/package.json` serta `frontend/package.json` tanpa awalan `^`, `~`, `>=`, `*`, atau `latest`.
8. THE Animation_Infra SHALL menjaga bucket animasi tetap privat dengan Block Public Access penuh, SHALL memberi Verifier_Lambda tanpa secret dan tanpa egress jaringan, dan SHALL memberi role `api` akses hanya ke prefix `animations/` dan satu fungsi Lambda itu.
9. THE Docs_Set SHALL mendaftar sisa risiko: loop sinkron tak berujung pada frame yang tidak disampel di browser yang tidak mengisolasi frame bersandbox (T-13), pemakaian `unsafe-eval` di dalam sandbox, kuota per-Owner seumur cookie dan 404 setelah cookie hilang (A-15), pemeriksaan koordinat numerik yang lemah (Requirement 12 kriteria 3), dan fakta bahwa aturan Forbidden_Token hanya melihat frame sampel, sehingga jawaban yang tampil singkat di antara dua frame sampel tidak terdeteksi.
10. THE Docs_Set SHALL menyertakan di daftar periksa browser (Requirement 27 kriteria 9) untuk Chromium dan Firefox sebuah bundle uji, yang dimuat lewat pesan `load` tanpa Verifier_Lambda dan tanpa S3, yang membaca `document.cookie`, `localStorage`, dan `window.parent.document` di dalam sandbox, dan SHALL mencatat per browser bahwa ketiga akses itu melempar `SecurityError`.
11. IF Sandbox_Frame menerima lebih dari 50 pesan yang lolos pemeriksaan `event.source` dan `event.origin` dalam 1000 ms, THEN THE Sandbox_Frame SHALL gagal dengan fase `runtime` dan membuang iframe, dan THE Test_Suites SHALL menegaskannya dengan jsdom dan timer palsu yang mengirim 51 pesan.
12. IF teks materi atau teks cerita memuat penanda batas blok data (Requirement 5 kriteria 4 dan 13), THEN THE Animation_Prompts SHALL menetralkan penanda itu, dan THE Test_Suites SHALL menegaskannya.
13. THE Test_Suites SHALL menjalankan handler Verifier_Lambda dengan string sentinel pada `source`, token, dan pesan Diagnostic, dan SHALL menegaskan bahwa stdout berisi tepat satu baris JSON valid yang tidak memuat sentinel.
14. THE Test_Suites SHALL menegaskan nilai batas ditambah satu: `source` 32769 byte menghasilkan `SIZE_SOURCE_TOO_LARGE`, bundle 131073 byte menghasilkan `BUNDLE_TOO_LARGE`, waktu render satu frame 2001 ms menghasilkan `RENDER_FRAME_TIMEOUT`, total waktu verifier mencapai 50000 ms menghasilkan `VERIFIER_DEADLINE`, dan heap Worker habis menghasilkan `RENDER_RESOURCE_LIMIT`.
15. WHILE Flag_Api true, THE Backend SHALL menjaga level efektif logger `botocore` dan `boto3` pada `WARNING` atau lebih tinggi walau level root `DEBUG`, dan THE Test_Suites SHALL menegaskannya.

### Requirement 33: Observabilitas minimal dan skrip uji asap

**User Story:** Sebagai operator, saya ingin log terstruktur tanpa data sensitif dan satu skrip uji asap, agar saya dapat memeriksa fitur setelah rilis tanpa membuka data pemain.

#### Acceptance Criteria

1. THE Animation_Endpoint SHALL mencatat pada level INFO satu baris per event `animation.start` (kind, cached), `animation.attempt` (attempt, outcome, error_count, warning_count, latency_ms), dan `animation.end` (kode hasil, attempts, total_ms, model, cached), yang hanya memuat bidang itu.
2. THE Verifier_Lambda SHALL mencatat satu baris terstruktur pada Requirement 11 kriteria 6.
3. THE Smoke_Script SHALL berupa skrip Python 3.12 yang hanya memakai pustaka standar, dipanggil sebagai `python3 scripts/verify/animation-smoke.py <base-url>`, dengan `def main() -> int` dan `raise SystemExit(main())`, serta kode keluar 0 bila semua pemeriksaan lulus, 1 pada pemeriksaan gagal pertama (pemeriksaan sisanya tidak dijalankan), dan 2 bila argumen bukan tepat satu URL berawalan `http://` atau `https://` (pesan penggunaan ditulis ke stderr).
4. THE Smoke_Script SHALL memeriksa bahwa `GET /sandbox/runtime.html` mengembalikan HTTP 200 dengan header `Content-Security-Policy` yang persis sama dengan Requirement 27 kriteria 3.
5. THE Smoke_Script SHALL mengirim satu `CreateAnimationRequest` tetap berjenis `lesson`, SHALL mewajibkan event `started` dalam 5 detik sejak request (membuktikan tidak ada proxy yang mem-buffer stream), SHALL mewajibkan event `done` dalam 300 detik, dan SHALL memeriksa bahwa urutan event sesuai Requirement 17.
6. THE Smoke_Script SHALL memanggil `GET /api/v1/animations/{animation_id}` dengan cookie jar dari request pertama, mengunduh `main.js` dari URL yang dikembalikan, dan memeriksa bahwa SHA-256-nya sama dengan `bundle_sha256`.
7. THE Smoke_Script SHALL mengulang request yang sama dan mewajibkan `cached` true, tanpa event `stage`, dan event `done` dalam 5 detik.
8. THE Smoke_Script SHALL memanggil `GET` yang sama dengan cookie jar baru dan mewajibkan HTTP 404 dengan badan `{"detail": "animation not found"}`.
9. THE Smoke_Script SHALL mencetak ke stdout tepat satu baris per pemeriksaan berbentuk `<nama>: PASS` atau `<nama>: FAIL`, dan SHALL NOT mencetak URL presigned, kode sumber, teks bundle, nilai cookie, `animation_id`, atau traceback.
10. THE Docs_Set SHALL menyatakan bahwa satu run Smoke_Script yang sukses memakai N panggilan Gemini dan N invokasi Lambda (1 <= N <= 4), bahwa request ulang yang dijawab dari cache memakai 0, dan bahwa setiap run meninggalkan satu baris `animations` dan tiga objek S3.
11. THE Animation_Endpoint SHALL menulis setiap baris log berupa objek JSON satu baris dengan kunci `event` dan hanya bidang pada kriteria 1, dengan `latency_ms` dan `total_ms` berupa bilangan bulat 0 atau lebih; untuk setiap request yang mencapai stream (termasuk saat event `error` atau klien terputus), THE Animation_Endpoint SHALL menulis tepat satu `animation.start` sebagai baris pertama dan tepat satu `animation.end` sebagai baris terakhir, dan SHALL NOT menulis `animation.attempt` bila `cached` true; bidang `attempts` pada log SHALL berisi jumlah Gemini_Call yang dimulai di run itu (0 untuk Idempotent_Hit), sedangkan `attempts` pada `done.animation`, Animation_Registry, dan Animation_Manifest adalah nilai tercatat milik animasi itu (Requirement 18 kriteria 7).
12. THE Animation_Endpoint SHALL mengisi `outcome` pada `animation.attempt` dengan salah satu dari `verified`, `verify_failed`, `extract_failed`, `repair_unchanged`, dan `gemini_failed`, dan SHALL mengisi kode hasil pada `animation.end` dengan `OK` untuk `done`, kode event `error` untuk kegagalan, dan `CANCELLED` (hanya sebagai nilai log, bukan kode galat) saat klien terputus.
13. IF sebuah pemeriksaan Smoke_Script melempar exception (timeout, koneksi ditolak, JSON atau SSE tidak valid), menerima HTTP non-200, atau menerima event `error`, THEN THE Smoke_Script SHALL mencetak `FAIL` untuk pemeriksaan itu dan keluar dengan kode 1 tanpa traceback.
14. WHEN Smoke_Script mengirim request pertama, THE Smoke_Script SHALL mewajibkan `started.cached` false, sedikitnya satu event `stage`, `done.cached` false, dan `attempts` 1 sampai 4, dan THE Smoke_Script SHALL mewajibkan `GET /sandbox/runtime.js` menjawab HTTP 200 dengan ukuran paling besar 1048576 byte serta respons `runtime.html` memuat header `X-Content-Type-Options: nosniff`.
15. THE Test_Suites SHALL menjalankan Smoke_Script terhadap server HTTP lokal palsu untuk kode keluar 0, 1, dan 2, SHALL menegaskan bahwa tidak ada sentinel URL presigned atau cookie di stdout maupun stderr, dan SHALL menegaskan bahwa literal CSP di skrip sama dengan konstanta bersama pada Requirement 27 kriteria 3.

### Requirement 34: Infrastruktur Terraform

**User Story:** Sebagai pemilik sistem, saya ingin semua resource fitur ini didefinisikan di Terraform dengan biaya terkendali, agar infrastruktur dapat ditinjau, direproduksi, dan dibatasi.

#### Acceptance Criteria

1. THE Animation_Infra SHALL mendefinisikan bucket S3 bernama `lore-prod-animations-<ACCOUNT_ID>` (id akun dari `data.aws_caller_identity`) dengan `force_destroy` false, Block Public Access dengan keempat flag true, ownership controls `BucketOwnerEnforced`, enkripsi default `AES256`, dan tanpa versioning.
2. THE Animation_Infra SHALL memasang bucket policy yang menolak `s3:*` untuk setiap request yang `aws:SecureTransport`-nya false.
3. THE Animation_Infra SHALL memasang konfigurasi CORS yang hanya mengizinkan metode `GET`, dengan origin yang diizinkan sama dengan `https://<site_address>` bila `site_address` diatur, `http://<Elastic IP web>`, dan entri variabel `animation_cors_extra_origins` (default daftar kosong).
4. THE Animation_Infra SHALL memasang konfigurasi lifecycle yang satu-satunya aturannya membatalkan multipart upload yang tidak selesai setelah 7 hari, tanpa kedaluwarsa objek.
5. THE Animation_Infra SHALL mendefinisikan repositori ECR privat bernama `lore-prod-animation-verifier` dengan `image_tag_mutability` `IMMUTABLE`, `scan_on_push` true, enkripsi `AES256`, dan lifecycle policy yang menyimpan 5 image terbaru.
6. THE Animation_Infra SHALL mendefinisikan fungsi Lambda `lore-prod-animation-verifier` dengan `package_type` `Image`, `memory_size` 1536, `timeout` 60, `architectures` `["x86_64"]`, `vpc_config` memakai subnet `data_a` dan `data_b` serta security group verifier, tanpa `reserved_concurrent_executions`, tanpa function URL, dan `ignore_changes = [image_uri]`, dibuat hanya bila variabel `animation_verifier_image_tag` tidak kosong (regex `^sha-[0-9a-f]{7}$` bila diatur).
7. THE Animation_Infra SHALL mendefinisikan log group `/aws/lambda/lore-prod-animation-verifier` dengan `retention_in_days` 7.
8. THE Animation_Infra SHALL mendefinisikan security group untuk Verifier_Lambda tanpa rule ingress dan tanpa rule egress.
9. THE Animation_Infra SHALL mendefinisikan role eksekusi `lore-prod-animation-verifier-exec` yang dipercaya `lambda.amazonaws.com`, dengan inline policy yang mengizinkan `logs:CreateLogStream` dan `logs:PutLogEvents` pada ARN log group serta aksi `ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface`, `ec2:AssignPrivateIpAddresses`, dan `ec2:UnassignPrivateIpAddresses`, dan tanpa managed policy terpasang.
10. THE Animation_Infra SHALL menambahkan ke role `lore-prod-api-instance` sebuah inline policy yang mengizinkan `s3:PutObject` dan `s3:GetObject` pada `arn:aws:s3:::lore-prod-animations-<ACCOUNT_ID>/animations/*`, `s3:ListBucket` pada bucket dengan kondisi `s3:prefix` sama dengan `animations/*`, dan `lambda:InvokeFunction` pada ARN fungsi yang dibangun dari nama fungsi, sehingga policy valid selagi fungsi belum ada.
11. THE Animation_Infra SHALL menyetel `http_put_response_hop_limit` ke 2 pada `aws_instance.api` saja, dengan `http_tokens` tetap `required`, dan SHALL membiarkan `aws_instance.web` dan `aws_instance.nat` tetap 1 (temuan T-1).
12. THE Animation_Infra SHALL membuat parameter SSM `String` di bawah `/lore/prod/api/env/` bernama `ANIMATION_ENABLED` (nilai dari variabel `animation_enabled`, default `false`), `ANIMATION_RATE_PER_MINUTE_IP`, `ANIMATION_DAILY_PER_IP`, `ANIMATION_MAX_CONCURRENT_PER_IP`, `ANIMATION_MAX_CONCURRENT_GLOBAL`, `ANIMATION_MAX_ATTEMPTS`, `ANIMATION_DEADLINE_MS`, `ANIMATION_BUCKET`, `ANIMATION_VERIFIER_FUNCTION`, dan `AWS_REGION`, dengan nilai pada kriteria 18, dan SHALL NOT membuat `AI_ANIMATION_MODEL` secara default.
13. THE Animation_Infra SHALL menandai setiap resource baru yang dapat diberi tag dengan tag umum, `Component` sama dengan `animation`, dan `Name` sama dengan `lore-prod-animation-<detail>`, kecuali parameter di bawah `/lore/prod/api/env/` yang memakai `Component` sama dengan `api` dan `Name` sama dengan `lore-prod-api-env-<nama parameter huruf kecil>`.
14. THE Animation_Infra SHALL NOT mengubah berkas apa pun di bawah `deploy/` dan SHALL NOT menambah output atau mendokumentasikan nilai yang memuat id akun AWS.
15. WHEN pull request infra pertama direncanakan, THE Animation_Infra SHALL menghasilkan plan tanpa aksi `delete` atau replace untuk `aws_instance`, `aws_db_instance`, atau `aws_eip`, dengan pembaruan in-place `metadata_options` pada `aws_instance.api` sebagai satu-satunya perubahan pada instance yang sudah ada.
16. THE Animation_Infra SHALL lolos `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`, dan skrip Cost_Guardrails, dan SHALL diterapkan hanya oleh job apply CI setelah pull request yang ditinjau.
17. THE Animation_Infra SHALL bergantung pada `deploy/common/render-env.sh` generik yang sudah ada, yang merender setiap parameter di bawah `/lore/prod/api/env/`, dan THE Test_Suites SHALL memuat tes yang menjalankan `render-env.sh api` dengan perintah `aws` tiruan yang mengembalikan nama parameter baru dan menegaskan bahwa setiap baris `NAME="value"` muncul di berkas hasil render.
18. THE Animation_Infra SHALL menyetel parameter SSM pada kriteria 12 ke nilai berikut: `ANIMATION_BUCKET` sama dengan `lore-prod-animations-<ACCOUNT_ID>`, `ANIMATION_VERIFIER_FUNCTION` sama dengan `lore-prod-animation-verifier` (juga selagi Lambda belum dibuat), `AWS_REGION` sama dengan `var.region`, `ANIMATION_ENABLED` sama dengan `true` atau `false` huruf kecil, serta `ANIMATION_RATE_PER_MINUTE_IP`, `ANIMATION_DAILY_PER_IP`, `ANIMATION_MAX_CONCURRENT_PER_IP`, `ANIMATION_MAX_CONCURRENT_GLOBAL`, `ANIMATION_MAX_ATTEMPTS`, dan `ANIMATION_DEADLINE_MS` berturut-turut `4`, `30`, `1`, `2`, `4`, dan `240000`.
19. THE Animation_Infra SHALL mendefinisikan `aws_cloudwatch_log_group.animation_verifier` tanpa bergantung pada `animation_verifier_image_tag`, dan fungsi Lambda SHALL merujuknya lewat `logging_config.log_group`, sehingga plan dengan tag kosong memuat log group dan tidak memuat fungsi.
20. IF `animation_verifier_image_tag` tidak kosong dan tidak cocok `^sha-[0-9a-f]{7}$`, atau `animation_enabled` true sementara `animation_verifier_image_tag` kosong, THEN `terraform plan` SHALL gagal (lewat validasi variabel atau `precondition`).
21. WHEN pull request menyetel `animation_verifier_image_tag` atau `animation_enabled`, THE Animation_Infra SHALL menghasilkan plan tanpa perubahan pada `aws_instance`, `aws_db_instance`, dan `aws_eip`, dengan perubahan `animation_enabled` hanya berupa pembaruan in-place `aws_ssm_parameter` `ANIMATION_ENABLED`.
22. IF entri `animation_cors_extra_origins` tidak cocok `^https?://[^/*]+$` atau jumlah entri lebih dari 5, THEN `terraform plan` SHALL gagal.
23. THE Animation_Infra SHALL mengonfigurasi CORS bucket dengan tepat satu aturan yang `allowed_methods`-nya `["GET"]`, tanpa `allowed_headers`, dan tanpa origin `*`.
24. THE Animation_Infra SHALL menulis policy dengan kondisi `s3:prefix` pada `s3:ListBucket` memakai `StringLike`, `logs:CreateLogStream` dan `logs:PutLogEvents` pada ARN log group dengan akhiran `:*`, dan statement untuk aksi `ec2` pada kriteria 9 (`*NetworkInterface*` dan `*PrivateIpAddresses`) memakai Resource `*`, dan SHALL NOT mengizinkan `logs:CreateLogGroup` pada role eksekusi serta SHALL NOT menyetel `reserved_concurrent_executions` pada fungsi.

### Requirement 35: IAM bootstrap manual dan guardrail biaya

**User Story:** Sebagai pemilik akun, saya ingin perubahan izin yang menyentuh guardrail dijalankan manual dengan persetujuan saya dan dilindungi checker, agar fitur ini tidak melonggarkan batas biaya diam-diam.

#### Acceptance Criteria

1. THE Bootstrap_Admin_Step SHALL mengubah `infra/bootstrap/policies/lore-gh-apply-policy.json` untuk mengizinkan, dengan cakupan pada satu bucket, satu repositori ECR, satu fungsi, dan satu log group fitur ini, aksi pengelolaan yang dibutuhkan Terraform untuk resource itu, dan `iam:PassRole` ke `lambda.amazonaws.com` untuk role bernama `lore-prod-animation-*`.
2. THE Bootstrap_Admin_Step SHALL mengubah `infra/bootstrap/policies/lore-guardrail-deny.json` dengan membuang `logs:CreateLogGroup` dari pernyataan `DenyExpensiveServices` yang menyeluruh dan menambahkan pernyataan Deny terpisah untuk `logs:CreateLogGroup` dengan `NotResource` sama dengan ARN log group `/aws/lambda/lore-prod-animation-verifier`.
3. THE Bootstrap_Admin_Step SHALL mengubah `infra/bootstrap/policies/lore-gh-deploy-policy.json` untuk mengizinkan `ecr:GetAuthorizationToken`, aksi push ECR pada satu repositori itu, dan `lambda:UpdateFunctionCode`, `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, serta `lambda:InvokeFunction` pada satu fungsi itu, dan SHALL mengandalkan pernyataan `SsmReleaseImageTag` yang sudah ada untuk parameter tag `/lore/prod/verifier/release/image_tag`.
4. THE Bootstrap_Admin_Step SHALL menjaga `bootstrap.sh` idempoten (run kedua tidak mengubah apa pun) dan SHALL memperbarui `infra/bootstrap/README.md` dengan pernyataan baru serta dua pemeriksaan read-only `aws iam simulate-principal-policy` untuk `lore-gh-apply` dan aksi `logs:CreateLogGroup`: log group `/aws/lambda/lore-prod-animation-verifier` mengharapkan `allowed` dan log group lain mengharapkan `explicitDeny`, dan hanya admin yang menjalankan pemeriksaan itu, bukan agen.
5. THE Bootstrap_Admin_Step SHALL ditandai di deskripsi pull request dan di runbook sebagai menunggu persetujuan pengguna, dan SHALL selesai sebelum pull request infra di-merge.
6. THE Animation_Feature SHALL diimplementasikan tanpa menjalankan skrip bootstrap, perintah `aws` apa pun yang mengubah resource, `terraform apply`, atau `terraform destroy`, dengan verifikasi lokal dibatasi pada `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`, `check-cost-static infra`, `test-checkers.py -v`, dan `shellcheck`.
7. THE Cost_Guardrails SHALL menambahkan `animation` ke `ALLOWED_COMPONENTS` dan `aws_lambda_function`, `aws_ecr_repository`, serta `aws_s3_bucket` ke `NAME_REQUIRED_TYPES`, dan SHALL menambahkan `aws_lambda_provisioned_concurrency_config`, `aws_lambda_function_url`, dan `aws_apigatewayv2_api` ke denylist.
8. THE Cost_Guardrails SHALL membuat `check-cost` dan `check-cost-static` menolak fungsi Lambda dengan `memory_size` di atas 1536, `timeout` di atas 60, `package_type` selain `Image`, atau `reserved_concurrent_executions` di atas 0, menolak repositori ECR tanpa `scan_on_push` true atau dengan tag yang dapat diubah, dan menolak public access block S3 dengan flag false apa pun atau `aws_s3_bucket_acl` apa pun.
9. THE Cost_Guardrails SHALL mengizinkan `aws_cloudwatch_log_group` hanya untuk alamat resource `aws_cloudwatch_log_group.animation_verifier` dengan `retention_in_days` 7 dan nama `/aws/lambda/lore-prod-animation-verifier` pada plan, dan SHALL tetap menolak setiap log group lain.
10. THE Cost_Guardrails SHALL menambahkan fixture plan valid yang memuat setiap resource baru dan satu fixture tidak valid per kondisi yang ditolak di `scripts/ci/fixtures/`, dan SHALL menambahkan tes unit ke `scripts/ci/test-checkers.py` untuk setiap aturan sementara 7 tes yang sudah ada tetap lulus.
11. THE Docs_Set SHALL memperbarui `docs/infra/07-cost-guardrails.md` (baris allowlist untuk bucket S3, ECR, Lambda, dan satu log group, alasan pengecualian, dan estimasi tambahan biaya bulanan di bawah US$5 menurut A-6) dan `docs/infra/08-tagging.md` (Component `animation`).
12. THE Test_Suites SHALL memuat tes di `scripts/ci/test-checkers.py` yang menegaskan bahwa `lore-guardrail-deny.json` berupa JSON valid, `DenyExpensiveServices` tidak memuat `logs:CreateLogGroup`, dan tepat satu pernyataan Deny ber-`Sid` unik memuat hanya `logs:CreateLogGroup` dengan `NotResource` `arn:aws:logs:<AWS_REGION>:<ACCOUNT_ID>:log-group:/aws/lambda/lore-prod-animation-verifier:*`.
13. THE Test_Suites SHALL menegaskan bahwa `lore-gh-apply-policy.json` memuat pernyataan `iam:PassRole` yang terpisah dari `PassRoleToEc2` dengan `Resource` `arn:aws:iam::<ACCOUNT_ID>:role/lore-prod-animation-*` dan kondisi `iam:PassedToService` sama dengan `lambda.amazonaws.com`, dan bahwa `PassRoleToEc2` tidak berubah.
14. THE Test_Suites SHALL menegaskan bahwa ketiga berkas policy yang diubah berupa JSON valid dengan `Version` `2012-10-17`, berukuran paling besar 6144 karakter tanpa spasi putih, tanpa id akun 12 digit literal, dan bahwa di `lore-gh-deploy-policy.json` hanya `ecr:GetAuthorizationToken` yang ber-`Resource` `*`.
15. IF fungsi Lambda memiliki `memory_size` 1537, `timeout` 61, `package_type` yang hilang, atau salah satu dari ketiga atribut itu bernilai tak-literal, THEN THE Cost_Guardrails SHALL keluar dengan kode bukan 0 dan mencetak alamat resource itu.
16. WHEN fungsi Lambda memiliki `memory_size` 1536 dengan `timeout` 60, THE Cost_Guardrails SHALL meloloskannya.
17. IF berkas `.tf` mendeklarasikan `aws_cloudwatch_log_group` bernama selain `animation_verifier`, THEN `check-cost-static` SHALL keluar dengan kode bukan 0 dan mencetak berkas serta nama itu.

### Requirement 36: Flag, urutan rilis, dan rollback

**User Story:** Sebagai pemilik sistem, saya ingin fitur dapat dinyalakan bertahap dan dimatikan cepat tanpa kehilangan data, agar risiko rilis kecil.

#### Acceptance Criteria

1. THE Flag_Api SHALL default ke false, dan THE Flag_Web SHALL dibaca sebagai ekspresi literal `process.env.NEXT_PUBLIC_ANIMATIONS === "on"`, default `off` lewat `ARG NEXT_PUBLIC_ANIMATIONS=off` di `frontend/Dockerfile`.
2. THE Web_Release SHALL memberikan `NEXT_PUBLIC_ANIMATIONS=${{ vars.NEXT_PUBLIC_ANIMATIONS || 'off' }}` sebagai build argument dan SHALL menambahkan `frontend/sandbox-runtime/**` dan `frontend/scripts/**` ke filter path-nya, sehingga flag web diubah lewat variabel repositori GitHub dan run ulang.
3. THE Animation_Feature SHALL dirilis dengan urutan: (1) Bootstrap_Admin_Step disetujui dan selesai, (2) infra apply pull request pertama dengan `animation_enabled` false dan tanpa Lambda, (3) image verifier pertama dirilis oleh Verifier_Release (hanya push ke ECR dan penulisan tag `/lore/prod/verifier/release/image_tag`; `update-function-code` dan invokasi fixture dilewati selagi fungsi belum ada, lihat Requirement 37 kriteria 11), (4) infra apply pull request kedua yang menyetel `animation_verifier_image_tag`, yang membuat Lambda, (5) rilis api dan rilis web dengan Flag_Api false dan `NEXT_PUBLIC_ANIMATIONS` `off`, (6) pull request yang menyetel `animation_enabled` ke true, diterapkan dan diikuti redeploy api, lalu run Smoke_Script yang keluar dengan kode 0, (7) variabel repositori `NEXT_PUBLIC_ANIMATIONS` disetel ke `on` dan `release-web` dijalankan ulang.
4. THE Docs_Set SHALL menyatakan bahwa Flag_Web `on` hanya diizinkan setelah daftar periksa browser pada Requirement 27 kriteria 9 lulus, run Smoke_Script pada langkah 6 lulus, pengukuran memori pada Requirement 41 tercatat dalam batasnya, dan estimasi biaya tercatat dalam batas A-6.
5. WHILE Flag_Api false, THE Animation_Endpoint SHALL menjawab HTTP 503 dengan `ANIMATION_NOT_CONFIGURED` untuk request yang lolos rate limit, body, JSON, model request, dan `PROVIDER_NOT_CONFIGURED` (urutan pada Requirement 15 kriteria 6), dan THE Animation_Reader SHALL menjawab HTTP 503 dengan `ANIMATION_NOT_CONFIGURED` yang sama untuk setiap `animation_id`, termasuk yang bukan UUID, tanpa query database.
6. WHILE Flag_Api false dan Flag_Web `on`, THE Generation_Flow SHALL mengirim tepat satu POST, SHALL menandai semua target yang tersisa `skipped` setelah jawaban `ANIMATION_NOT_CONFIGURED` pertama, dan SHALL memanggil `onDone` tepat sekali dengan cerita tanpa Animation_Reference baru.
7. WHILE Flag_Api false dan Flag_Web `on`, THE Stage SHALL memutar setiap Animation_Reference yang ada lewat Fallback_Scene.
8. THE Docs_Set SHALL memuat prosedur rollback dengan langkah: setel `animation_enabled` ke false lewat pull request (atau perubahan SSM manual darurat yang disusul pull request yang memulihkan kesamaan) dan redeploy api; setel variabel repositori ke `off` dan jalankan ulang `release-web`; jalankan ulang `release-verifier` dengan tag sebelumnya lewat `workflow_dispatch`; jalankan ulang `release-api` dengan tag sebelumnya.
9. WHEN fitur di-rollback, THE Animation_Store dan THE Animation_Registry SHALL mempertahankan setiap objek dan baris, dan THE Stage SHALL tetap memutar cerita lewat Fallback_Scene.
10. THE Animation_Feature SHALL NOT mengubah `deploy/web/Caddyfile`, `deploy/api/compose.yml`, atau `deploy/common/*`, agar tidak ada instance web atau api yang diganti (temuan T-6).
11. IF run Smoke_Script pada langkah (6) keluar dengan kode bukan 0, atau RSS puncak melebihi 600 MiB, THEN THE Docs_Set SHALL melarang langkah (7) dan SHALL mewajibkan rollback `animation_enabled` ke false.
12. IF `animation_enabled` true sementara `animation_verifier_image_tag` kosong, THEN `terraform plan` SHALL gagal lewat `precondition` pada parameter SSM `ANIMATION_ENABLED`, dan THE Test_Suites SHALL menegaskan di `scripts/ci/test-checkers.py` bahwa `precondition` itu ada.
13. THE Test_Suites SHALL menegaskan secara statis bahwa `frontend/Dockerfile` memuat `ARG NEXT_PUBLIC_ANIMATIONS=off` diikuti `ENV NEXT_PUBLIC_ANIMATIONS=${NEXT_PUBLIC_ANIMATIONS}`, bahwa `release-web.yml` memuat build argument persis seperti kriteria 2 dan kedua filter path, dan bahwa nilai `"ON"`, `"true"`, `"1"`, dan `""` terbaca sebagai Flag_Web `off`.
14. THE Docs_Set SHALL menyatakan bahwa Flag_Web dimatikan dengan `workflow_dispatch` `release-web` dengan input `tag` kosong (rebuild), karena `tag` yang terisi memakai ulang image dengan flag lama.
15. THE Docs_Set SHALL mewajibkan, sebelum run Smoke_Script pada langkah (6), bahwa `GET /health/ai` mengembalikan `configured` true, `animation.enabled` true, dan `animation.configured` true.

### Requirement 37: CI/CD dan Verifier_Release

**User Story:** Sebagai developer, saya ingin CI memeriksa seluruh komponen baru dan rilis verifier yang otomatis dengan rollback, agar tidak ada langkah manual yang rawan salah.

#### Acceptance Criteria

1. THE CI_Pipeline SHALL menambahkan job `verifier` yang berjalan di `animation-verifier/` dengan Node 22: `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npx vitest run` termasuk korpus, dan `docker build` image Lambda tanpa push; lalu job itu SHALL menjalankan image hasil build lewat Lambda Runtime Interface Emulator (`--memory 1536m --read-only --tmpfs /tmp`) dengan setiap Main_File di `fixtures/good/` dan `fixtures/bad/` (`curl --max-time 60`), dan SHALL menggagalkan job bila `ok` atau daftar `code` terurut berbeda dari hasil Vitest.
2. THE CI_Pipeline SHALL menambahkan job `contracts` yang menjalankan `python3 scripts/sync-animation-contract.py --check` dan `python3 scripts/ci/check-animation-versions.py`.
3. THE CI_Pipeline SHALL mempertahankan job `web`, `api`, `docker`, dan `terraform` menjalankan tes baru: job `web` SHALL menjalankan build sandbox lewat `npm run build`, job `api` SHALL memasang dependensi baru dan menjalankan `ruff`, `alembic upgrade head`, dan `pytest -q`, dan job `terraform` SHALL menjalankan `test-checkers.py` yang diperluas dan `shellcheck` pada skrip shell baru.
4. THE Verifier_Release SHALL berupa workflow `.github/workflows/release-verifier.yml` yang dipicu oleh push ke `main` untuk perubahan di bawah `animation-verifier/`, `scripts/ci/verifier-release.sh`, dan berkas workflow, dan oleh `workflow_dispatch` dengan `tag` rollback opsional.
5. THE Verifier_Release SHALL membangun image, mendorongnya ke ECR dengan tag `sha-<7 karakter>` lewat OIDC dengan role `lore-gh-deploy` di environment `production-release`, dan SHALL melewati push bila tag itu sudah ada.
6. THE Verifier_Release SHALL, setelah image ada di ECR, menjalankan `aws lambda update-function-code`, menunggu `function-updated`, dan memanggil fungsi dengan satu Main_File `fixtures/good/` dan satu `fixtures/bad/`, dengan kewajiban invokasi tanpa `FunctionError`, `ok` true untuk fixture bagus, serta `ok` false untuk fixture buruk dengan semua `code` di `expected.json` dan tanpa `code` berawalan `VERIFIER_`; baru setelah itu THE Verifier_Release SHALL menulis tag ke `/lore/prod/verifier/release/image_tag` dengan tag `Project` sama dengan `lore`, `Environment` sama dengan `prod`, `Component` sama dengan `animation`, `ManagedBy` sama dengan `github-actions`, dan `Repo` sama dengan `$GITHUB_REPOSITORY`; pengecualian saat fungsi belum ada diatur pada kriteria 11 dan berlaku untuk kriteria 6 dan 7.
7. IF pemeriksaan invokasi gagal, THEN THE Verifier_Release SHALL me-rollback fungsi ke tag sebelumnya yang dibaca dari parameter dan SHALL menggagalkan job.
8. THE Verifier_Release SHALL menaruh logikanya di `scripts/ci/verifier-release.sh` dengan `set -euo pipefail` dan helper `fail()` seperti `scripts/ci/ssm-deploy.sh`, dan workflow SHALL memakai concurrency group `lore-prod-deploy-verifier` tanpa membatalkan run yang sedang berjalan.
9. THE CI_Pipeline dan THE Verifier_Release SHALL menetapkan (pin) setiap action pihak ketiga ke commit SHA, seperti workflow yang sudah ada, dan SHALL NOT menyimpan secret di GitHub.
10. THE CI_Pipeline SHALL memiliki pemeriksaan baru `ci/verifier` dan `ci/contracts` yang ditambahkan ke required checks ruleset `protection-main`, yang merupakan pengaturan repositori manual dan menunggu persetujuan pengguna.
11. IF fungsi `lore-prod-animation-verifier` belum ada (`ResourceNotFoundException`), THEN THE Verifier_Release SHALL tetap mendorong image ke ECR dan menulis tag ke `/lore/prod/verifier/release/image_tag`, SHALL melewati `update-function-code` dan invokasi, SHALL mencetak `[warn]`, dan SHALL keluar dengan kode 0.
12. IF tag tidak cocok `^sha-[0-9a-f]{7}$` atau tag rollback tidak ada di ECR, THEN THE Verifier_Release SHALL memanggil `fail()` (keluar dengan kode 1) sebelum `update-function-code` dan tanpa menulis parameter.
13. THE Verifier_Release SHALL membangun image satu platform `linux/amd64` dengan `provenance: false` dan `sbom: false`, karena Lambda menolak manifest OCI index.
14. THE Test_Suites SHALL memuat tes `unittest` di `scripts/ci/test-checkers.py` untuk `verifier-release.sh` dengan `aws` tiruan di `PATH` yang mencakup: sukses (urutan `update-function-code`, `wait function-updated`, dua `invoke`, `put-parameter`); fixture buruk dengan `ok` true (rollback, keluar 1, tanpa `put-parameter`); fungsi tidak ada (keluar 0, `put-parameter` ada, tanpa `update-function-code` dan `invoke`); dan tag tidak valid (keluar 1).

### Requirement 38: Pengujian

**User Story:** Sebagai developer, saya ingin korpus fixture, tes properti, dan tes kontrak lintas bahasa, agar keandalan dan konsistensi dibuktikan otomatis.

#### Acceptance Criteria

1. THE Test_Suites SHALL memuat di `animation-verifier/fixtures/good/` sedikitnya 8 Main_File: satu `lesson` untuk masing-masing dari lima jenis `visual`, satu `puzzle` dengan `pauseAtFrame`, satu yang memakai `Sequence` dan `Series`, dan satu yang memakai `interpolate`, `spring`, dan `Easing`, masing-masing dengan berkas pendamping berisi jenis, Required_Tokens, dan Forbidden_Tokens, dan Animation_Verifier SHALL mengembalikan `ok` true dengan nol Diagnostic galat untuk masing-masing.
2. THE Test_Suites SHALL memuat di `animation-verifier/fixtures/bad/` sedikitnya satu Main_File per kode yang tercantum di sini (sedikitnya 31 berkas) dengan `expected.json` yang memetakan setiap berkas ke kode Diagnostic yang minimal harus dihasilkannya, mencakup `SIZE_SOURCE_TOO_LARGE`, `ENCODING_INVALID`, `POLICY_JSX_SYNTAX`, `POLICY_IMPORT_DISALLOWED`, `POLICY_DYNAMIC_IMPORT`, `POLICY_FORBIDDEN_IDENTIFIER`, `POLICY_FORBIDDEN_MEMBER`, `POLICY_FORBIDDEN_PROPERTY`, `POLICY_DYNAMIC_ELEMENT`, `POLICY_FORBIDDEN_ELEMENT`, `POLICY_FORBIDDEN_ATTRIBUTE`, `POLICY_URL_LITERAL`, `POLICY_COLOR_LITERAL`, `POLICY_META_INVALID`, `META_PAUSE_REQUIRED`, `META_PAUSE_FORBIDDEN`, `POLICY_EXPORT_MISSING`, `POLICY_EXPORT_UNEXPECTED`, `ESLINT_LORE_NO_MODULE_STATE`, `ESLINT_LORE_USES_FRAME`, satu galat `TSC_`, `RENDER_EXCEPTION`, `RENDER_CONSOLE_ERROR`, `RENDER_DOM_LIMIT`, `RENDER_EMPTY`, `RENDER_META_MISMATCH`, `RENDER_FRAME_TIMEOUT`, `RENDER_NONDETERMINISTIC`, `RENDER_RESOURCE_LIMIT`, `FIDELITY_TOKEN_MISSING`, dan `FIDELITY_FORBIDDEN_TOKEN_VISIBLE`, dan SHALL mencakup `BUNDLE_TOO_LARGE` dan `BUNDLE_UNEXPECTED_REQUIRE`, yang tidak dapat dicapai sumber mana pun dalam batas ukuran, dengan tes unit yang memanggil langkah bundle secara langsung dengan batas yang ditimpa atau bundle rekayasa.
3. THE Test_Suites SHALL memuat tes berbasis properti, memakai `fast-check` di verifier dan frontend serta parametrisasi berbenih (sedikitnya 40 benih, seperti pada tes backend yang sudah ada) di backend, untuk properti berikut: validasi total berkas kontrak terhadap JSON sembarang (tidak pernah melempar); determinisme verifier (Requirement 6 kriteria 12); soundness kebijakan untuk setiap item terlarang (Requirement 7 kriteria 13); terminasi agent dalam batas percobaan dan waktu (Requirement 13 kriteria 12); ketahanan dan round-trip protokol (Requirement 28 kriteria 10); totalitas fallback (Requirement 31 kriteria 9); round-trip dan invarian pemotongan SSE (Requirement 17 kriteria 9 dan Requirement 25 kriteria 7); stabilitas dan sensitivitas Request_Hash (Requirement 18 kriteria 2); stabilitas pemilihan target dan preservasi pelekatan (Requirement 23 kriteria 3 dan 8); ekuivalensi `sha256Hex` (Requirement 26 kriteria 12); idempotensi dan round-trip ekstraksi (Requirement 5 kriteria 11); dan cakupan token (Requirement 12 kriteria 6).
4. THE Test_Suites SHALL memuat tes kontrak lintas bahasa yang membaca fixture yang sama dari `backend/tests/fixtures/animation/` di Pytest dan di Vitest untuk: Animation_Reference, `CreateAnimationRequest`, Verifier_Result, Animation_Manifest, respons Reader, dan satu stream SSE lengkap.
5. THE Test_Suites SHALL berjalan tanpa jaringan, tanpa AWS, dan tanpa Gemini: tes backend SHALL memakai `httpx2.MockTransport` untuk Gemini, klien Lambda palsu, dan `botocore.stub.Stubber` atau fake di memori untuk S3, tanpa dependensi dev baru seperti `moto`, dan tes yang bergantung pada waktu SHALL memakai jam palsu dan timer palsu.
6. THE Test_Suites SHALL menguji protokol dan Sandbox_Frame di jsdom dengan jendela iframe palsu, dan SHALL menyerahkan perilaku browser asli ke daftar periksa manual pada Requirement 27 kriteria 9.
7. THE Test_Suites SHALL membiarkan semua tes yang ada tidak diubah dan tetap lulus, termasuk Golden_Test dengan 40 dari 40 lulus, tes `frontend/tests/stage/`, serta tes `test_ai_*` dan projects di backend, kecuali penambahan yang secara eksplisit diminta requirement lain (misalnya `scripts/ci/test-checkers.py` pada Requirement 3, 35, 36, 37, dan 41).
8. THE CI_Pipeline dan verifikasi lokal SHALL memakai gerbang berikut: `ruff check . --no-cache`, `ruff format --check .`, `alembic upgrade head`, dan `pytest -q` di `backend/`; `npm run lint`, `npx next typegen`, `npx tsc --noEmit`, `npx vitest run --testTimeout=60000`, dan `npm run build` di `frontend/`; lint, `tsc --noEmit`, `vitest run`, dan run korpus pada image di `animation-verifier/`; `terraform fmt -check`, `init -backend=false`, `validate`, `check-cost-static`, `test-checkers.py`, dan `shellcheck` untuk infra; serta `sync-animation-contract.py --check` dan `check-animation-versions.py`, dan setiap gerbang SHALL lulus dengan 0 galat dan 0 peringatan bila alat melaporkan peringatan.
9. THE Test_Suites SHALL mencakup setiap requirement dengan sedikitnya satu tes otomatis; pengecualian Requirement 36, Requirement 40, dan Requirement 41 kriteria 2 sampai 5 dibuktikan dengan satu butir daftar periksa operator di `docs/infra/12-remotion-animation.md`, dan perilaku yang membutuhkan browser asli atau akun AWS asli dibuktikan dengan satu butir daftar periksa manual.
10. THE Test_Suites SHALL memuat tes nilai batas verifier: `source` 32768 byte lolos dan 32769 byte menghasilkan `SIZE_SOURCE_TOO_LARGE`; `durationInFrames` 30 dan 900 diterima, sedangkan 29 dan 901 menghasilkan `POLICY_META_INVALID`; 600 elemen lolos dan 601 elemen menghasilkan `RENDER_DOM_LIMIT`; dan Forbidden_Token pada frame `pauseAtFrame` menghasilkan `FIDELITY_FORBIDDEN_TOKEN_VISIBLE`, sedangkan pada frame `pauseAtFrame + 1` tidak.
11. THE Test_Suites SHALL memuat tes handler untuk `VERIFIER_BAD_INPUT`, `VERIFIER_CONTRACT_MISMATCH`, `VERIFIER_INTERNAL`, `VERIFIER_DEADLINE` (jam palsu 50000 ms), dan `BUNDLE_FAILED`; fixture `ok` true di `animation-verifier/fixtures/warn/` untuk `RENDER_CONSOLE_WARN` dan `FIDELITY_FORBIDDEN_OVERLAPS_REQUIRED` dengan `severity` `warning`; dan tes Pytest untuk `AGENT_EXTRACT_NO_CODE`.
12. THE Test_Suites SHALL memuat tes properti dengan cara pada kriteria 3 (`fast-check` atau parametrisasi berbenih) untuk Requirement 10 kriteria 7, Requirement 19 kriteria 10, dan Requirement 24 kriteria 12.
13. THE Test_Suites SHALL menegaskan bahwa setiap fixture `good/` memiliki berkas pendamping `visual`, bahwa Pytest menurunkan `required_tokens` dari `visual` itu dan hasilnya sama dengan Required_Tokens pendamping, dan bahwa Vitest di `frontend/tests/` menjalankan bundle setiap fixture `good/` lewat shim `require` Sandbox_Runtime tanpa exception.
14. THE Test_Suites SHALL menjalankan tes Requirement 41 kriteria 1 di subproses Python baru.

### Requirement 39: Pemakaian ulang kode

**User Story:** Sebagai developer, saya ingin fitur ini memperluas kode yang ada dan bukan menggandakannya, agar perilaku tetap konsisten dan perawatan murah.

#### Acceptance Criteria

1. THE Animation_Feature SHALL memperluas `backend/app/ai/gemini_client.py` untuk generasi teks dan SHALL NOT menambah klien HTTP Gemini kedua.
2. THE Animation_Feature SHALL membagi Entry_Guard yang diekstrak dari `backend/app/ai/pipeline.py` antara handler JSON dan handler streaming, dengan perilaku handler JSON tidak berubah.
3. THE Animation_Feature SHALL memakai ulang `AiLimiter`, `AiLimits`, `denied_to_error`, dan parsing env bilangan bulat positif dari `backend/app/ai/limits.py` untuk Animation_Limiter, dan SHALL menambahkan kode galat baru ke pemetaan status `backend/app/ai/envelope.py`.
4. THE Animation_Feature SHALL memakai ulang `parse_lesson_visual` dan model di `backend/app/ai/contracts/visual.py` untuk memvalidasi `visual` pada `CreateAnimationRequest` dan sebagai sumber Required_Tokens, tanpa validator visual kedua, dan SHALL membiarkan `backend/app/ai/chunking.py` tidak berubah (`MAX_CHUNK_CHARS` tetap 180 dan tes paritas `pagination` lulus tanpa diubah).
5. THE Animation_Feature SHALL memakai ulang cookie Owner di `backend/app/owner.py` (nama cookie didefinisikan sekali sebagai `COOKIE_NAME`), dan SHALL mengikuti pola `backend/app/projects.py` untuk `client_ip`, `limit_ip`, badan 404 yang identik, dan dataclass bergaya `Limits` yang memuat batas per-Owner 200 yang dapat diganti tes lewat state aplikasi.
6. THE Animation_Registry SHALL dimigrasikan dengan mengikuti gaya revisi `7c1d9e4a52b8` (SQL mentah lewat `op.execute`, id text, timestamp bigint milidetik, expand-only).
7. THE Animation_Feature SHALL memakai ulang di frontend, tanpa salinan kedua, `StageCanvas`, `CanvasPane`, `useCanvasPlayback`, `PlayerBar`, `visual-compositions.tsx` yang ada sebagai Fallback_Scene, token `lore-tokens.css` di dalam sandbox (Requirement 27 kriteria 5), skema Zod lenient untuk `visual` (Requirement 22 kriteria 3), dan `useIsClient` dari `StageCanvas.tsx` (bila berkas lain memakainya, hook itu diekspor dan `frontend/src` berisi tepat satu definisinya), dan SHALL membaca flag `NEXT_PUBLIC_ANIMATIONS` dengan pola literal yang sama seperti `NEXT_PUBLIC_PROJECT_STORE` (Requirement 36 kriteria 1).
8. THE Animation_Feature SHALL memakai ulang di tes pola Thumbnail-plus-jsdom pada `lesson-visual-board.test.tsx`, `frontend/tests/fixtures/backend-fetch.ts`, dan fixture yang dipakai bersama backend dan frontend, dan SHALL memakai ulang di infra pola tag, `policy_rules.py`, struktur `scripts/ci/ssm-deploy.sh`, `deploy/common/render-env.sh` yang generik, dan S3 gateway endpoint yang sudah ada.
9. THE Test_Suites SHALL memuat tes yang menegaskan bahwa URL endpoint Gemini muncul hanya di satu modul backend (Requirement 4 kriteria 8), bahwa `COOKIE_NAME` didefinisikan hanya di satu modul, dan bahwa frontend tidak memuat implementasi player kedua di luar `Player` Remotion dan adaptor SandboxPlayerRef.
10. THE Animation_Limits SHALL memuat field `owner_max_animations` (default 200) pada dataclass frozen `app.state.animation_limits` sebagai batas animasi per-Owner, terpisah dari `app.state.limits` milik `backend/app/projects.py` yang tidak diubah.
11. WHEN `app.state.animation_limits` diganti dengan `owner_max_animations` 1 dan Owner sudah memiliki 1 baris, THE Animation_Endpoint SHALL menjawab HTTP 422 dengan `ANIMATION_QUOTA_EXCEEDED` untuk request non-idempoten berikutnya, dan `owner_max_projects` SHALL tetap 100.
12. THE Test_Suites SHALL menegaskan bahwa `import httpx2` di `backend/app/**/*.py` hanya ada di `gemini_client.py` dan `runtime.py`, dan bahwa `backend/requirements.txt` tidak memuat `google-genai`, `google-generativeai`, `google-ai-generativelanguage`, atau `langchain-google-genai`.
13. THE Animation_Client SHALL membentuk URL POST lewat `aiUrl("animations")` dengan `AiStep` ditambah `"animations"` sehingga hasilnya `/api/v1/ai/animations`, dan tes `aiUrl` yang ada SHALL lulus tanpa diubah.
14. THE Test_Suites SHALL menegaskan bahwa impor nilai (bukan `import type`) dari `@remotion/player` di bawah `frontend/` hanya ada di `frontend/src/components/stage/StageCanvas.tsx` dan `frontend/sandbox-runtime/`.

### Requirement 40: Dokumentasi, steering, dan roadmap

**User Story:** Sebagai developer dan operator, saya ingin dokumentasi dan steering yang mengikuti kode, agar fitur dapat dioperasikan dan dikembangkan tanpa menebak.

#### Acceptance Criteria

1. THE Docs_Set SHALL menambahkan `docs/infra/12-remotion-animation.md` dalam Bahasa Indonesia dengan bagian: tujuan dan status, arsitektur (diagram mermaid), alur data, kontrak, variabel lingkungan, protokol SSE, tata letak S3, tabel database, infra dan IAM, urutan rilis, runbook (menyalakan, mematikan, rollback, memeriksa verifier, membaca log tanpa data sensitif), langkah manual admin, daftar periksa browser, biaya, keamanan dan sisa risiko, batas dan kuota, serta tabel pemecahan masalah yang memetakan setiap kode galat fitur ini ke penyebab dan tindakannya.
2. THE Docs_Set SHALL memperbarui `docs/infra/00-overview.md` (entri indeks dan konvensi: Component `animation`, nama parameter, env), `docs/infra/02-iam-and-oidc.md` dan `docs/infra/03-compute.md` (hop limit 2 hanya pada `api`, beserta alasannya), `docs/infra/07-cost-guardrails.md`, `docs/infra/08-tagging.md`, `docs/infra/09-runbook.md`, dan `docs/infra/10-implementation-roadmap.md` (tugas baru R14 dengan tujuan, panduan, pengujian, demo, biaya, dan rencana pull request).
3. THE Docs_Set SHALL memperbarui berkas steering `ai-pipeline` (endpoint dan alur baru), `backend` (modul, env, endpoint, health), `infra` (resource baru, langkah manual, aturan guard), `persistence` (referensi `animation` dan tabel `animations`), `game-engine` (Animation_Scene di Stage), `structure` (`animation-verifier/`, `frontend/sandbox-runtime/`, `lib/animation` baru), `tech` (dependensi, env, perintah, urutan CI baru), `product` (kondisi sekarang), dan `known-issues` (sisa risiko dan keterbatasan).
4. THE Docs_Set SHALL memakai placeholder `<ACCOUNT_ID>` dan SHALL NOT memuat id akun, key, atau URL presigned yang sebenarnya.
5. THE Docs_Set SHALL menandai setiap harga atau perilaku AWS yang belum diverifikasi dengan `[belum diverifikasi]`, seperti dokumen infra yang sudah ada.
6. THE Docs_Set SHALL menambahkan ke `frontend/.env.example` baris `NEXT_PUBLIC_ANIMATIONS=off` dengan komentar yang menyatakan nilai `on` atau `off`, default `off`, dan `on` hanya setelah syarat Requirement 36 kriteria 4 terpenuhi.
7. THE Test_Suites SHALL memuat `backend/tests/test_animation_docs.py` yang menegaskan bahwa `docs/infra/12-remotion-animation.md` memiliki judul `##` untuk setiap bagian pada kriteria 1, sedikitnya satu blok `mermaid`, dan kata `Chromium` serta `Firefox`.
8. THE Test_Suites SHALL menegaskan bahwa setiap kode pada Requirement 13 kriteria 11, Requirement 16 kriteria 6, `PROVIDER_NOT_CONFIGURED`, dan `INVALID_REQUEST` ada di baris tabel pemecahan masalah dengan sel penyebab dan sel tindakan yang terisi, dan bahwa setiap env pada Requirement 16 kriteria 1 dan 2, `AI_ANIMATION_MODEL`, dan `NEXT_PUBLIC_ANIMATIONS` ada di dokumen 12 dan di `docs/infra/00-overview.md`.
9. THE Docs_Set SHALL memuat `<ACCOUNT_ID>` di dokumen 12, dan THE Test_Suites SHALL menegaskan bahwa dokumen 12 dan `.kiro/steering/*.md` tidak cocok dengan `\b\d{12}\b`, `X-Amz-Signature`, atau `AKIA[0-9A-Z]{16}`.
10. THE Docs_Set SHALL memastikan tidak ada baris di `docs/infra/02-iam-and-oidc.md`, `docs/infra/03-compute.md`, dan `docs/infra/10-implementation-roadmap.md` yang memuat `hop limit 1` tanpa menyebut `web` atau `nat`, dan `docs/infra/03-compute.md` SHALL memuat `hop_limit = 2` untuk `api` beserta alasan kredensial `boto3`.
11. THE Docs_Set SHALL memperbarui `docs/infra/05-cicd.md` (job `verifier` dan `contracts`, serta `release-verifier.yml`) dan steering `conventions` (`ci/verifier` dan `ci/contracts` ditandai menunggu persetujuan pengguna), dan SHALL menghapus klaim bahwa LangGraph dan SSE belum ada dari steering `product` serta mencatat Flag_Api `false` dan Flag_Web `off`.
12. THE Docs_Set SHALL memuat di dokumen 12 tiga baris RSS menurut Requirement 41 kriteria 2 dengan ambang 600 MiB, dan SHALL menandai nilai yang belum diukur dengan `[belum diverifikasi]`.

### Requirement 41: Pengukuran memori dan estimasi biaya

**User Story:** Sebagai pemilik sistem, saya ingin dampak memori pada instance 1 GiB dan dampak biaya terukur sebelum fitur dinyalakan, agar tidak ada kejutan.

#### Acceptance Criteria

1. WHILE Flag_Api false, THE Animation_Feature SHALL NOT mengimpor `langgraph` atau `boto3` saat startup, sehingga api yang berjalan tidak membayar memori untuk keduanya, dan sebuah tes SHALL menegaskan bahwa tidak satu pun dari nama itu ada di `sys.modules` setelah mengimpor `app.main` dengan flag false.
2. THE Docs_Set SHALL mencatat di bagian batas dan kuota dokumen 12 tiga nilai RSS dalam MiB (jumlah RSS seluruh proses container api, disampel tiap 1 detik, dengan puncak sama dengan nilai maksimum): (a) sebelum rilis api pada langkah (5) Requirement 36 kriteria 3, (b) idle 60 detik sesudahnya dengan Flag_Api false, dan (c) selama satu run `scripts/verify/animation-smoke.py` pada langkah (6), masing-masing dengan perintah pengukuran dan tanggal UTC berformat `YYYY-MM-DD`.
3. IF RSS (c) melebihi 600 MiB, THEN THE Animation_Feature SHALL NOT diluncurkan, artinya Flag_Web SHALL NOT disetel `on` pada langkah (7) Requirement 36 kriteria 3, THE Docs_Set SHALL mencatat pengurangan yang diterapkan, dan RSS (c) SHALL diukur ulang dan tercatat paling besar 600 MiB sebelum Flag_Web `on`; RSS (c) diukur dengan Flag_Api true pada langkah (6), sebelum langkah (7).
4. THE Docs_Set SHALL mencatat di `docs/infra/07-cost-guardrails.md` estimasi biaya bulanan untuk Lambda (GB-detik pada 1536 MB), penyimpanan ECR (5 image), penyimpanan dan request S3, ingestion CloudWatch Logs dengan retensi 7 hari, dan tambahan pemakaian Gemini, masing-masing dengan masukan, rumus, dan label `[belum diverifikasi]` untuk harga yang belum diverifikasi, dan SHALL menyatakan bahwa akun berada di paket Free dengan kredit promo seperti tercatat di dokumen itu.
5. IF estimasi tambahan biaya AWS sebesar US$5 per bulan atau lebih, THEN THE perubahan SHALL NOT di-merge tanpa persetujuan pengguna.
6. THE Animation_Feature SHALL NOT menaikkan ukuran instance, IOPS, atau retensi backup apa pun.
7. THE Test_Suites SHALL mengimpor `app.main` di subproses Python baru dengan `ANIMATION_ENABLED` tidak diset dan key Gemini palsu terkonfigurasi (agar `PROVIDER_NOT_CONFIGURED` tidak mendahului), memanggil `/health/ai`, Animation_Endpoint (dengan request valid), dan Animation_Reader lewat ASGI test client, dan SHALL menegaskan bahwa `langgraph`, `boto3`, dan `botocore` tidak ada di `sys.modules` serta kedua endpoint animasi menjawab HTTP 503 dengan `ANIMATION_NOT_CONFIGURED`.
8. WHEN dua run berjalan serentak (`ANIMATION_MAX_CONCURRENT_GLOBAL` sama dengan 2), THE Docs_Set SHALL mencatat puncak RSS yang diukur dengan metrik kriteria 2.
9. IF puncak RSS dua run serentak melebihi 600 MiB, THEN THE Docs_Set SHALL mencatat penyetelan SSM `ANIMATION_MAX_CONCURRENT_GLOBAL` ke 1 sebelum Flag_Web `on`.
10. THE Docs_Set SHALL memuat di `docs/infra/07-cost-guardrails.md` tepat satu baris `Total tambahan AWS per bulan: US$<angka>` untuk 30 animasi per hari selama 30 hari dengan 4 invokasi Verifier_Lambda per animasi masing-masing 60 detik pada 1536 MB, dan SHALL mencatat biaya Gemini di baris terpisah di luar total itu.
11. THE Test_Suites SHALL memuat tes `unittest` di `scripts/ci/test-checkers.py` yang gagal bila baris pada kriteria 10 hilang atau angkanya 5 atau lebih, kecuali baris `Persetujuan pengguna: <tanggal>` ada tepat di bawahnya.

## Keterlacakan keputusan ke requirement

Pemetaan keputusan pengguna A sampai M dan cakupan (1) sampai (19) berlaku untuk kriteria lama dan kriteria baru pada Requirement 1 sampai 41. Setiap Requirement 1 sampai 41 terpetakan sedikitnya satu kali. Keputusan lintas requirement G1 sampai G13 dipetakan pada baris G1 sampai G13 di akhir tabel dan dirinci di bagian "Keputusan hasil QA" pada Introduction.

| Keputusan atau cakupan pengguna | Requirement |
|---|---|
| A. Berkas hasil `main.ts` | 1, 7 |
| B. Satu kontrak dan sinkronisasi | 2, 3 |
| C. Agent LangGraph, klien Gemini mode teks | 4, 5, 12, 13, 14 |
| D. Verifier Lambda | 3, 6, 7, 8, 9, 10, 11, 34 |
| E. Penyimpanan S3 | 19, 34 |
| F. Backend API (SSE, guard, idempotensi, endpoint baca) | 15, 16, 17, 18, 21 |
| G. Basis data `animations` | 20 |
| H. Referensi di cerita | 22 |
| I. Kapan dibuat (tahap `animating`) | 23, 24, 25 |
| J. Eksekusi di frontend yang aman | 26, 27, 28, 29, 30, 31 |
| K. Flag rilis | 36 |
| L. Infra | 34, 35 |
| M. CI/CD dan dokumentasi | 37, 40 |
| Bagian 3 (keamanan) | 32 |
| Bagian 4 (reuse) | 39 |
| Cakupan (1) kontrak dan sinkronisasi | 1, 2, 3 |
| Cakupan (2) prompt dan pembuatan kode | 4, 5, 12 |
| Cakupan (3) verifier | 6 sampai 11 |
| Cakupan (4) agent | 13, 14 |
| Cakupan (5) endpoint SSE | 15 sampai 18 |
| Cakupan (6) S3 | 19 |
| Cakupan (7) basis data dan baca | 20, 21 |
| Cakupan (8) kontrak cerita | 22 |
| Cakupan (9) alur generasi frontend | 23, 24, 25 |
| Cakupan (10) pemuat bundle | 26 |
| Cakupan (11) sandbox | 27, 28, 29 |
| Cakupan (12) integrasi pemutar | 30 |
| Cakupan (13) fallback | 31 |
| Cakupan (14) keamanan | 32 |
| Cakupan (15) infra dan guardrail | 34, 35 |
| Cakupan (16) CI/CD, rilis, rollback | 36, 37 |
| Cakupan (17) observabilitas dan uji asap | 33 |
| Cakupan (18) pengujian | 38 |
| Cakupan (19) dokumentasi dan steering | 40, 41 |
| G1 (warna dan font) | 1, 2, 8 |
| G2 (pemindaian literal, `skipped_tokens`) | 1, 7, 12, 19 |
| G3 (`require` dan `import x = require()`) | 1, 7 |
| G4 (kode ESLint, regex awalan kode) | 2, 6, 8 |
| G5 (determinisme verifier) | 6, 38 |
| G6 (deadline, event akhir, batas klien) | 13, 16, 17, 24, 25 |
| G7 (batas percobaan) | 13, 16, 34 |
| G8 (routing agent setelah `verify`) | 13, 14 |
| G9 (urutan pemeriksaan endpoint) | 15, 16, 36 |
| G10 (semantik registry dan kuota per owner) | 13, 15, 18, 20, 39 |
| G11 (rilis verifier pertama, `precondition` flag) | 34, 36, 37 |
| G12 (`ready`, `heartbeat`, dan `session`) | 28, 29 |
| G13 (`attempts` pada log dan pada hasil) | 13, 17, 18, 33 |
