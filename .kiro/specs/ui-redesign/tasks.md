# Implementation Plan: ui-redesign

## Overview

Rencana ini mengganti seluruh tampilan web LORE dengan Kit "Black Cat Gold", satu layar per task, dengan urutan tetap sesuai Requirement 5.1: task 0 (pasang Kit), Stage desktop, Stage phone, Preparation desktop, Preparation phone, Home, 11 Layar_Tanpa_Frame (satu task per layar), mode dua karakter, lalu task penutup.

Bahasa implementasi: TypeScript (Next 16, React 19, Vitest 3), mengikuti design.md. Tidak ada perubahan di `backend/`, `lib/contracts`, `lib/game`, `lib/story`, `lib/campaign`, `lib/generation`, `lib/ingest`, `lib/setup`, `lib/state`, dan `project-store.ts` (Requirement 13).

### Aturan yang berlaku di setiap task

- **Verifikasi_Task** (sub-task "Verifikasi", dari `frontend/`): `npm run lint` (0 error, 0 warning), `npx next typegen` lalu `npx tsc --noEmit`, `npx vitest run --testTimeout=60000` (0 gagal), dan `npm run build` tanpa `GOOGLE_API_KEY` dan `GEMINI_API_KEY`. Golden_Test (`tests/ascii-golden.test.ts`) harus tetap 40 dari 40 hijau (Requirement 5.3, 5.5, 14.5). Bila satu perintah gagal, task berstatus belum selesai dan hasilnya dicatat di Ringkasan_Penyimpangan (Requirement 5.4).
- **Ringkasan_Penyimpangan** (sub-task terakhir): bandingkan hasil dengan Canvas_Frame_File pada Viewport_Desktop 1440x900 dan Viewport_Phone 390x844, lampirkan satu screenshot per viewport bila tersedia, atau catat alasan dan bandingkan secara tertulis per bagian Design_System. Bila nilai Design_System dan canvas berbeda, pakai Design_System dan catat keduanya (Requirement 5.6 sampai 5.10). Tanpa penyimpangan, isinya persis "tidak ada".
- **Batas git dan file**: tidak ada task commit atau push. Tidak ada commit atau push tanpa permintaan eksplisit user. `git diff --name-only dev -- backend/` harus kosong. `frontend/package.json` dan `frontend/package-lock.json` tetap byte-identik kecuali langkah `fast-check` yang disetujui di task 0 (Requirement 1.3 sampai 1.7).
- **Gerbang persetujuan**: sub-task "Gerbang" adalah titik berhenti. Agen menampilkan isinya, menunggu jawaban eksplisit user, dan tidak mengubah file implementasi terkait sebelum jawaban diterima. Layar yang belum disetujui dilewati dan dilaporkan sebagai belum selesai, sedangkan layar lain yang sudah disetujui tetap dikerjakan (Requirement 12.5).
- **Komponen Kit**: diperluas lewat props opsional, tidak di-fork. Komponen atau perluasan baru didokumentasikan di `docs/DESIGN-SYSTEM.md` pada task yang sama dan dicatat di Ringkasan_Penyimpangan (Requirement 5.11).
- **Tes**: tes yang sudah ada diperbarui di sub-task implementasi (tidak opsional) tanpa mengurangi jumlah asersi perilaku dan tanpa mengubah asersi `data-testid` pada Layar_Tanpa_Frame (Requirement 12.12, 14.1, 14.2). Tes baru (properti, contoh, komponen) berbentuk sub-task opsional bertanda `*`.
- Tiap file baru diawali komentar header berisi tujuan dan alasan (Requirement 13.9). Komponen yang memakai API browser memakai `'use client'` di baris pertama (Requirement 15.5).

## Tasks

- [x] 0. Task 0: pasang Kit
  - Rujukan: `docs/DESIGN-SYSTEM.md` (seluruh bagian), 33 file Kit dari `lore-design-kit/lore-design-kit/` termasuk `reference/canvas/*.dc.html` (Cast, HomeA, HomeAMobile, HomeB, HomeBMobile, HomeC, HomeCMobile, Main, Prep, PrepMobile, StageMobile). Task ini tidak mengubah layar apa pun.
  - [x] 0.1 Gerbang: tampilkan daftar file dan keputusan, lalu tunggu persetujuan user
    - Tampilkan tabel 33 file beserta tujuannya dan hasil pemeriksaan bentrokan dari design.md bagian "Task 0: pasang Kit" (0 file ditimpa; `README.md` Kit dan `backend/app/schemas/visual.py` tidak disalin). Jalankan ulang `Test-Path` pada setiap tujuan untuk memastikan hasilnya masih 0 bentrokan. File yang ternyata ditimpa ditandai "menimpa" dan butuh persetujuan terpisah.
    - Tampilkan juga `git status`: perubahan di luar redesign (saat ini `frontend/package.json` dan `frontend/package-lock.json`) beserta path-nya.
    - Minta keputusan user atas: (a) menyalin 33 file; (b) melanjutkan dengan perubahan di luar redesign dibiarkan byte-identik; (c) OQ-2 Zod 3 atau 4 (design: Kit cocok dengan keduanya, working tree tidak disentuh); (d) OQ-8 apakah `npm i -D fast-check` disetujui.
    - BERHENTI di sini. Tidak ada file yang disalin, diubah, atau dihapus sebelum persetujuan eksplisit.
    - _Requirements: 1.4, 2.1, 2.2, 2.10_
  - [x] 0.2 Buat branch kerja
    - Pastikan branch `dev` lokal ada dan `feat/redesign-black-cat-gold` belum ada. Bila tidak, berhenti dan sebut penyebabnya tanpa membuat atau mengubah branch.
    - Buat `feat/redesign-black-cat-gold` dari HEAD `dev` dan pindah ke sana. Tanpa commit dan tanpa push.
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 0.3 Salin file Kit
    - Salin `frontend/src/*` dan `frontend/tests/*` Kit ke `frontend/`, `docs/DESIGN-SYSTEM.md` ke `docs/`, `reference/` dan `scripts/export-ascii-golden.cjs` ke akar repo, dan `AGENTS.md` ke akar repo. Isi `reference/canvas` tidak diubah.
    - Laporkan jumlah file disalin (33) dan ditimpa (0).
    - _Requirements: 1.5, 1.7, 2.3, 11.3_
  - [x] 0.4 Terapkan perubahan pada file yang sudah ada
    - `docs/DESIGN.md`: tambah tepat satu baris "Visual identity: see DESIGN-SYSTEM.md".
    - `frontend/src/app/globals.css`: tambah `@import "./lore-tokens.css";` tepat setelah `@import "tailwindcss";` bila belum ada. Gaya lama tidak disentuh.
    - `frontend/src/app/layout.tsx`: ganti `Geist` dan `Geist_Mono` dengan `spaceGrotesk` dan `jetbrainsMono` dari `./fonts` pada `<html className>`, hapus semua rujukan Geist. `GlassFilter`, `PumpkinBackdrop`, dan skrip `LIQUID_GLASS_CHECK` tetap sampai task 18.
    - Pastikan alias `@/*` ke `./src/*` di `frontend/tsconfig.json` ada.
    - _Requirements: 2.4, 2.5, 2.6, 2.7, 15.9, 15.10_
  - [x] 0.5 Pasang `fast-check` (hanya bila user menyetujui di 0.1)
    - Jalankan `npm i -D fast-check` dari `frontend/` sebagai langkah terpisah dari perubahan Zod yang sudah ada di working tree, lalu laporkan diff `package.json` dan lockfile yang timbul.
    - Bila ditolak: lewati langkah ini. Sub-task properti `*` di task berikutnya memakai tes Vitest tabel lengkap untuk ruang masukan terbatas dan loop berbenih tetap untuk sisanya, dan keterbatasannya dicatat di Ringkasan_Penyimpangan.
    - _Requirements: 1.4, 1.5_
  - [x] 0.6 Periksa fondasi sebelum layar apa pun
    - Dari `frontend/`: `npx vitest run tests/ascii-golden.test.ts` harus 40 dari 40 (0 gagal, 0 dilewati), `npm run lint`, dan `npx tsc --noEmit` exit 0 dengan impor `@/lib/ascii` teresolusi.
    - Bila ada yang gagal, berhenti, laporkan nama tes atau pesan error, pertahankan file yang sudah disalin, dan jangan memulai task layar apa pun. Bila `lib/schemas/visual.ts` ternyata butuh Zod 4 dan repo Zod 3, laporkan dan tunggu keputusan OQ-2 tanpa mengubah `package.json`.
    - _Requirements: 2.7, 2.8, 2.9, 2.10, 15.6, 15.7_
  - [x] 0.7 Tulis property test untuk generator ASCII
    - **Property 18: Generator ASCII identik dengan canvas dan murni**
    - File: `frontend/tests/ascii/ascii-properties.test.ts` (jsdom tidak perlu). Minimum 100 iterasi, komentar `Feature: ui-redesign, Property 18: ...`.
    - **Validates: Requirements 2.8, 5.5, 6.2, 14.5**
  - [x] 0.8 Tulis tes pagar batas SceneBlueprint
    - `frontend/tests/contracts/scene-blueprint-boundary.test.ts`: tidak ada file di `src/lib/generation` yang mengimpor `lib/schemas/visual`. Catat penggunaan `SceneBlueprint` sebagai pekerjaan lanjutan.
    - _Requirements: 13.7_
  - [x] 0.9 Verifikasi
    - Jalankan Verifikasi_Task penuh dan laporkan hasil per perintah (lulus atau gagal), termasuk Golden_Test 40 dari 40. Periksa `git diff --name-only dev -- backend/` kosong.
    - _Requirements: 2.11, 5.3, 5.4, 14.7, 14.8, 14.9_
  - [x] 0.10 Ringkasan_Penyimpangan task 0
    - Catat jumlah file disalin dan ditimpa, keputusan OQ-2 dan OQ-8, status keadaan transisi (layar lama tampil campuran sampai task 18), dan folder `lore-design-kit/` yang belum dihapus. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.8_

- [x] 1. Task 1: Stage desktop
  - Rujukan: DESIGN-SYSTEM §4.1, §4.3, §4.4, §5, §6; Canvas_Frame_File `Main.dc.html` dan `Cast.dc.html`. Koordinat dan fallback ada di design.md bagian Stage, `STAGE_BOXES`, dan pemetaan karakter.
  - [x] 1.1 Gerbang: OQ-9 dan OQ-12
    - Tampilkan dua keputusan dan tunggu jawaban user: OQ-9 (komposisi Remotion memakai token untuk warna, gradient, dan shadow dengan geometri dan isi `LessonVisual` tetap sama) dan OQ-12 (beat tanpa canvas = scene `ambient`, `CanvasFrame` hanya untuk `lesson`, `visual`, `decision`, sehingga satu asersi di `story-viewer.test.tsx` baris 101 diperbarui).
    - BERHENTI sampai user menjawab. Jawaban menentukan sub-task 1.26 dan 1.27.
    - _Requirements: 3.1, 3.3, 7.4, 12.7_
  - [x] 1.2 Buat komponen bersama `components/ui`: `Icon`, `ErrorLine`, `Button`
    - `Icon`: SVG inline 24x24, stroke `currentColor`, `strokeWidth` 2, `strokeLinecap="square"`; nama `back`, `exit`, `file-up`, `paperclip`, `arrow-up`, `file`, `close`, `check`, `play`, `alert`. `ErrorLine`: chip `ERROR` (`ember`/`ink`) dengan teks `cream`, `role="alert"`. `Button`: varian `primary`, `outline`, `disabled`, mendukung `href`. Area sentuh minimal 44 px.
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 5.11_
  - [x] 1.3 Tulis tes komponen `ui`
    - `frontend/tests/ui/*.test.tsx` dengan `@vitest-environment jsdom`: `Icon` (stroke 2, `square`), `ErrorLine` (`role="alert"`), `Button` (varian, `href`, disabled).
    - _Requirements: 3.4, 14.3_
  - [x] 1.4 Perluas komponen Kit lewat props opsional
    - `AsciiArt.pixelRatio`; `DialogueBox`: `askDisabled`, `onAdvance`, `testIds`, `nameTag`; `ChoiceButton`: `letter`, `line-clamp-2`, `title`, `testId`, `ariaPressed`, `disabled`; `CanvasFrame`: `footerless`, `bodyClassName`. Perilaku bawaan Kit tidak berubah dan Golden_Test tetap 40 dari 40.
    - _Requirements: 5.11, 7.8, 7.10, 7.14, 15.2, 15.3_
  - [x] 1.5 Implementasikan logika murni `lib/stage`
    - `board-scale.ts` (`DESKTOP_MIN_WIDTH = 768`, `BOARD_SIZE`, `selectLayout`, `computeBoardScale`, `designRectToViewport`, `viewportRectToDesign`), `stage-boxes.ts` (`STAGE_BOXES` desktop dan phone, `visibleSprites`), `hud.ts` (`hpSquares`), `shortcuts.ts` (`resolveShortcut`), `playback.ts` (`progressPercent`, `formatClock`, `canvasLabel`). Semua mengembalikan union `ok`, tanpa throw, dan tanpa aturan HP.
    - _Requirements: 7.1, 7.2, 7.6, 7.12, 7.13, 8.1, 8.5, 13.2, 13.3_
  - [x] 1.6 Tulis property test untuk skala papan
    - **Property 1: Skala papan memuat penuh dan menyentuh satu batas**
    - File: `frontend/tests/stage/board-scale.test.ts`.
    - **Validates: Requirements 7.1, 8.1**
  - [x] 1.7 Tulis property test untuk posisi relatif elemen
    - **Property 2: Posisi relatif elemen invarian terhadap viewport**
    - File: `frontend/tests/stage/board-scale.test.ts` (dijalankan setelah 1.6 agar tidak bentrok).
    - **Validates: Requirements 7.1**
  - [x] 1.8 Tulis property test untuk titik pisah layout
    - **Property 3: Satu titik pisah phone dan desktop**
    - File: `frontend/tests/stage/board-scale.test.ts` (setelah 1.7), plus contoh batas 767 dan 768.
    - **Validates: Requirements 8.5**
  - [x] 1.9 Tulis property test untuk kotak HP
    - **Property 10: Kotak HP mengikuti HP yang dijepit**
    - File: `frontend/tests/stage/hud.test.ts`, plus contoh `4/5`.
    - **Validates: Requirements 7.6**
  - [x] 1.10 Tulis property test untuk pemetaan pintasan
    - **Property 14: Pintasan memetakan tombol ke aksi yang benar**
    - File: `frontend/tests/stage/shortcuts.test.ts`.
    - **Validates: Requirements 7.12**
  - [x] 1.11 Tulis property test untuk pintasan yang diabaikan
    - **Property 15: Pintasan ditekan pada elemen editable, pengubah, atau modal diabaikan**
    - File: `frontend/tests/stage/shortcuts.test.ts` (setelah 1.10).
    - **Validates: Requirements 7.13**
  - [x] 1.12 Tulis tes contoh untuk `stage-boxes` dan `playback`
    - `tests/stage/stage-boxes.test.ts`: semua angka §4.1 dan §4.2 sama persis. `tests/stage/playback.test.ts`: `progressPercent`, `formatClock`, `canvasLabel` (bentuk `^[a-z0-9_]{1,24}$`).
    - _Requirements: 7.2, 8.2_
  - [x] 1.13 Implementasikan `lib/cast/cast-mapping.ts`
    - `mapCharacter`, `mapExpression`, `emotionToExpression`, `resolveCampaignCast` (alokasi cast deterministik dari `stableHash(character_id) mod 5`), dan aturan nama tag `NARRATION`. `pickOtherCharacter` dibuat di task 17.
    - _Requirements: 6.4, 6.5, 6.6, 6.7, 13.3_
  - [x] 1.14 Tulis property test untuk id dan nama cast
    - **Property 6: Id dan nama cast selalu dipetakan ke dirinya**
    - File: `frontend/tests/cast/cast-mapping.test.ts`.
    - **Validates: Requirements 6.4, 6.5**
  - [x] 1.15 Tulis property test untuk determinisme pemetaan
    - **Property 7: Pemetaan karakter dan ekspresi deterministik, total, dan tanpa throw**
    - File: `frontend/tests/cast/cast-mapping.test.ts` (setelah 1.14).
    - **Validates: Requirements 6.6, 6.7, 13.3**
  - [x] 1.16 Tulis property test untuk pemetaan ekspresi
    - **Property 8: Pemetaan ekspresi setia pada lima ekspresi Kit dan konsisten dengan `emotionFor`**
    - File: `frontend/tests/cast/cast-mapping.test.ts` (setelah 1.15).
    - **Validates: Requirements 6.4, 6.5**
  - [x] 1.17 Tulis property test untuk alokasi cast kampanye
    - **Property 9: Alokasi cast kampanye deterministik dan tidak bertabrakan sampai lima karakter**
    - File: `frontend/tests/cast/cast-mapping.test.ts` (setelah 1.16).
    - **Validates: Requirements 6.7, 12.6**
  - [x] 1.18 Tulis tes contoh kegagalan pemetaan
    - Satu kasus `ok: true` dan satu kasus `ok: false` per alasan: `unknown_character`, `empty_character`, `unknown_expression`, `empty_expression`.
    - File: `frontend/tests/cast/cast-mapping.test.ts` (setelah 1.17).
    - _Requirements: 6.5, 14.4_
  - [x] 1.19 Implementasikan `lib/dialogue/typewriter.ts`
    - `CHAR_INTERVAL_MS = 25`, `revealedCount`, `revealPrefix` (aman terhadap surrogate pair), `initialTextMode` (pilihan eksplisit menang, selain itu `fast` bila `prefers-reduced-motion`).
    - _Requirements: 3.7, 7.7, 7.8, 7.9, 7.15_
  - [x] 1.20 Tulis property test untuk jumlah karakter yang tampil
    - **Property 11: Jumlah karakter yang tampil mengikuti waktu dan mode**
    - File: `frontend/tests/dialogue/typewriter.test.ts`.
    - **Validates: Requirements 7.7, 7.9**
  - [x] 1.21 Tulis property test untuk prefiks teks
    - **Property 12: Prefiks teks aman dan lengkap**
    - File: `frontend/tests/dialogue/typewriter.test.ts` (setelah 1.20).
    - **Validates: Requirements 7.8**
  - [x] 1.22 Tulis property test untuk mode teks awal
    - **Property 13: Mode teks awal menghormati pilihan eksplisit dan gerak berkurang**
    - File: `frontend/tests/dialogue/typewriter.test.ts` (setelah 1.21).
    - **Validates: Requirements 3.7, 7.15**
  - [x] 1.23 Buat hook tipis
    - `use-board-metrics.ts` (`useSyncExternalStore`, `matchMedia('(min-width: 768px)')`, snapshot server 1440x900), `use-typewriter.ts`, `use-stage-shortcuts.ts`, `use-canvas-playback.ts`. Hook hanya memanggil fungsi murni dan mengelola state React.
    - _Requirements: 7.7, 7.12, 8.6, 13.2_
  - [x] 1.24 Bangun `ScaledBoard`, `StageBackdrop`, dan `StageHud`
    - `ScaledBoard` (wadah `fixed inset-0`, papan 1440x900 dengan `transform: scale(s)`, origin top-center, `BoardScaleContext`, mempertahankan skala valid terakhir). `StageBackdrop` (`lore-grid-bg` + `PumpkinField` dengan `PUMPKINS_STAGE_DESKTOP`). `StageHud` menggantikan `StageNavbar` dengan `data-testid` `sidebar-exit-button`, `sidebar-story-title`, `chapter-progress`, `story-header`, `hp-display`, `hp-value` (`n/5`), kotak dari `hpSquares`.
    - _Requirements: 3.8, 7.1, 7.2, 7.6, 7.14_
  - [x] 1.25 Bangun `StageSprite` dan `StageDialogue`, pindahkan `ChatEntry`
    - `StageSprite` menggambar lewat `renderCharacter` dengan `role="img"` dan label `{nama}, {ekspresi}`; pertahankan `stage-character`, `data-character-id`, `data-emotion`, tambah `data-cast-id` dan `data-expression`; z-index di depan kotak dialog. `StageDialogue` membungkus `DialogueBox` (typewriter 25 ms, klik atau SPACE menampilkan baris penuh, input `type something` disabled dengan "coming soon", name tag `NARRATION` dan `LESSON`, testid `story-main`, `scene-content`, `character-name`, `pacing-toggle`, `log-chat-button`). Pindahkan tipe `ChatEntry` ke `components/stage/chat-entry.ts`.
    - _Requirements: 6.8, 7.3, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.14_
  - [x] 1.26 Isi `CanvasFrame`: pemutar Remotion, `LessonVisual`, mode puzzle, `PlayerBar`
    - Pemutar `StageCanvas` (`controls={false}`) dan `LessonVisual` di dalam `CanvasFrame` 736x414 dengan `PlayerBar` 40 px tanpa meluap. Mode puzzle: `ChoiceButton` 44 px (lebar min 112, jarak 10), `puzzle-submit` dan `puzzle-continue`, umpan balik lewat `ErrorLine`, semua `data-testid` dan `aria-pressed` lama dipertahankan. Benar-salah dan HP hanya dari `usePuzzleInteraction` dan `validateMultipleChoice`.
    - Sesuai jawaban OQ-9: ganti warna, gradient, dan shadow komposisi Remotion ke token tanpa mengubah geometri, data, label, dan angka `LessonVisual`.
    - _Requirements: 3.1, 3.3, 7.4, 7.5, 7.6, 13.2_
  - [x] 1.27 Sambungkan di `StoryViewer`, perbarui tes yang ada, hapus komponen lama
    - Susun pohon Stage dengan state di-hoist di atas pemilih layout (puzzle, typewriter, log, overlay, pacing). Sesuai jawaban OQ-12: `CanvasFrame` hanya untuk `lesson`, `visual`, `decision`; perbarui satu asersi `story-viewer.test.tsx` baris 98 sampai 102. Perbarui tes: `character-expression` menjadi `aria-label` dan `data-expression` (baris 166 sampai 175), `4 / 5` menjadi `toMatch(/4\s*\/\s*5/)` di `bad-branch.test.tsx` dan `hp-failure-retry.test.tsx`. Jumlah asersi tidak berkurang.
    - Setelah tes pindah, hapus `StageNavbar.tsx`, `StageCharacter.tsx`, `ChatBox.tsx`. Ganti impor `lucide-react` pada file Stage dengan `Icon`. Pemilih layout, modal, dan overlay yang sudah ada tetap bergaya lama sampai task 7 dan task 15.
    - _Requirements: 7.6, 7.14, 13.1, 14.1, 14.2_
  - [x] 1.28 Tulis tes `ScaledBoard` dan Stage
    - `frontend/tests/stage/scaled-board.test.tsx` (`@vitest-environment jsdom`): transform `scale(s)` dengan origin `top center`; pintasan SPACE, F, L; fokus di input mengabaikan pintasan; HUD memperbarui `n/5` setelah jawaban.
    - _Requirements: 7.1, 7.6, 7.12, 7.13, 14.3_
  - [x] 1.29 Perbarui `docs/DESIGN-SYSTEM.md`
    - Tambah §6.1 (aturan fallback cast), dokumentasikan perluasan Kit (`AsciiArt.pixelRatio`, `DialogueBox`, `ChoiceButton`, `CanvasFrame`) dan komponen `components/ui`.
    - _Requirements: 5.11, 6.7_
  - [x] 1.30 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 1.31 Ringkasan_Penyimpangan task 1
    - Bandingkan dengan `Main.dc.html` pada 1440x900. Catat: label `NARRATION` dan `LESSON`, "coming soon" pada input, `/ ask` dihapus dari petunjuk tombol, `4 / 5` menjadi `4/5`, tes yang diperbarui beserta pengganti, komponen baru, dan keputusan OQ-9 dan OQ-12.
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.10, 14.2_

- [x] 2. Task 2: Stage phone
  - Rujukan: DESIGN-SYSTEM §4.2, §4.3, §4.4; Canvas_Frame_File `StageMobile.dc.html`.
  - [x] 2.1 Gerbang: OQ-7 (maksimal pilihan jawaban di phone)
    - Tampilkan masalahnya: Requirement 8.4 dan 8.8 membatasi maksimum 3 pilihan, sedangkan `StagePuzzle` menerima sampai 4 dan membuang pilihan keempat bisa membuat puzzle tak terselesaikan. Usulan design: phone menampilkan semua pilihan (sampai 4) sebagai tombol `flex 1`, dan Requirement 8.4 dan 8.8 diamandemen menjadi "maksimal 4".
    - Minta user menyetujui usulan atau memilih alternatif. BERHENTI sampai user menjawab. Perubahan teks `requirements.md` hanya dilakukan bila user memintanya.
    - _Requirements: 8.4, 8.8_
  - [x] 2.2 Tambah `PUMPKINS_STAGE_PHONE` ke `PumpkinField`
    - Salin nilai dari `StageMobile.dc.html`. Perilaku desktop Kit tidak berubah.
    - _Requirements: 5.10, 5.11, 8.2_
  - [x] 2.3 Bangun layout phone pada pohon Stage yang sama
    - Papan 390x844: HUD 390x56 (tombol kembali 44 px, kotak HP 7 px, `Ch n/m`), scene 8 px di (0,56), `CanvasFrame` 366x246 di (12,68) dengan `PlayerBar` 38 px dan tick sudut 10 px, sprite 211x384 di (6,318) di belakang kotak (z 5 lawan z 10), `DialogueBox` 366x250 di (12,582) dengan pilihan di dalam kotak (1 sampai 4 tombol `flex 1`, tinggi 44, tanpa tombol kosong) dan bar bawah 46 px (input disabled, `fast | animate`, `log`). Tepat satu sprite. Pergantian layout lewat `matchMedia` tanpa me-remount state (HP, posisi story, jawaban) dan dalam 300 ms.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_
  - [x] 2.4 Tulis property test untuk satu sprite di phone
    - **Property 4: Phone menggambar tepat satu sprite**
    - File: `frontend/tests/stage/stage-boxes.test.ts`.
    - **Validates: Requirements 8.7, 12.8**
  - [x] 2.5 Tulis tes pergantian layout tanpa kehilangan state
    - `frontend/tests/stage/scaled-board.test.tsx` (jsdom, setelah task 1): ganti `matchMedia` dari desktop ke phone saat Stage tampil, HP, posisi story, dan jawaban puzzle tetap; hanya satu `stage-character` di phone.
    - _Requirements: 8.6, 8.7, 14.3_
  - [x] 2.6 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 2.7 Ringkasan_Penyimpangan task 2
    - Bandingkan dengan `StageMobile.dc.html` pada 390x844. Catat jumlah pilihan maksimum (OQ-7), keterbatasan tablet potret dan ponsel lanskap, dan konstanta baru `PUMPKINS_STAGE_PHONE`.
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.10_

- [x] 3. Task 3: Preparation desktop
  - Rujukan: DESIGN-SYSTEM §4.5, §2, §3; Canvas_Frame_File `Prep.dc.html`. Halaman `app/create/page.tsx` dan `components/setup/*`.
  - [x] 3.1 Gerbang: OQ-6 (kotak CHAPTERS)
    - Tampilkan masalahnya: canvas punya lima kotak (bawaan 3), `lib/setup` hanya mengenal `short` (3 bab) dan `medium` (5 bab), dan `lib/setup` tidak boleh berubah. Usulan design: lima kotak digambar persis, kotak 3 dan 5 aktif, kotak 1, 2, dan 4 nonaktif (`aria-disabled`), dicatat sebagai penyimpangan. Alternatif: perluas `StoryLength` (butuh requirement baru dan dukungan backend).
    - BERHENTI sampai user menjawab. Catat juga bahwa pemilih panjang di `AdvancedOptions` baru dihapus di task 8 setelah persetujuan; sampai itu kedua kontrol menulis state `length_set` yang sama.
    - _Requirements: 9.6, 13.1_
  - [x] 3.2 Implementasikan `lib/prep/chapter-choices.ts`
    - `chapterSquares(length)` (5 kotak, tepat satu `selected` dan `enabled`) dan `lengthForChapters(n)` (3 menjadi `short`, 5 menjadi `medium`, lainnya `null`). Tanpa throw.
    - _Requirements: 9.6, 13.2, 13.3_
  - [x] 3.3 Tulis property test untuk kotak CHAPTERS
    - **Property 16: Kotak CHAPTERS tepat satu terpilih dan bolak-balik dengan panjang cerita**
    - File: `frontend/tests/setup/chapter-choices.test.ts`.
    - **Validates: Requirements 9.6**
  - [x] 3.4 Tambah `SectionLabel` dan kolom datar Prep
    - `SectionLabel` di `components/ui` (nomor `gold`, judul `cream`, garis 1 px `smoke`). Kolom di x 380, lebar 680, tinggi penuh, `ink`, border kiri-kanan 1 px `smoke`, padding `24px 48px 0`, baris atas 44 px (`← Back`, `LORE`), `NEW STORY`, H1 36, paragraf, dan `PUMPKINS_PREP_DESKTOP` pada lapisan 1440 px yang dipusatkan (`aria-hidden`, `pointer-events: none`). Halaman mengalir, tidak diskalakan.
    - _Requirements: 3.8, 9.1, 9.2, 5.11_
  - [x] 3.5 Bangun `01 MATERIAL`: dropzone, `DocumentCard`, galat file
    - Dropzone 128 px dengan border 2 px putus-putus `smoke` tanpa file, border 2 px solid `gold` dengan nama file (elipsis satu baris) dan tombol `Replace` bila ada file valid. `<label>` membungkus `input type=file`; `data-testid` `material-dropzone` dan `material-file-input`. `DocumentCard` memakai token Kit dengan semua `data-testid` lama (`document-card`, `document-name`, `document-stats`, `document-remove`, `document-error`, `section-checkbox-*`, `material-budget-count`). Galat (tipe, lebih dari 25 MB, baca gagal) memakai `ErrorLine` dengan teks `IngestFailure.message` yang ada, dropzone kembali kosong, pilihan lain dipertahankan.
    - _Requirements: 9.3, 9.4, 9.9, 9.10, 9.11, 9.12, 12.12_
  - [x] 3.6 Bangun `02 WORLD`
    - Grid 3 kolom sel 84 px di dalam border 2 px `smoke`, `radiogroup` "World", sel terpilih `cream` dengan kotak `ember` 8 px, tepat satu terpilih, radio native `sr-only`, `data-testid="genre-<genre>"`.
    - _Requirements: 9.5, 9.10_
  - [x] 3.7 Bangun `03 CHAPTERS` dan sambungkan ke `length_set`
    - Lima kotak 44x44 `radiogroup` "Number of chapters" (bawaan 3, terpilih terisi `ember`, kotak nonaktif sesuai OQ-6) memanggil `lengthForChapters` dan `length_set` yang ada. Tautan `› Advanced options` (tinggi sentuh 44) membuka `AdvancedOptions` lama; restyle-nya di task 8.
    - _Requirements: 9.6, 9.10, 13.1_
  - [x] 3.8 Bangun bar aksi, sambungkan halaman, perbarui tes yang ada
    - Bar bawah 80 px dengan status (`submit-hint`, `aria-live="polite"`) dan tombol `Build the world →` 48 px (`build-button`; disabled `smoke`/`muted` dengan `aria-disabled` dari `selectSubmitBlocker`, aktif `ember`/`ink`). Status siap `Ready · {n} chapters · {world}`, selain itu `BLOCKER_HINT`. Logika `create-form` tidak berubah; teks yang diketik hanya menjadi instruksi tambahan. Perbarui `tests/setup/create-page.test.tsx` tanpa mengurangi asersi.
    - _Requirements: 9.2, 9.7, 9.8, 9.9, 9.10, 14.1_
  - [x] 3.9 Tulis tes komponen Prep
    - `frontend/tests/setup/create-page.test.tsx` (jsdom): lima kotak CHAPTERS, tombol Build disabled tanpa file dan aktif dengan file, galat file mempertahankan world, bab, dan instruksi, pemilihan world tepat satu.
    - _Requirements: 9.6, 9.7, 9.8, 9.11, 9.12, 14.3_
  - [x] 3.10 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 3.11 Ringkasan_Penyimpangan task 3
    - Bandingkan dengan `Prep.dc.html` pada 1440x900. Catat kotak CHAPTERS nonaktif (OQ-6), `DocumentCard` yang tidak ada di canvas, dan komponen baru (`SectionLabel`).
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.10, 5.11_

- [x] 4. Task 4: Preparation phone
  - Rujukan: DESIGN-SYSTEM §4.6; Canvas_Frame_File `PrepMobile.dc.html`. Komponen dan logika sama dengan task 3, hanya CSS `md:` yang berbeda.
  - [x] 4.1 Bangun layout phone
    - Tambah `PUMPKINS_PREP_PHONE` dari `PrepMobile.dc.html`. Header 56 px (ikon `back`, `LORE`), padding 20, satu kolom tanpa scroll horizontal, H1 28/1.15, paragraf 14/1.5, dropzone menumpuk ikon di atas teks dengan tombol `Choose a file` selebar penuh, baris world 54 px selebar penuh, CHAPTERS grid 5 kolom sama lebar, bar bawah `sticky bottom-0` dengan satu baris status di atas tombol 52 px selebar penuh. Tanpa file: tombol disabled dan status "Upload a material file to begin.".
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6, 10.7_
  - [x] 4.2 Sambungkan ikon kembali
    - Ikon `back` kembali ke layar sebelumnya tanpa mereset world, bab, file, atau instruksi (state di halaman yang sama).
    - _Requirements: 10.5_
  - [x] 4.3 Tulis tes kesetaraan phone dan desktop
    - `frontend/tests/setup/create-page.test.tsx` (jsdom): untuk input yang sama payload dan hasil validasi identik pada lebar phone dan desktop; tombol kembali tidak mereset state.
    - _Requirements: 10.5, 10.6, 10.7, 14.3_
  - [x] 4.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 4.5 Ringkasan_Penyimpangan task 4
    - Bandingkan dengan `PrepMobile.dc.html` pada 390x844 dan catat konstanta baru `PUMPKINS_PREP_PHONE`.
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.10_

- [x] 5. Task 5: Home
  - Rujukan: DESIGN-SYSTEM §4.7; Canvas_Frame_File sesuai opsi terpilih: `HomeA.dc.html` dan `HomeAMobile.dc.html`, atau `HomeB.dc.html` dan `HomeBMobile.dc.html`, atau `HomeC.dc.html` dan `HomeCMobile.dc.html`. Halaman `app/page.tsx` dan `components/home/*`.
  - [x] 5.1 Gerbang: OQ-1 (Home A, B, atau C) dan OQ-10
    - Tampilkan tabel perbandingan A, B, C dari design.md bagian Home beserta rekomendasi design (C: biaya dan risiko terendah, tanpa perubahan komponen Kit, fluid dari 768 px). Keputusan belum ada, jangan mengasumsikan C. Minta user memilih tepat satu.
    - Minta juga persetujuan OQ-10: `SavedStories` dirancang dan disetujui bersama task ini, tidak diberi label sendiri, dan diusulkan masuk daftar Requirement 12.1.
    - BERHENTI sampai user memilih. Sub-task 5.4, 5.5, 5.7, dan 5.8 mengikuti pilihan itu.
    - _Requirements: 11.1, 11.7_
  - [x] 5.2 Implementasikan `lib/home/file-check.ts`
    - `validateHomeFile({ name, size, type })` memakai `detectFileKind` dan `MAX_FILE_BYTES` dari `lib/ingest` tanpa mengubahnya; hasil `{ ok: true } | { ok: false, reason: 'unsupported_format' | 'empty_file' | 'too_large', message }`. Pesan: "Unsupported format. Use PDF, DOCX, PPTX, TXT or MD.", "This file is empty.", "This file is larger than 25 MB.".
    - _Requirements: 11.4, 11.5, 13.2, 13.3_
  - [x] 5.3 Tulis property test untuk validasi file Home
    - **Property 17: Home menerima file jika dan hanya jika format dan ukuran valid**
    - File: `frontend/tests/home/file-check.test.ts`.
    - **Validates: Requirements 11.4, 11.5**
  - [x] 5.4 Pertahankan perilaku `HomeComposer` pada opsi terpilih
    - `<label>` terhubung (teks sr-only "Instructions for the storyteller"), `data-testid` `home-input`, `home-instructions-count`, `home-attach`, `home-file-input`, `home-file-chip`, `home-file-remove`, `home-send`; `maxLength` 500; Enter mengirim dan Shift+Enter baris baru; `validateHomeFile` dengan `ErrorLine` yang mempertahankan teks dan file valid; kirim lewat `setPendingMaterial({ file, instructions })` lalu `router.push("/create")` dengan struktur data identik; tanpa file tetap di Home dengan `home-file-required`; teks dan file dikosongkan setelah kirim.
    - _Requirements: 11.4, 11.5, 11.9, 11.10, 11.13_
  - [x] 5.5 Bangun hero desktop dan phone untuk opsi terpilih
    - Hero 900 px (desktop) atau 844 px (phone) sesuai canvas dan koordinat di design.md; tautan demo "Play the demo: The Last Beacon" (`home-demo-link`, ke `/game`) berperilaku sama seperti sebelumnya. Opsi A: tambah `maxLength`, `onInvalid`, `inputTestId` pada `PumpkinMouthInput` dan konstanta phone. Opsi B: `ScaledBoard`, Hazel dengan ekspresi `surprised` dan teks khusus saat file ditambahkan, kembali ke awal saat semua file dihapus, teks canvas diubah agar tidak menyiratkan topik saja cukup. Opsi C: `wordmark()` dan bar perintah fluid `min(760px, 100% - 32px)`. Tidak ada elemen opsi lain pada viewport mana pun.
    - _Requirements: 11.1, 11.6, 11.11, 11.12, 3.8_
  - [x] 5.6 Restyle `SavedStories` dari token Kit
    - Kolom 680 px, `SectionLabel` `01 YOUR STORIES`, baris dipisah garis 1 px `smoke`, tombol `Continue` atau `Replay` (primer 44) dan `Delete` dengan konfirmasi dua langkah `Delete`/`Keep`; urutan, isi item, `data-testid` (`saved-stories`, `saved-story-<id>`, `continue-<id>`, `delete-<id>`, `confirm-delete-<id>`) dan perilaku sama seperti sebelumnya; keadaan kosong tanpa error.
    - _Requirements: 11.7, 11.8, 12.12_
  - [x] 5.7 Hapus komponen opsi yang tidak dipilih
    - Hapus dari `frontend/src` dan `frontend/tests` semua komponen dan referensi milik dua opsi lain (bila A tidak dipilih: `PumpkinMouthInput`), lalu pastikan pencarian namanya 0 kecocokan. `reference/canvas` tidak berubah.
    - _Requirements: 11.2, 11.3_
  - [x] 5.8 Perbarui tes yang ada
    - `tests/home/home-composer.test.tsx` dan `tests/home/home-page.test.tsx`: 13 tes yang ada tetap diuji dengan elemen baru, tanpa mengurangi asersi.
    - _Requirements: 14.1, 14.2_
  - [x] 5.9 Tulis tes komponen Home
    - jsdom: file ditolak (format, kosong, di atas 25 MB) mempertahankan teks dan file valid, kirim tanpa file tidak berpindah, kirim dengan file memanggil `setPendingMaterial`, konfirmasi hapus `SavedStories` dua langkah.
    - _Requirements: 11.5, 11.9, 11.10, 14.3_
  - [x] 5.10 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 5.11 Ringkasan_Penyimpangan task 5
    - Bandingkan dengan canvas desktop dan phone dari opsi terpilih. Catat opsi yang dipilih, teks yang diubah agar file wajib, komponen yang dihapus, dan penyimpangan lebar bar di bawah 792 px (opsi C).
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.10, 5.11_

- [x] 6. Task 6: GenerationScreen (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola K di design.md bagian 6.1. Canvas_Frame_File: tidak ada. File: `components/setup/GenerationScreen.tsx`.
  - [x] 6.1 Gerbang: persetujuan rancangan 6.1
    - Tampilkan rancangan 6.1 (empat baris langkah, review konsep, pratinjau dunia, galat, teks tampilan, ukuran desktop dan phone) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `GenerationScreen.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [x] 6.2 Implementasikan dari komponen dan token Kit
    - Pola K, `data-testid` `generation-steps`, `step-<stage>` dengan `data-status`, `concept-review`, `concept-checkbox-<id>`, `confirm-concepts`, `world-preview`, `generation-error`, `generation-retry` dipertahankan; tanpa `animate-spin`; galat memakai `ErrorLine`. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12, 3.3_
  - [x] 6.3 Tulis tes komponen
    - jsdom: tombol `confirm-concepts` disabled saat nol konsep terpilih, `generation-retry` memicu ulang.
    - _Requirements: 14.3_
  - [x] 6.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 6.5 Ringkasan_Penyimpangan task 6
    - Karena tidak ada canvas, bandingkan secara tertulis dengan rancangan 6.1 yang disetujui dan aturan §1 sampai §3. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [x] 7. Task 7: Log chat, ChatLog (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola M di design.md bagian 6.2. Canvas_Frame_File: tidak ada. File: `components/stage/ChatLog.tsx`.
  - [x] 7.1 Gerbang: persetujuan rancangan 6.2
    - Tampilkan rancangan 6.2 (modal `STORY LOG`, item dialog, narasi, lesson, keadaan kosong "Nothing yet.") dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `ChatLog.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [x] 7.2 Bangun `Modal` dan implementasikan `ChatLog`
    - `Modal` di `components/ui` (Pola M: `fixed inset-0 z-50`, `bg-ink/90`, panel border 2 px `smoke`, tick sudut `gold`, fokus awal ke `Close`, `Esc` dan klik di luar menutup, fokus kembali ke pemicu, dirender di luar `ScaledBoard`). `ChatLog` mempertahankan `chat-log`, `role="dialog"`, `aria-modal`, `aria-labelledby`. Dokumentasikan `Modal` di DESIGN-SYSTEM.md.
    - _Requirements: 12.1, 12.12, 5.11, 7.11_
  - [x] 7.3 Tulis tes `Modal` dan `ChatLog`
    - `frontend/tests/ui/modal.test.tsx` (jsdom): `Esc` menutup, fokus awal dan kembali, `Close` 44 px.
    - _Requirements: 14.3_
  - [x] 7.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 7.5 Ringkasan_Penyimpangan task 7
    - Bandingkan secara tertulis dengan rancangan 6.2 yang disetujui; catat komponen baru `Modal`.
    - _Requirements: 5.7, 5.8, 5.11_

- [x] 8. Task 8: AdvancedOptions (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, design.md bagian 6.3. Canvas_Frame_File: tidak ada. File: `components/setup/AdvancedOptions.tsx`.
  - [x] 8.1 Gerbang: persetujuan rancangan 6.3
    - Tampilkan rancangan 6.3 (`details` di dalam `03 CHAPTERS`, segmen bahasa, textarea instruksi dengan hitung `n / 500`, pemilih panjang cerita dihapus karena pindah ke kotak CHAPTERS) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `AdvancedOptions.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [x] 8.2 Implementasikan dari token Kit
    - `data-testid="advanced-options"`, `<textarea id="story-instructions">` dengan label, `maxLength` 500. Hapus pemilih panjang cerita dari komponen ini (kotak CHAPTERS di task 3 adalah satu-satunya kontrol). Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12, 9.10_
  - [x] 8.3 Tulis tes komponen
    - jsdom: pemilihan bahasa, batas 500 karakter, instruksi tersimpan ke state form.
    - _Requirements: 14.3_
  - [x] 8.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 8.5 Ringkasan_Penyimpangan task 8
    - Bandingkan secara tertulis dengan rancangan 6.3; catat penghapusan pemilih panjang cerita dan hubungannya dengan OQ-6.
    - _Requirements: 5.7, 5.8_

- [x] 9. Task 9: CampaignLobby (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola K di design.md bagian 6.4. Canvas_Frame_File: tidak ada. File: `components/campaign/CampaignLobby.tsx`.
  - [x] 9.1 Gerbang: persetujuan rancangan 6.4
    - Tampilkan rancangan 6.4 (daftar cerita dengan `StatusBadge` `Locked`/`Available`/`Current`/`Completed`, baris `Current` dibalik, tombol `Start Story` atau `Continue`) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `CampaignLobby.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [x] 9.2 Bangun `StatusBadge` dan implementasikan `CampaignLobby`
    - `StatusBadge` di `components/ui` (varian `done`, `current`, `available`, `locked`). Pertahankan `campaign-lobby`, `lobby-home-link`, `campaign-title`, `lobby-view-results`, `story-list`, `story-entry-<id>`, `story-badge-<id>`, `start-story-<id>`. Dokumentasikan `StatusBadge` di DESIGN-SYSTEM.md. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12, 5.11_
  - [x] 9.3 Tulis tes komponen
    - jsdom: cerita terkunci tidak punya tombol mulai, `Current` menampilkan `Continue`, `StatusBadge` per varian.
    - _Requirements: 14.3_
  - [x] 9.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [x] 9.5 Ringkasan_Penyimpangan task 9
    - Bandingkan secara tertulis dengan rancangan 6.4; catat komponen baru `StatusBadge`.
    - _Requirements: 5.7, 5.8, 5.11_

- [ ] 10. Task 10: CampaignPlayer (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, design.md bagian 6.5. Canvas_Frame_File: tidak ada. File: `components/campaign/CampaignPlayer.tsx`.
  - [~] 10.1 Gerbang: persetujuan rancangan 6.5
    - Tampilkan rancangan 6.5 (tanpa UI sendiri; lobby dan summary dalam wadah `min-h-dvh` berlatar `lore-grid-bg` yang menggulir, stage dalam `ScaledBoard`) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `CampaignPlayer.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [~] 10.2 Implementasikan pembungkus
    - Tiga cabang (`CampaignSummary`, `CampaignLobby`, `StoryViewer` dengan `key` `story_id`) tetap. Ganti `h-screen` dan overflow lama sesuai rancangan. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12_
  - [~] 10.3 Tulis tes pemilihan cabang
    - jsdom: cabang yang benar dirender untuk status kampanye, `StoryViewer` di-remount saat `story_id` berganti.
    - _Requirements: 14.3_
  - [~] 10.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 10.5 Ringkasan_Penyimpangan task 10
    - Bandingkan secara tertulis dengan rancangan 6.5. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [ ] 11. Task 11: CampaignSummary (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola K di design.md bagian 6.6. Canvas_Frame_File: tidak ada. File: `components/campaign/CampaignSummary.tsx`.
  - [~] 11.1 Gerbang: persetujuan rancangan 6.6
    - Tampilkan rancangan 6.6 (eyebrow `EPILOGUE`, epilog per cerita, `01 WHAT YOU LEARNED`, penanda hasil per konsep, tombol bawah) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `CampaignSummary.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [~] 11.2 Implementasikan dari token Kit
    - Pertahankan `campaign-summary`, `epilogue-<id>`, `learning-evaluation`, `evaluation-headline`, `concept-result-<id>` dengan `data-outcome`. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12_
  - [~] 11.3 Tulis tes komponen
    - jsdom: ringkasan `mastered`, `developing`, `practice`, `unseen`; kalimat "No concepts were tested in this campaign.".
    - _Requirements: 14.3_
  - [~] 11.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 11.5 Ringkasan_Penyimpangan task 11
    - Bandingkan secara tertulis dengan rancangan 6.6. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [ ] 12. Task 12: EndingDisplay (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola P di design.md bagian 6.7. Canvas_Frame_File: tidak ada. File: `components/story/EndingDisplay.tsx`.
  - [~] 12.1 Gerbang: persetujuan rancangan 6.7
    - Tampilkan rancangan 6.7 (panel di atas papan Stage, badge `Success`/`Failed`/`Partial Success`, judul, narasi dengan scroll di dalam panel) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `EndingDisplay.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [~] 12.2 Implementasikan dari token Kit
    - Pertahankan `ending-display`, `ending-type-badge`, `role="region"` dan `aria-label`. Panel rata atas dan menggulir di dalam. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12_
  - [~] 12.3 Tulis tes komponen
    - jsdom: badge per tipe ending dan label aksesibel.
    - _Requirements: 14.3_
  - [~] 12.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 12.5 Ringkasan_Penyimpangan task 12
    - Bandingkan secara tertulis dengan rancangan 6.7. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [ ] 13. Task 13: StoryComplete (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola P di design.md bagian 6.8. Canvas_Frame_File: tidak ada. File: `components/story/StoryComplete.tsx`.
  - [~] 13.1 Gerbang: persetujuan rancangan 6.8
    - Tampilkan rancangan 6.8 (badge `Story Complete`/`Campaign Complete`, pesan, tombol `See your results →`, `Continue Campaign →`, `Exit Story`/`Return to Lobby`) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `StoryComplete.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [~] 13.2 Implementasikan dari token Kit
    - Pertahankan `story-complete-screen`, `story-complete-title`, `campaign-complete-message`, `view-results-button`, `continue-campaign-button`, `exit-button`. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12_
  - [~] 13.3 Tulis tes komponen
    - jsdom: tombol yang muncul untuk kampanye selesai dan belum selesai.
    - _Requirements: 14.3_
  - [~] 13.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 13.5 Ringkasan_Penyimpangan task 13
    - Bandingkan secara tertulis dengan rancangan 6.8. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [ ] 14. Task 14: StoryFailure (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola P di design.md bagian 6.9. Canvas_Frame_File: tidak ada. File: `components/story/StoryFailure.tsx`.
  - [~] 14.1 Gerbang: persetujuan rancangan 6.9
    - Tampilkan rancangan 6.9 (badge `Story Failed`, `HP: 0 / 5` tetap berformat lama, penjelasan, tombol `Retry Story`) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `StoryFailure.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [~] 14.2 Implementasikan dari token Kit
    - Pertahankan `story-failure`, `story-failure-title`, `story-failure-hp` (teks `HP: 0 / 5`), `retry-button`, `role="alert"`. Tanpa warna bahaya. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12, 3.1_
  - [~] 14.3 Tulis tes komponen
    - jsdom: `retry-button` memanggil callback retry, teks HP tetap.
    - _Requirements: 14.3_
  - [~] 14.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 14.5 Ringkasan_Penyimpangan task 14
    - Bandingkan secara tertulis dengan rancangan 6.9. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [ ] 15. Task 15: StoryViewer, overlay galat dan dialog keluar (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola P dan M di design.md bagian 6.10. Canvas_Frame_File: tidak ada. File: `components/story/StoryViewer.tsx`. Stage-nya sendiri dikerjakan di task 1 dan 2.
  - [~] 15.1 Gerbang: persetujuan rancangan 6.10
    - Tampilkan rancangan 6.10 (galat navigasi, `scene-error`, dialog keluar `Exit Story?` dengan `Cancel` dan `Exit Anyway`, tombol `↩ Try a different choice`) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, bagian ini dari `StoryViewer.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [~] 15.2 Implementasikan overlay dan dialog dari token Kit
    - Galat navigasi (`story-viewer-error`, `role="alert"`, `aria-live="assertive"`), `scene-error` dengan `ErrorLine`, `exit-confirm-dialog` memakai `Modal` (`role="dialog"`, `aria-modal`, `aria-labelledby="exit-confirm-title"`, fokus awal ke `Cancel`), `bad-branch-return-btn` dan `bad-ending-return-btn` sebagai tombol outline 44 dengan ikon `back`. Ganti sisa gaya lama di file. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12, 3.1_
  - [~] 15.3 Tulis tes komponen
    - jsdom: dialog keluar (fokus awal `Cancel`, `Exit Anyway` memanggil callback keluar), `story-viewer-error` dengan `role="alert"`.
    - _Requirements: 14.3_
  - [~] 15.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 15.5 Ringkasan_Penyimpangan task 15
    - Bandingkan secara tertulis dengan rancangan 6.10. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [ ] 16. Task 16: PlayProject (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8, Pola K ringkas di design.md bagian 6.11. Canvas_Frame_File: tidak ada. File: `components/play/PlayProject.tsx` dan pita galat simpan di `/create`.
  - [~] 16.1 Gerbang: persetujuan rancangan 6.11
    - Tampilkan rancangan 6.11 (`play-loading`, `play-missing`, pita `play-save-error` dan `create-save-error` berlatar `ember`) dan tunggu persetujuan eksplisit user. Tanpa persetujuan, `PlayProject.tsx` tidak diubah dan task ini dilewati.
    - _Requirements: 12.3, 12.4, 12.5_
  - [~] 16.2 Implementasikan dari token Kit
    - `play-loading` (juga ekspor `PlayLoading`) tanpa animasi, `play-missing` dengan tombol `Back to your stories` (`href="/"`), pita galat simpan tinggi 44 (`ember`/`ink`, `role="alert"`). Validasi Zod data tersimpan tidak berubah. Perbarui tes yang ada tanpa mengubah asersi `data-testid` atau perilaku.
    - _Requirements: 12.1, 12.12, 13.4, 13.5, 13.10_
  - [~] 16.3 Tulis tes komponen
    - jsdom: `play-missing` untuk project tidak ada, `play-save-error` saat simpan gagal.
    - _Requirements: 14.3_
  - [~] 16.4 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 16.5 Ringkasan_Penyimpangan task 16
    - Bandingkan secara tertulis dengan rancangan 6.11. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 5.7, 5.8_

- [ ] 17. Task 17: Mode dua karakter di Stage (tanpa frame canvas)
  - Rujukan: DESIGN-SYSTEM §6, §4.1, §4.2, design.md bagian 6.12. Canvas_Frame_File: `Cast.dc.html` hanya untuk cast; tidak ada frame Stage dua karakter.
  - [~] 17.1 Gerbang: persetujuan rancangan 6.12
    - Tampilkan rancangan 6.12 (karakter lain 40% di slot `CanvasFrame` pada desktop, tidak digambar di phone) dan alternatif ukuran: figur penuh 8 px (rekomendasi design) atau bust 9 px. Tunggu persetujuan eksplisit user. Tanpa persetujuan, Stage tetap satu karakter dan task ini dilewati.
    - _Requirements: 12.4, 12.5, 12.9_
  - [~] 17.2 Tambah `pickOtherCharacter` dan perluas `visibleSprites`
    - `pickOtherCharacter(presentIds, activeId, chars)` di `lib/cast/cast-mapping.ts` mengembalikan karakter lain yang hadir atau `null`. `visibleSprites('desktop', ...)` memuat karakter lain paling banyak sekali, `visibleSprites('phone', ...)` tetap satu.
    - _Requirements: 12.6, 12.7, 12.8, 13.3_
  - [~] 17.3 Tulis property test untuk karakter lain
    - **Property 5: Karakter lain berbeda dari penutur aktif**
    - File: `frontend/tests/cast/cast-mapping.test.ts`. Jalankan ulang Property 4 di `tests/stage/stage-boxes.test.ts` untuk memastikan perluasan `visibleSprites` tidak merusaknya.
    - **Validates: Requirements 12.6, 12.7**
  - [~] 17.4 Render karakter lain di Stage
    - Desktop, beat tanpa canvas (scene `ambient`): `renderCharacter(castId, 'calm')` sel 8 px di (694, 47), opacity 40%, `role="img"` dengan label `{nama}, calm`; sprite aktif opacity 100%. Beat dengan canvas: karakter lain tidak digambar. Phone: tidak digambar. Tanpa teks baru.
    - _Requirements: 12.6, 12.7, 12.8, 6.8_
  - [~] 17.5 Tulis tes Stage dua karakter
    - `frontend/tests/stage/two-character.test.tsx` (jsdom): opacity 100% dan 40%, label aksesibel, tidak ada karakter lain di phone atau saat ada canvas.
    - _Requirements: 12.6, 12.7, 12.8, 14.3_
  - [~] 17.6 Verifikasi
    - Jalankan Verifikasi_Task penuh dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 17.7 Ringkasan_Penyimpangan task 17
    - Bandingkan secara tertulis dengan rancangan 6.12 dan DESIGN-SYSTEM §6. Catat pilihan ukuran karakter.
    - _Requirements: 5.7, 5.8_

- [ ] 18. Task 18: Penutup, hapus gaya lama dan perbarui steering
  - Rujukan: DESIGN-SYSTEM §1 sampai §3 dan §8; design.md bagian "Rencana penghapusan gaya lama" dan "Pembaruan steering". Canvas_Frame_File: tidak ada.
  - [~] 18.1 Gerbang: OQ-11, folder Kit, dan layar yang belum selesai
    - Tampilkan layar yang gerbangnya belum disetujui atau belum selesai. Penghapusan file lama yang masih dipakai layar itu ditunda dan task ini ditandai belum selesai (Requirement 4.3).
    - Minta persetujuan atas OQ-11 (memperbarui fakta komponen yang dihapus di steering `product`, `ai-pipeline`, `game-engine` dengan perubahan minimal) dan tanyakan apakah folder `lore-design-kit/` (belum dilacak git, di luar path Requirement 1.5) boleh dihapus. Tanyakan juga apakah steering `theme-halloween` tetap bernama itu.
    - BERHENTI sampai user menjawab.
    - _Requirements: 1.6, 4.3_
  - [~] 18.2 Cari pemakai dan hapus file lama
    - Untuk `components/backdrop/GlassFilter.tsx`, `components/home/PumpkinMark.tsx`, dan skrip `LIQUID_GLASS_CHECK` di `layout.tsx`: cari pemakai di `frontend/src` dan `frontend/tests`, catat hasil per file. Hapus hanya yang pemakainya 0. Bila masih ada pemakai, cantumkan path dan nomor baris, jangan hapus, dan tandai task belum selesai. `components/backdrop/PumpkinBackdrop.tsx` dan `lib/ascii-field/*` TIDAK dihapus (keputusan user 2026-11-21: labu ASCII beranimasi tetap di semua layar; pengecualian resmi dari "gaya lama" karena berupa animasi ASCII). Pastikan `PumpkinBackdrop` tidak bergantung pada `GlassFilter` atau `LIQUID_GLASS_CHECK` (hasil pemeriksaan: tidak bergantung), tetap dipasang di `layout.tsx`, dan kelas `.lore-ascii-field` di `globals.css` tetap dipertahankan di 18.3. Hapus atau perbarui tes yang hanya menguji file yang dihapus dan catat nama tes dan alasannya.
    - _Requirements: 4.2, 4.3, 4.4, 14.2_
  - [~] 18.3 Bersihkan `globals.css`, warna literal, dan ikon lama
    - Ganti isi `app/globals.css` dengan `@import "tailwindcss";` dan `@import "./lore-tokens.css";`. Hapus variabel dan kelas lama (`--hw-*`, `--glass-*`, `--accent-gold`, `--background-panel`, `--foreground-muted`, `lore-glass*`, `liquid`, dan sisanya di design.md). Hapus warna literal tersisa di `components` dan `app` di luar `CAST`. Pastikan tidak ada impor `lucide-react` tersisa; paketnya dibiarkan di `package.json` dan dilaporkan sebagai dependensi tak terpakai.
    - Pencarian `--hw-`, `--glass-`, `--background-panel`, `--accent-gold`, `--foreground-muted`, `liquid` di `frontend/src` dan `frontend/tests` harus 0 kecocokan.
    - _Requirements: 3.1, 3.3, 3.4, 4.1_
  - [~] 18.4 Tulis tes pagar statis
    - `frontend/tests/ui/style-guard.test.ts`: tanpa hex, `rgb()`, `hsl()`, kelas warna bawaan Tailwind di `src/components` dan `src/app` di luar `CAST`; tanpa `rounded-`, `shadow-` (kecuali `.lore-dialog`), `backdrop-`, `blur`, gradient (kecuali `.lore-grid-bg`), emoji; tanpa `font-family` selain dua font; komentar header di baris pertama file baru; `'use client'` pada komponen yang memakai API browser.
    - _Requirements: 3.1, 3.2, 3.3, 13.9, 15.5_
  - [~] 18.5 Tulis property test untuk fungsi murni yang tidak melempar
    - **Property 19: Fungsi murni baru tidak pernah melempar**
    - File: `frontend/tests/lib/pure-functions-total.test.ts`, mencakup `computeBoardScale`, `selectLayout`, `hpSquares`, `revealedCount`, `revealPrefix`, `chapterSquares`, `lengthForChapters`, `validateHomeFile`.
    - **Validates: Requirements 13.3**
  - [~] 18.6 Ganti isi steering `theme-halloween`
    - Ganti seluruh isi dengan aturan Kit (token, tipografi, bentuk, ASCII, larangan) dan rujukan ke `AGENTS.md` dan `docs/DESIGN-SYSTEM.md`. `--hw-`, `--glass-`, `liquid`, dan `Halloween` tidak muncul sebagai aturan gaya. Nama file mengikuti jawaban 18.1.
    - _Requirements: 4.5_
  - [~] 18.7 Perbarui steering `conventions`
    - Ganti hanya butir gaya (CSS variable lewat `style` inline) dengan aturan token Tailwind Kit dan rujukan ke `AGENTS.md` dan Design_System. Butir lain identik dengan versi sebelumnya.
    - _Requirements: 4.6_
  - [~] 18.8 Verifikasi
    - Jalankan Verifikasi_Task penuh, catat jumlah file dan jumlah tes Vitest terakhir, dan pastikan Golden_Test 40 dari 40.
    - _Requirements: 4.4, 5.3, 5.4, 5.5, 14.7, 14.8_
  - [~] 18.9 Perbarui steering `tech` dan `structure`
    - `tech`: font (Space Grotesk dan JetBrains Mono lewat `next/font`), folder `components/ascii` dan `lib/ascii`, jumlah file dan tes dari 18.8, `fast-check` bila disetujui, versi Zod hanya bila user memutuskannya. `structure`: tambah `ascii`, `ui` di `components/`; tambah `ascii`, `cast`, `stage`, `dialogue`, `prep`, `home`, `schemas` di `lib/`, pertahankan `backdrop` (hanya `PumpkinBackdrop`) dan `ascii-field`. Baris lain tidak berubah.
    - _Requirements: 4.7_
  - [~] 18.10 Perbarui steering `product`, `ai-pipeline`, `game-engine` (hanya bila OQ-11 disetujui)
    - Perbarui hanya fakta yang berubah: deskripsi Home, stage (sprite ASCII Kit, `DialogueBox`), dan catatan glass. Bila ditolak, lewati dan catat.
    - _Requirements: 4.5_
  - [~] 18.11 Pemeriksaan akhir
    - `git diff --name-only dev -- backend/` kosong, 0 baris diff pada `lib/contracts`, `project-store.ts`, dan `backend/app/ai/contracts`, `frontend/package.json` dan `package-lock.json` byte-identik (kecuali `fast-check` yang disetujui), pencarian pola lama 0 kecocokan, dan folder `lore-design-kit/` dihapus hanya bila disetujui di 18.1.
    - _Requirements: 1.4, 1.7, 4.1, 13.1, 13.6, 13.10, 14.9_
  - [~] 18.12 Ringkasan_Penyimpangan task 18
    - Catat hasil pencarian per file yang dihapus, tes yang dihapus atau diperbarui beserta penggantinya, layar yang belum selesai, `lucide-react` sebagai dependensi tak terpakai, keputusan OQ-11, dan nasib folder `lore-design-kit/`. Tanpa penyimpangan, tulis "tidak ada".
    - _Requirements: 4.2, 4.3, 4.4, 5.8_

## Notes

- Sub-task bertanda `*` bersifat opsional dan dapat dilewati untuk MVP lebih cepat. Requirement 14.3 dan 14.4 mewajibkan tes komponen baru dan tes pemetaan; melewatkannya berarti requirement itu belum terpenuhi.
- Properti diuji hanya pada logika murni baru. Tata letak, warna, dan ukuran sentuh diperiksa lewat screenshot dan Ringkasan_Penyimpangan karena jsdom tidak menghitung tata letak.
- Bila user menolak `fast-check` (OQ-8), sub-task properti memakai tabel lengkap atau loop berbenih tetap, dengan keterbatasan dicatat.
- Sub-task tes yang menulis ke file yang sama ditempatkan di wave berbeda agar tidak bentrok.
- Sub-task Gerbang adalah titik berhenti untuk keputusan user: OQ-1 (task 5), OQ-2 dan OQ-8 (task 0), OQ-6 (task 3), OQ-7 (task 2), OQ-9 dan OQ-12 (task 1), OQ-10 (task 5), OQ-11 (task 18), serta persetujuan rancangan untuk task 6 sampai 17.
- Pekerjaan lanjutan di luar spec ini: adopsi `SceneBlueprint` ke alur AI, Grilling dan estimasi kredit (OQ-3), dan perubahan versi Zod.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["0.2"] },
    { "id": 2, "tasks": ["0.3"] },
    { "id": 3, "tasks": ["0.4"] },
    { "id": 4, "tasks": ["0.5"] },
    { "id": 5, "tasks": ["0.6"] },
    { "id": 6, "tasks": ["0.7", "0.8"] },
    { "id": 7, "tasks": ["0.9"] },
    { "id": 8, "tasks": ["0.10"] },
    { "id": 9, "tasks": ["1.1"] },
    { "id": 10, "tasks": ["1.2", "1.4", "1.5", "1.13", "1.19"] },
    { "id": 11, "tasks": ["1.23", "1.3", "1.6", "1.9", "1.10", "1.12", "1.14", "1.20"] },
    { "id": 12, "tasks": ["1.24", "1.7", "1.11", "1.15", "1.21"] },
    { "id": 13, "tasks": ["1.25", "1.8", "1.16", "1.22"] },
    { "id": 14, "tasks": ["1.26", "1.17"] },
    { "id": 15, "tasks": ["1.27", "1.18"] },
    { "id": 16, "tasks": ["1.28", "1.29"] },
    { "id": 17, "tasks": ["1.30"] },
    { "id": 18, "tasks": ["1.31"] },
    { "id": 19, "tasks": ["2.1"] },
    { "id": 20, "tasks": ["2.2"] },
    { "id": 21, "tasks": ["2.3"] },
    { "id": 22, "tasks": ["2.4", "2.5"] },
    { "id": 23, "tasks": ["2.6"] },
    { "id": 24, "tasks": ["2.7"] },
    { "id": 25, "tasks": ["3.1"] },
    { "id": 26, "tasks": ["3.2", "3.4"] },
    { "id": 27, "tasks": ["3.3", "3.5", "3.6", "3.7"] },
    { "id": 28, "tasks": ["3.8"] },
    { "id": 29, "tasks": ["3.9"] },
    { "id": 30, "tasks": ["3.10"] },
    { "id": 31, "tasks": ["3.11"] },
    { "id": 32, "tasks": ["4.1"] },
    { "id": 33, "tasks": ["4.2"] },
    { "id": 34, "tasks": ["4.3"] },
    { "id": 35, "tasks": ["4.4"] },
    { "id": 36, "tasks": ["4.5"] },
    { "id": 37, "tasks": ["5.1"] },
    { "id": 38, "tasks": ["5.2"] },
    { "id": 39, "tasks": ["5.3", "5.4"] },
    { "id": 40, "tasks": ["5.5"] },
    { "id": 41, "tasks": ["5.6"] },
    { "id": 42, "tasks": ["5.7"] },
    { "id": 43, "tasks": ["5.8"] },
    { "id": 44, "tasks": ["5.9"] },
    { "id": 45, "tasks": ["5.10"] },
    { "id": 46, "tasks": ["5.11"] },
    { "id": 47, "tasks": ["6.1"] },
    { "id": 48, "tasks": ["6.2"] },
    { "id": 49, "tasks": ["6.3"] },
    { "id": 50, "tasks": ["6.4"] },
    { "id": 51, "tasks": ["6.5"] },
    { "id": 52, "tasks": ["7.1"] },
    { "id": 53, "tasks": ["7.2"] },
    { "id": 54, "tasks": ["7.3"] },
    { "id": 55, "tasks": ["7.4"] },
    { "id": 56, "tasks": ["7.5"] },
    { "id": 57, "tasks": ["8.1"] },
    { "id": 58, "tasks": ["8.2"] },
    { "id": 59, "tasks": ["8.3"] },
    { "id": 60, "tasks": ["8.4"] },
    { "id": 61, "tasks": ["8.5"] },
    { "id": 62, "tasks": ["9.1"] },
    { "id": 63, "tasks": ["9.2"] },
    { "id": 64, "tasks": ["9.3"] },
    { "id": 65, "tasks": ["9.4"] },
    { "id": 66, "tasks": ["9.5"] },
    { "id": 67, "tasks": ["10.1"] },
    { "id": 68, "tasks": ["10.2"] },
    { "id": 69, "tasks": ["10.3"] },
    { "id": 70, "tasks": ["10.4"] },
    { "id": 71, "tasks": ["10.5"] },
    { "id": 72, "tasks": ["11.1"] },
    { "id": 73, "tasks": ["11.2"] },
    { "id": 74, "tasks": ["11.3"] },
    { "id": 75, "tasks": ["11.4"] },
    { "id": 76, "tasks": ["11.5"] },
    { "id": 77, "tasks": ["12.1"] },
    { "id": 78, "tasks": ["12.2"] },
    { "id": 79, "tasks": ["12.3"] },
    { "id": 80, "tasks": ["12.4"] },
    { "id": 81, "tasks": ["12.5"] },
    { "id": 82, "tasks": ["13.1"] },
    { "id": 83, "tasks": ["13.2"] },
    { "id": 84, "tasks": ["13.3"] },
    { "id": 85, "tasks": ["13.4"] },
    { "id": 86, "tasks": ["13.5"] },
    { "id": 87, "tasks": ["14.1"] },
    { "id": 88, "tasks": ["14.2"] },
    { "id": 89, "tasks": ["14.3"] },
    { "id": 90, "tasks": ["14.4"] },
    { "id": 91, "tasks": ["14.5"] },
    { "id": 92, "tasks": ["15.1"] },
    { "id": 93, "tasks": ["15.2"] },
    { "id": 94, "tasks": ["15.3"] },
    { "id": 95, "tasks": ["15.4"] },
    { "id": 96, "tasks": ["15.5"] },
    { "id": 97, "tasks": ["16.1"] },
    { "id": 98, "tasks": ["16.2"] },
    { "id": 99, "tasks": ["16.3"] },
    { "id": 100, "tasks": ["16.4"] },
    { "id": 101, "tasks": ["16.5"] },
    { "id": 102, "tasks": ["17.1"] },
    { "id": 103, "tasks": ["17.2"] },
    { "id": 104, "tasks": ["17.3", "17.4"] },
    { "id": 105, "tasks": ["17.5"] },
    { "id": 106, "tasks": ["17.6"] },
    { "id": 107, "tasks": ["17.7"] },
    { "id": 108, "tasks": ["18.1"] },
    { "id": 109, "tasks": ["18.2"] },
    { "id": 110, "tasks": ["18.3"] },
    { "id": 111, "tasks": ["18.4", "18.5"] },
    { "id": 112, "tasks": ["18.6", "18.7"] },
    { "id": 113, "tasks": ["18.8"] },
    { "id": 114, "tasks": ["18.9", "18.10"] },
    { "id": 115, "tasks": ["18.11"] },
    { "id": 116, "tasks": ["18.12"] }
  ]
}
```
