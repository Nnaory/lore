---
inclusion: manual
---

# Isu dan kode lama (panggil dengan #known-issues)

Sudah diverifikasi (per 19 Nov 2026):
- `requestCampaign()` dan `/api/ai/full-workflow` tidak dipakai UI (rencana migrasi di `docs/infra/06-app-changes.md` juga tidak memindahkannya). Masih ada karena `runFullWorkflow` dan route-nya dipakai banyak test (`gemini.test.ts`, `tests/fixtures/route-fetch.ts`); skema request-nya (`full-workflow-schema.ts`) tetap dipakai client.
- Ada kode yang hanya dipanggil test, bukan app: `validateStory` (`validation/story-validator.ts`, tipe `ValidationError`-nya dipakai di mana-mana), `isStoryFailed`/`clampHp` (`hp-manager.ts`), `getNextStoryEntry` (`campaign-manager.ts`), dan `dummyMaterial2/3`, `dummyPlannerOptions`, `dummyStoryState` di `src/data/dummy-campaign.ts`.
- Pembersihan 17 Nov 2026 menghapus: `PuzzleInteraction.tsx` (testnya pindah ke `tests/stage/stage-puzzle.test.tsx`), state submit di `create-form.ts`, test debug tanpa `expect`, aset bawaan create-next-app di `public/`, CSS layout lama (`.navbar*`, `.sidebar-*`, `.hide-on-*`, `.mobile-full`, `.lore-hairline`, registrasi `--color-*` di `@theme`), dan export tanpa referensi (alias `*FromSchema`, `SceneType`, `LessonVisualKind`, `StoryGenerationContext`, `parseMaterialAnalysisResponse`, dll.).
- Label tombol berubah menjadi "Confirm choice →" hanya untuk pilihan salah yang punya bad branch. Di puzzle demo semua pilihan salah punya bad branch, jadi label "Submit Answer" membocorkan jawaban benar.

**BELUM DICEK** (berasal dari laporan sub-agent; verifikasi dulu sebelum dipakai sebagai fakta):
- `StoryFailure.tsx` meng-hardcode HP 5, bukan memakai `MAX_HP`.
- `EndingDisplay.tsx` menggabungkan paragraf `\n\n` menjadi satu.
- `--color-success` (#6fcf97) dari DESIGN.md tidak ada di `globals.css`. Warnanya di-hardcode di beberapa komponen.
- Jawaban salah yang sama bisa disubmit ulang dan memotong HP lagi. Label "Submitting…" tidak pernah tampil.
- Komentar header `dummy-campaign.ts` sudah basi. Test id masih memakai prefix lama `sidebar-`.
- GenrePicker hanya menawarkan fantasy, modern ("Non-fiction") dan science_fiction, padahal tipe `Genre` punya 8 nilai.

## Fitur animasi Remotion (R14): sisa risiko dan keterbatasan
Sumber: `.kiro/specs/ai-remotion-animation/` dan `docs/infra/12-remotion-animation.md` (bagian "Keamanan dan sisa risiko", "Langkah manual admin"). Flag_Api `false` dan Flag_Web `off`: tidak ada yang berubah di production sampai operator menyelesaikan daftar di bawah.

**Pemblokir yang butuh operator online atau admin (jangan dipalsukan di sandbox tanpa jaringan):**
- `animation-verifier/package-lock.json` belum ada. Akibatnya `ci/verifier` dan `ci/contracts` merah, `python3 scripts/ci/check-animation-versions.py` keluar 1 pada repo nyata, dan `npm ci` di `animation-verifier/Dockerfile` gagal. Perbaikan: `cd animation-verifier && npm install --save-exact`, commit lockfile (jangan ditulis tangan). `@types/node` 22.20.1 belum dicek ke registry.
- `@fontsource/space-grotesk` dan `@fontsource/jetbrains-mono` belum terpasang di `frontend/`. `predev` dan `prebuild` (`scripts/build-sandbox.mjs`) berhenti dengan kode 1 (disengaja, font sandbox harus ada), sehingga `npm run dev`, `npm run build`, `ci/web`, dan build Docker web gagal. Perbaikan: `cd frontend && npm install --save-dev --save-exact @fontsource/space-grotesk @fontsource/jetbrains-mono esbuild@0.28.2`, lalu commit `package.json` dan `package-lock.json`. Jalur berkas font di dalam paket baru dicek terhadap design, belum terhadap paket nyata.
- `ci/verifier` dan `ci/contracts` belum menjadi required check ruleset `protection-main` (menunggu persetujuan pengguna).
- Bootstrap IAM oleh admin (`infra/bootstrap/bootstrap.sh`) dan dua `aws iam simulate-principal-policy` belum dijalankan. Risiko: `NotResource` log group verifier (ber-`:*` dan tanpa) harus memberi `allowed`; bila `terraform apply` PR kedua gagal izin ECR, periksa pernyataan `AnimationEcr`. Ukuran `lore-gh-apply-policy.json` 5529 dari 6144.
- `release-verifier.yml` terpicu saat merge PR kode pertama yang menyentuh `animation-verifier/**`, dan run itu merah sampai bootstrap, apply PR infra pertama, dan lockfile ada. Jalankan ulang lewat `workflow_dispatch`.
- Estimasi biaya kotor tanpa free tier Lambda sekitar US$5,74 per bulan (di atas US$5): PR infra pertama tidak boleh di-merge tanpa persetujuan pengguna. Rinciannya ada di bagian "Biaya" dokumen 12; baris total resmi dan baris persetujuan ada di `docs/infra/07-cost-guardrails.md` (persetujuan ditulis pengguna, bukan agen).

**`[belum diverifikasi]` (dijalankan nanti, perintahnya ada di dokumen 12):**
- Migrasi `725515cc1581` belum pernah dijalankan di Postgres asli (30 dari 32 tes `test_animation_migration.py` di-skip tanpa `PGHOST`; `ci/api` menjalankannya).
- `langgraph==1.2.24` dan `boto3==1.44.13` belum terpasang di `backend/.venv`. Tes dengan paket asli (`test_real_langgraph_matches_the_driver`, `test_real_botocore_*`) aktif otomatis saat paket ada. Asumsi yang berisiko: parameter `config` tanpa anotasi disuntik LangGraph, `None` di dict hasil node, nama parameter `boto3` (`ChecksumSHA256`, `IfNoneMatch`, `ExpiresIn`), arti `retries.max_attempts=2`.
- Image verifier belum dibangun atau dijalankan di bawah Lambda RIE (`scripts/ci/verifier-rie-check.sh` diuji dengan `docker` dan `aws` tiruan). Fixture pertama pada cold start (sekitar 2356 ms) bisa melewati watchdog 2000 ms dan memberi `RENDER_FRAME_TIMEOUT` pada `good/diagram-lesson.ts`; `bad/render-resource-limit.ts` punya toleransi sempit antara `RENDER_FRAME_TIMEOUT` dan `RENDER_RESOURCE_LIMIT`.
- Kasus batas memori 1,4 GB di verifier belum dijalankan (butuh memori bebas minimal 3 GiB); yang berjalan adalah kasus pengganti yang diskalakan.
- `terraform init -backend=false`, `terraform plan` nyata, dan `shellcheck` belum dijalankan. Fixture plan di `scripts/ci/fixtures/` dibuat dari bentuk yang dibaca skrip; ekspektasi tiga PR infra (24 resource baru, lalu +1 Lambda, lalu satu update SSM) dihitung dari kode. `ci/terraform` yang membuktikan.
- Perilaku AWS: penulisan bersyarat S3 `If-None-Match: *` di `ap-southeast-3`, 404 (bukan 403) pada objek tidak ada untuk role `api`, kredensial `boto3` dari dalam container dengan hop limit 2, status paket Free dan harga Lambda, ECR, serta CloudWatch di Jakarta.
- Browser nyata (Chromium dan Firefox): `window.origin === "null"`, `event.source === window.parent`, CSP `script-src 'self'` pada dokumen bersandbox, `SecurityError` untuk `document.cookie`, `localStorage`, `window.parent.document`, isolasi proses iframe, tata letak Player, dan `<Activity>` + iframe. Screenshot 1440×900 dan 390×844 menunggu paket `@fontsource/*`.
- Prompt `generate` dan `repair` belum dicoba pada Gemini asli (bukti pertama: run animasi pertama atau `scripts/verify/ai-smoke.py`).
- Tiga baris RSS container api (sebelum rilis, idle, selama smoke) dan puncak dua run serentak belum diukur; ambang 600 MiB. `docker top "$CID" -eo rss` dan `put-object --if-none-match '*'` belum dicoba.
- Satu tes lama gagal di mesin tanpa DNS: `tests/test_ai_gemini_client.py::test_key_that_is_not_a_valid_header_is_fatal_and_not_echoed` (gagal karena DNS, bukan karena kode animasi). Satu kegagalan sekali di run penuh pertama `pytest` tidak tercatat namanya dan tidak muncul lagi dalam 10 run (kemungkinan tes lama yang peka waktu).

**Keterbatasan desain yang diterima:**
- Loop sinkron tak berujung pada frame yang tidak disampel (T-13): verifier hanya menyampel frame, dan di browser yang tidak mengisolasi iframe bersandbox ke proses terpisah tab bisa membeku. Watchdog heartbeat 3 detik hanya efektif bila iframe terisolasi.
- `unsafe-eval` dipakai di dalam sandbox (bundle dievaluasi dengan `new Function`), dibatasi origin buram dan CSP. `vm` di verifier bukan batas keamanan; batas sebenarnya microVM Lambda tanpa egress dan tanpa secret. Pemindaian kebijakan statis adalah pertahanan berlapis, bukan batas keamanan.
- Kuota 200 animasi per Owner seumur cookie `lore_device`; cookie hilang berarti semua referensi 404 dan memakai Fallback_Scene. Tidak ada penghapusan animasi.
- Pemeriksaan koordinat numerik lemah, dan aturan Forbidden_Token hanya melihat frame sampel (jawaban yang tampil singkat di antara dua sampel tidak terdeteksi). jsdom tidak mengukur tata letak piksel, jadi konten tumpang tindih atau keluar kanvas tidak terdeteksi. Verifier memakai React build development sementara sandbox memakai production.
- Normalisasi token NFKC Python dan Node bisa berbeda untuk karakter baru; `normalizeToken` tidak idempoten untuk kasus tanda gabung setelah spasi. Dimitigasi fixture bersama, `ci/api` adalah pembuktian akhir.
- Bila `ANIMATION_NOT_CONFIGURED` atau kuota penuh datang di tengah tahap `animating`, sisa target menjadi `skipped` dan `onDone` ditahan sampai pemain menekan Skip atau Try again. Ini mengikuti Requirement 24.13 dan menggantikan Requirement 36.6.
- Bila halaman disembunyikan lalu tampil lagi lewat `<Activity>`, iframe dibuat ulang; scene yang belum `failed` di-remount, tetapi perilakunya di browser nyata belum terbukti.
- Log: baris `animation.verifier` dari thread yang tertinggal setelah batal atau timeout bisa tertulis sesudah `animation.end` (Requirement 33.11 harfiah: `end` baris terakhir; perbaikan ketat ada di `verifier_client.py`). Setelah `emit` menggeser jam, agent tidak mengecek ulang waktu sebelum Gemini atau verifier (`calls` tetap naik). Setelah `AGENT_REPAIR_UNCHANGED`, prompt `repair` berikutnya hanya membawa temuan agent. Registry yang sedang menulis saat timeout tetap selesai (percobaan ulang menjadi cache hit), dan `manifest.json` yang `put`-nya sudah mulai tetap ada di S3 serta diadopsi run berikutnya.
- `animation.verifier` memuat label `reason` dari himpunan tertutup (hapus kunci `reason` di `_log` bila ingin harfiah Requirement 14.8).
- Rate limiter dan limiter animasi ada di memori proses api: mulai ulang proses mengosongkan hitungan. Batas serentak ditegakkan di api, bukan lewat `reserved_concurrent_executions` Lambda (kuota akun baru bisa terlalu kecil).
- Kasus `bad/render-resource-limit.ts` memakai RSS sekitar 600 MB dan 1,0 sampai 1,4 detik; di CI lambat bisa menjadi `RENDER_FRAME_TIMEOUT` (toleransi sempit di korpus).

**Temuan di luar spec fitur ini (belum diperbaiki, butuh persetujuan pengguna dan PR terpisah):**
- Job `deploy` di `.github/workflows/release-web.yml` menulis `"${{ needs.build.outputs.tag || inputs.tag }}"` langsung di baris `run:` (injeksi ekspresi lewat `inputs.tag`; validasi regex di `ssm-deploy.sh` baru jalan setelah shell mem-parse baris itu). Perbaikan: pindahkan ke `env: IMAGE_TAG`. Periksa juga `release-api.yml`.
- `check-cost` punya baris 53 yang lebih dari 100 kolom (sudah ada sebelum R14).
