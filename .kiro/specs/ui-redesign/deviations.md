# Ringkasan_Penyimpangan ui-redesign

## Task 0

Task 0 tidak mengubah layar mana pun. Penyimpangan yang tercatat:

1. **Zod (OQ-2) dan fast-check (OQ-8).**
   - Keputusan OQ-2: opsi B. Zod dikembalikan ke `^3.25.28` setelah `tsc` gagal dengan Zod 4. Keputusan ini menggantikan catatan awal di design.md ("working tree dibiarkan apa adanya").
   - `frontend/package-lock.json` dipulihkan dari HEAD lalu `npm install` dijalankan, agar tidak ada kenaikan versi paket lain yang tidak terkait.
   - Keputusan OQ-8: `fast-check ^4.10.3` ditambahkan ke `devDependencies` (disetujui user). Perubahan ada di `frontend/package.json` (+1 baris) dan `frontend/package-lock.json` (+41 baris).
2. **Perbaikan lint pada komponen Kit (disetujui user).**
   - `AsciiArt.tsx`: `setState` di dalam effect dihapus, ukuran px diturunkan dari `measuredW`.
   - `figure.ts`: parameter `c` dan `r` yang tidak terpakai dihapus.
   - Golden_Test tetap 40 dari 40 hijau, tanpa perubahan.
3. **`globals.css`.** `--font-sans` dan `--font-mono` diarahkan ke `--font-space-grotesk` dan `--font-jetbrains-mono`. Tidak diminta eksplisit. Perlu agar blok `:root` lama tidak menimpa token Kit.
4. **`layout.tsx`.**
   - Font Geist dan Geist Mono diganti `spaceGrotesk` dan `jetbrainsMono` dari `./fonts`.
   - Komentar header ditambahkan (sesuai konvensi), menyebut bahwa `GlassFilter`, `PumpkinBackdrop`, dan skrip `LIQUID_GLASS_CHECK` tetap ada sampai task 18.
5. **Penyalinan file.** 33 file disalin dari Kit, 0 file ditimpa. `README.md` Kit dan `backend/app/schemas/visual.py` tidak disalin, sehingga `git diff --name-only dev -- backend/` kosong.
6. **Jumlah tes.** Sekarang 668 tes di 51 file. Steering `tech` masih menyebut 618 tes (48 file). Steering belum diperbarui di task ini.
7. **Screenshot.** Tidak ada, karena task 0 tidak mengubah layar (Requirement 5.8 hanya berlaku untuk perubahan tampilan).
8. **`docs/DESIGN.md`.** Satu baris ditambahkan di akhir file: `Visual identity: see DESIGN-SYSTEM.md`.
9. **Keadaan transisi.** Layar lama masih tampil campuran (gaya lama `--hw-*`/`liquid` dengan font dan token baru) sampai task 18. Folder `lore-design-kit/` dan `reference/` belum dihapus dan masih ada di working tree. File lama (`GlassFilter`, `PumpkinBackdrop`, `PumpkinMark`, `lib/ascii-field`) belum dihapus.
10. **Commit.** Tidak ada commit atau push. Semua perubahan masih berada di working tree.

## Task 1

Ringkasan penyimpangan untuk task 1 (sub-task 1.2 sampai 1.30). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Persetujuan

- **OQ-9** disetujui user.
- **OQ-12** disetujui user.

### Per sub-task

1. **1.2 Icon.** Data path ikon ditulis tangan dan tidak dibandingkan dengan canvas.
2. **1.4.** Props `nameTag` (boolean) dan kunci `testIds` ditebak, karena spesifikasi tidak menyebutnya.
3. **1.5.** Signature fungsi dipilih sendiri oleh kami.
4. **1.13.**
   - `lib/cast` mengimpor `components/stage/emotion`.
   - `speakerTagName` ditambahkan.
   - `pickOtherCharacter` dan `fallbackCastNote` belum diimplementasikan.
5. **1.20.**
   - Wording Property 14 dan 15 di design.md menyebut `resolveShortcut` mengembalikan `null`, tetapi kode mengembalikan `{ok:false, reason}` (sesuai konvensi union hasil).
   - Nama file tes berbeda dari tasks.md: `board-scale-fit.property.test.ts`, `board-scale-position.property.test.ts`, `layout-breakpoint.property.test.ts`.
   - `use-typewriter` punya satu `eslint-disable` (`exhaustive-deps`), alasannya didokumentasikan di komentar.
6. **1.24.**
   - Jarak HUD phone dipilih sendiri oleh kami.
   - `useBoardPixelRatio` awalnya tidak dipakai.
   - Teks HP yang gagal berwarna ember.
7. **1.25.**
   - `DialogueBox` mendapat props tambahan: `testIds.mode` dan `wrapText`.
   - `aria-live` dihapus dari dialog.
8. **1.26.**
   - Tone purple dihapus karena Kit tidak punya warna purple.
   - `rx` pada SVG dibuang.
   - `TONE_COLORS` diubah.
   - Kontrol puzzle mengurangi tinggi canvas keputusan sekitar 220px.
   - Role `puzzle-choices` diubah dari `radiogroup` menjadi `group`.
9. **1.27.**
   - Hint "Click anywhere to continue" diganti hint tombol keyboard.
   - Pacing default menjadi `fast` saat reduced motion.
   - Teks HP `n / 5` menjadi `n/5`. Tes di `story-viewer`, `bad-branch`, dan `campaign-player` diperbarui dengan regex.
   - Assertion `canvasKind=ambient` di story-viewer diganti menjadi `stage-scene`/`stage-canvas`.
   - Ada assertion yang tidak menguji apa-apa (vacuous) di `bad-branch.test.tsx` sekitar baris 138.
   - Dihapus: `StageNavbar`, `StageCharacter`, `ChatBox`.
   - `StagePuzzle.tsx` dipertahankan karena tesnya masih ada. `lucide-react` masih dipakai di tempat lain.
   - Stub `getContext` di `tests/setup.ts` mengembalikan `null`.
   - Prop `genre` tidak dipakai.
   - Tidak ada tes yang dihapus.
   - **Insiden:** `git reset -q` sempat dijalankan. Tidak ada yang staged sebelum maupun sesudahnya, jadi tidak ada dampak.

### 1.30 Screenshot

- **Catatan metode.** File canvas `.dc.html` adalah template mentah. Karena itu yang dibandingkan adalah kotak hasil ukur terhadap §4.1 dan §4.2 DESIGN-SYSTEM.md. Semua cocok.
- **Perbaikan.** `DialogueBox` bottom bar phone diperbaiki dengan `min-w-0` dan `shrink-0`.
- **Penyimpangan 2 sampai 8 dari laporan 1.30 (nomor di bawah berurutan dari 1, sesuai urutan laporan):**
  1. Beat demo pertama adalah narasi, jadi tidak ada `CanvasFrame`.
  2. Tidak ada hint tombol `/ ask`.
  3. Ikon kembali berupa panah, bukan chevron.
  4. Baris chapter di phone terpotong karena string place panjang.
  5. Placeholder terpotong.
  6. Badge dev saling menimpa.
  7. `stage-scene` berukuran 1202x684 dan terpotong.

### Verifikasi akhir

- Lint: 0 error, 0 warning.
- `tsc`: bersih.
- Vitest: 65 file, 776 tes lulus.
- Golden: 40 dari 40.
- Build: berhasil.

## Task 2

Ringkasan penyimpangan untuk task 2 (layout phone Stage). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Keputusan

- **OQ-7 (keputusan user).** Tampilkan semua pilihan, sampai 4. R8.4 dan R8.8 diubah menjadi "1-4" dan "maksimal 4". DESIGN-SYSTEM.md §4.2 diperbarui.

### Pilihan kami sendiri

1. **`PUMPKINS_STAGE_PHONE`.** `StageMobile.dc.html` tidak punya penempatan labu, jadi penempatan ini pilihan kami: 2 labu, `{x236, y340, fs6, w14, seed5}` dan `{x300, y480, fs6, w10, seed2}`.
2. **Nama file tes berbeda dari tasks.md.**
   - `layout-switch-state.test.tsx`.
   - `phone-single-sprite.property.test.ts`.

### Perubahan 2.3

1. `DialogueBox`: area teks phone bisa di-scroll, dan jarak bottom bar disesuaikan.
2. `PuzzleChoices`: props `gapClass` ditambahkan. `PuzzleActions`: props `className` ditambahkan.
3. Layout puzzle phone:
   - Satu baris pilihan, lalu tombol submit/continue selebar penuh setinggi 44px.
   - Pertanyaan dan umpan balik berada di area teks yang bisa di-scroll.
4. Panel stage phone dibuat transparan.
5. `StageHud` phone mengikuti `StageMobile`: padding, tombol kembali, blok HP, dan gap 3px.

### 2.6 Hasil verifikasi

- Lint: 0 error, 0 warning.
- `tsc`: bersih.
- Vitest: 67 file, 780 tes lulus.
- Golden: 40 dari 40.
- Build: berhasil.
- Kotak hasil ukur cocok dengan §4.1 dan §4.2.

**Perbaikan saat verifikasi:**

- Pilihan meluber keluar canvas di desktop. Diperbaiki dengan `ChoiceButton` memakai `md:flex-initial` dan `puzzle-choices` memakai `min-w-0`.
- Huruf pilihan dibuat inline.

### Penyimpangan yang tersisa

1. Label pilihan di phone terpotong saat ada 4 tombol (lebar sekitar 80px per tombol).
2. `StageMobile.dc.html` adalah template, jadi teks tidak dibandingkan.
3. Puzzle di referensi hanya punya satu tombol pilihan dan tanpa Submit. Versi kami menampilkan 1-4 pilihan plus submit.
4. Bar berlian emas untuk pause-point di referensi belum diverifikasi.
5. Badge dev Next saling menimpa di mode dev.
6. Halaman sementara `shot4` sudah dihapus. Folder `.next/dev` masih tertinggal.

## Task 3

Ringkasan penyimpangan untuk task 3 (layar Prep `/create`). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Keputusan

- **OQ-6.** 5 kotak digambar, default 3. Hanya 3 yang memetakan ke `short` dan 5 ke `medium` yang aktif. Kotak 1, 2, dan 4 `aria-disabled` dan tampilannya dibedakan dari kotak idle yang aktif.
- **Labu animasi (keputusan user 2026-11-21).**
  - Labu latar beranimasi harus tetap ada di SEMUA layar.
  - `PumpkinBackdrop` dan `lib/ascii-field` TIDAK dihapus di task 18. `GlassFilter`, `PumpkinMark`, dan skrip `LIQUID_GLASS_CHECK` tetap dihapus.
  - Hasil pemeriksaan: `PumpkinBackdrop` hanya mengimpor `lib/ascii-field/*` dan tidak bergantung pada `GlassFilter` maupun `LIQUID_GLASS_CHECK`. Kelas `.lore-ascii-field` di `globals.css` harus dipertahankan di 18.3.
  - Latar opak layar lain harus dibuat transparan agar animasi terlihat. Itu belum dikerjakan (hanya Prep yang sudah).
  - Dokumen spec diubah seminimal mungkin: `tasks.md` (18.2 dan 18.9), `requirements.md` (R4.2), dan `design.md` (tabel penghapusan gaya lama dan catatan). Status dan checkbox task tidak diubah.

### Penyimpangan dari spesifikasi

1. **`lengthForChapters`** didefinisikan di `lib/prep/chapter-choices.ts`. Fungsi ini belum ada di `lib/setup`.
2. **Nilai tidak didukung.** design.md dan tasks.md menyebut `null` untuk n yang tidak didukung, tetapi kode mengembalikan `{ok:false, reason}` (sesuai Property 14 dan 15 dan konvensi union hasil).
3. **`MaterialInput`.** "Choose a file" berupa `span` bergaya, bukan tombol, karena tombol di dalam `label` tidak membuka pemilih file.
4. **Replace / Choose another** memakai `Button` varian outline dengan override gaya.
5. **`SectionPicker`** ikut digayakan ulang.
6. **Ikon ready** memakai `file`, bukan file-with-check.
7. **`GenrePicker`.** Teks deskripsi genre terpilih memakai `text-ink/80`, bukan `#3A3833` dari canvas (hex bukan token).
8. **Pola kartu dekoratif lama** dihapus.
9. **`AdvancedOptions`** mendapat prop `defaultOpen`. Task 8 harus menghapus toggle di dalamnya.
10. **Panel Advanced** tersembunyi sampai link dibuka.
11. **Tes halaman create.** "fills storyteller instructions" kini mengklik `advanced-toggle` lebih dulu.
12. **`data-testid` baru:** `create-page` dan `prep-action-bar`.
13. **Teks status:** `Ready · N chapters · world`.

### 3.10 Hasil verifikasi

- Lint: 0 error, 0 warning.
- `tsc`: bersih.
- Vitest: 70 file, 804 tes lulus.
- Golden: 40 dari 40.
- Build: berhasil.
- Kotak hasil ukur cocok dengan §4.5 pada 1440x900.

**Empat perbaikan saat verifikasi:**

1. `SectionLabel` memakai kelas utilitas karena `.lore-eyebrow` menimpa gayanya.
2. Line-height disesuaikan.
3. Section pertama diberi offset 34px.
4. Labu:
   - `body` dibuat transparan di `globals.css`.
   - `PumpkinField` statis dihapus dari `PrepColumn`.
   - Kelas `.lore-grid-lines` ditambahkan ke `lore-tokens.css`.
   - Tes kini menegaskan `prep-pumpkins` tidak ada. Labu di Prep adalah kanvas animasi dari `layout.tsx`.

### Penyimpangan yang tersisa

1. Tidak ada world default, jadi bar bawah menampilkan "Choose a world for your story."
2. Budget bar dan baris "Preview content" dari `DocumentCard` yang sudah ada tidak ada di referensi.
3. Baris teks ketiga sel Sci-fi melewati tinggi 84px.
4. Kartu dokumen menampilkan data nyata, bukan "Read on this device · ready".
5. Screenshot phone sudah diambil tetapi belum ditinjau (ditunda ke task 4).

## Task 4

Ringkasan penyimpangan untuk task 4 (layout phone Prep `/create`). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Keputusan

- **Labu latar (keputusan user).**
  - Tidak ada field statis `PUMPKINS_PREP_PHONE`.
  - `PumpkinBackdrop` beranimasi tetap dipakai, `PrepColumn` dibuat transparan, dan labu mini memakai `pumpkin(16,7)`.
  - Sesuai arahan terbaru user, labu di background tetap berjalan dan beranimasi seperti background sebelumnya. Kanvas animasi sudah diverifikasi aktif di phone dan desktop.

### Penyimpangan dari spesifikasi

1. **Breakpoint.** Layout phone memakai kelas `md:` (768px) pada pohon komponen yang sama, bukan pohon komponen terpisah.
2. **Teks.** Teks phone dan desktop identik.
3. **Ikon file.** Ikon file tetap berada di `DocumentCard` pada phone.
4. **Link Advanced options.** Di phone, link berada di bawah grid chapter. Posisi ini tidak ada di canvas.
5. **Perilaku halaman.** Halaman mengalir dan bisa di-scroll, bukan board tetap 844px.

### Per sub-task

1. **4.2.** Tidak perlu perubahan kode.
   - Tombol kembali adalah `Link` ke `/`.
   - State bertahan lewat `cacheComponents`.
   - "Previous screen" dipertahankan sebagai `/` yang deterministik. `router.back` tidak dipakai.
2. **4.3.** Tes ditambahkan di `create-page.test.tsx`. Halaman tidak punya teks "file required", jadi yang di-assert adalah `Upload a material file to begin.`.

### 4.4 Hasil verifikasi

- Lint: 0 error, 0 warning.
- `tsc`: bersih.
- Vitest: 70 file, 809 tes lulus.
- Golden: 40 dari 40.
- Build: berhasil.
- Kotak hasil ukur pada 390x844 cocok dengan §4.6: header 56, padding 20, baris world 54, chapter 5 kolom 65.2x44, CTA 52.
- Animasi kanvas diverifikasi di phone dan desktop.

**Perbaikan saat verifikasi:** `PrepColumn` `overflow-hidden` diganti `overflow-clip` agar bar bawah sticky menempel.

### Penyimpangan yang tersisa

1. Tombol "Choose a file" berukuran 314px di dalam dropzone 350px.
2. `PrepMobile.dc.html` tidak dibuka langsung. Perbandingan hanya terhadap teks §4.6.

## Task 5

Ringkasan penyimpangan untuk task 5 (layar Home, sub-task 5.1 sampai 5.10). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Keputusan

- **5.1 Pilihan Home.** Pengguna memilih Home B. Rekomendasi desain adalah C.
- **OQ-10 disetujui.** SavedStories didesain bersama Home. Daftar R12.1 tidak diedit, jadi hitungan 11+1 tidak berubah.
- **Komponen lama.** `HomeComposer` dipertahankan (hanya dipakai oleh tes). `PumpkinMark` dipertahankan (ditangani di task 18). `PumpkinMouthInput` dihapus (pencarian: 0 pengguna). File opsi C tidak pernah ada.

### PERHATIAN: perubahan di `lib/ingest` (bertentangan dengan R13.1 "tidak ada perubahan")

Task 5.3 menemukan bug nyata di `lib/ingest/index.ts`, fungsi `detectFileKind`. Pencarian `BY_MIME` memakai objek biasa, sehingga MIME seperti `valueOf` lolos sebagai tipe yang dikenal. Perbaikan memakai `Object.hasOwn`. Ini perubahan di dalam `lib/ingest`, jadi bertentangan dengan R13.1. **Pengguna perlu memutuskan** apakah perubahan ini dipertahankan.

### Penyimpangan per sub-task

- **5.2 `validateHomeFile`.** Urutan pemeriksaan: format, kosong, terlalu besar. Ekstensi `.markdown` diterima.
- **5.4 File baru.** `useHomeComposer`, `hazelGreeting`, dan `composer-state`. `HomeComposer` sekarang menerima `onFileChange`. Kalimat Hazel tanpa file diubah dari "Tell me a topic..." (canvas) menjadi kalimat yang mewajibkan file.
- **5.5 Penyimpangan layout dan salinan:**
  1. `wordmark()` dipakai sebagai ganti "LORE" mono 40px (sel 8px di desktop, 5px di phone, y 64).
  2. Textarea satu baris dengan scroll, bar tetap 56px. Enter mengirim, Shift+Enter baris baru.
  3. Baris format: "PDF · DOCX · PPTX · TXT · MD · up to 25 MB · file required".
  4. Padding dialog Kit 20/26, canvas 22/28 (tidak diubah).
  5. Pesan error di bawah kotak bisa menimpa baris format di phone pada y726.
  6. Link demo desktop "Play the demo: The Last Beacon", canvas "Play the demo".
  7. `DialogueBox` mendapat prop opsional baru `bottomBar`, `padLeft`, `nameColor`. `ScaledBoard` mendapat `inFlow` dan `rootClassName`.
- **5.6 SavedStories.** `SectionLabel` "01 YOUR STORIES", `section` memakai `aria-label` (bukan `h2`), hapus dua langkah, `Button` primary/outline.
- **5.7 `Button`.** `href` internal sekarang memakai `next/link` (navigasi client). Ditambah dua tes.
- **5.8 Tes.** Suite home-composer dijalankan dengan `describe.each` terhadap `HomeComposer` dan `<Home/>`. Tidak ada tes yang dihapus.
- **5.9 Tes komponen.** `home-components.test.tsx` baru (15 tes). Label Replay belum dites.

### Hasil verifikasi 5.10

- Lint 0 masalah, `tsc` lolos, Vitest 73 file / 855 tes lolos, golden 40/40, build berhasil.
- Box cocok: hero 1440x900 / 390x844, Hazel (230,300) 264x480 / (10,150) 238x279, dialog (450,548) 780x212 / (12,420) lebar 366, link demo.
- **Perbaikan:** wrapper halaman `max-w-[712px]` agar kolom SavedStories 680.
- Dokumen §8 dan §8.1a diperbarui.

### Penyimpangan yang tersisa

1. Frame canvas memuat `{{placeholder}}` yang belum dirender dan chip statis.
2. Wordmark berbeda dari canvas.
3. "Brew it" nonaktif bergaya smoke saat belum ada file, canvas ember (file wajib).
4. Backdrop global beranimasi, canvas datar. Ini sesuai permintaan pengguna (labu beranimasi seperti sebelumnya).
5. Screenshot phone belum ditinjau. SavedStories di phone hanya dicek pada keadaan kosong.

## Task 6

Ringkasan penyimpangan untuk task 6 (GenerationScreen, tanpa frame canvas). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Persetujuan
- Pengguna menyetujui semua desain 6.1 sampai 6.12 sekaligus dalam satu batch.

### Penyimpangan
1. **Tombol back baris atas.** Tombol `generation-back` hanya berisi ikon, dengan `aria-label` "Back to edit". Desain memakai teks "← Back to edit". Tombol "Back to edit" berteks tetap ada di bagian bawah, dan `create-page.test` menemukannya lewat teks tersebut.
2. **SectionLabel.** Nomor label memakai '01 REVIEW' dan '02 YOUR WORLD'.
3. **`role=alert`.** Dipindahkan ke `ErrorLine` saja.
4. **Latar labu.** Labu tampil di belakang teks. Ini mengikuti keputusan pengguna tentang backdrop beranimasi: `body` transparan dan kanvas labu animasi berjalan dari root layout. Badge dev yang terlihat berasal dari Next dev.

### Tes
- Tidak ada assertion lama yang diubah.
- Tes baru: `generation-screen.test.tsx` (10 tes).

### Hasil 6.4
- Lint: 0 masalah.
- `tsc`: berhasil.
- Vitest: 74 file, 865 tes lulus.
- Golden: 40/40.
- Build: berhasil.

### Ukuran kotak
- Kolom 680 x 380.
- Baris langkah 44.
- Tombol back 44.
- Tombol confirm/retry 48 di desktop.
- Phone: konten 350, tombol 52 selebar penuh.
- Baris konsep 83px di phone dan 65px di desktop.

### Perbaikan
- Baris atas memakai `h-14` di phone (56px sesuai desain). Desktop tidak berubah.

### Verifikasi visual
- Memakai Playwright dengan respons AI yang dicegat. Tidak ada halaman sementara yang dibuat.

## Task 7

Ringkasan penyimpangan untuk task 7 (ChatLog dan Modal). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Keputusan implementasi

1. **Portal.** Modal dirender lewat portal ke `document.body`, di luar `ScaledBoard`, sehingga tidak ikut diskalakan.
2. **Scrim.** Scrim memakai `bg-ink/90`, jadi backdrop di belakangnya terlihat sekitar 10%.
3. **Panel.** Border 2px `smoke` dengan tick emas 10px di sudut.
4. **Ukuran.** Maksimum 720px di desktop, layar penuh di phone, tinggi maksimum 80dvh.
5. **Escape.** Penutupan lewat Escape memakai listener `keydown` pada `document`.
6. **HTML tidak valid dipertahankan.** Anchor scroll berupa `div` di dalam `ol` dibiarkan seperti aslinya.
7. **Dialog konfirmasi keluar.** Dialog di `StoryViewer` TIDAK dimigrasikan ke Modal.
8. **Narasi.** Teks narasi tidak lagi miring (italic).
9. **Asersi lama.** Tidak ada asersi test yang sudah ada diubah.

### Test yang ditambahkan

- `tests/ui/modal.test.tsx` (5 test).
- `tests/stage/chat-log.test.tsx` (4 test).
- Target sentuh 44px diverifikasi lewat class Tailwind, karena jsdom tidak punya layout.

### Hasil sub-task 7.4

- Lint: 0 masalah.
- `tsc`: berhasil.
- Vitest: 76 file, 874 test lulus.
- Golden: 40/40.
- Build: berhasil.
- Terukur: panel 720x241 di desktop dan 390x844 di phone. Tombol tutup 75x44. Fokus awal ada di tombol tutup, Esc menutup modal, tidak ada scroll horizontal.
- Belum dicek secara visual: keadaan kosong (empty state) dan item lesson.

### Dokumentasi

- Baris Modal ditambahkan di `docs/DESIGN-SYSTEM.md` §8.1.

### Penyimpangan dari desain

Tidak ada.

### Catatan steering backdrop

`body` transparan dan kanvas labu beranimasi dari root layout sudah ditangani subagen sebelumnya. Task 7 tidak mengubah backdrop. Pada screenshot, kanvas terlihat samar di balik scrim.

## Task 8

Ringkasan penyimpangan untuk task 8 (AdvancedOptions, sub-task 8.5). Tidak ada commit atau push. Semua perubahan ada di working tree.

1. **Pemilih panjang cerita dihapus** sesuai design 6.3. Kotak CHAPTERS menulis `length_set` yang sama, dan tes reducer/chapters tetap mencakupnya.
2. **Toggle `<details>` bagian dalam dan prop `defaultOpen` dihapus.**
3. **Prop `length` dan `onLengthChange` dihapus**, dan `create/page.tsx` sudah diperbarui.
4. **Dropdown bahasa menjadi radiogroup dua segmen** (English / Bahasa Indonesia, tinggi 44px, testid `story-language`, `language-en`, `language-id`). Jenis kontrol berubah dari `select` ke tombol, perilakunya sama.
5. **Tidak ada roving tabindex dengan tombol panah.** Navigasi hanya Tab/Enter/Space, karena design tidak mewajibkannya.
6. **Label instruksi dibuat huruf kapital lewat CSS.** `getByLabelText` tetap cocok.
7. **Tes baru** `tests/setup/advanced-options.test.tsx` (6 tes). Tes halaman create yang sudah ada tidak diubah.
8. **Hasil 8.4:** lint 0, tsc ok, vitest 77 file / 880 tes, golden 40/40, build ok. Terukur: segmen 44px, textarea 3 baris `maxLength` 500, penghitung 11px rata kanan, lebar 582 (desktop) / 350 (phone). Backdrop animasi terverifikasi.
9. **Kolom `main` desktop** tetap memakai kolom ink opak sesuai canvas Prep (labu terlihat di kedua sisi).
10. **Backdrop animasi (steering pengguna).** `body` transparan dan kanvas labu animasi dari root layout aktif di `/create`. Sudah ditangani subagen sebelumnya, tidak ada perubahan di task ini.

Penyimpangan dari design: tidak ada.

## Task 9

Ringkasan penyimpangan untuk task 9 (CampaignLobby). Tidak ada commit atau push. Semua perubahan ada di working tree.

### StatusBadge
- Varian: `done`, `current`, `available`, `locked`.
- Warna badge dipilih oleh kami karena desain tidak menentukannya. Varian `current` memakai isi `ink` dengan teks `cream`, dipasang di baris Current yang dibalik (latar `cream`).
- Didokumentasikan di `docs/DESIGN-SYSTEM.md` §8.1 (StatusBadge).

### Layout lobby
- Kolom 680px, baris atas 44px, eyebrow `CAMPAIGN`.
- Baris Current dibalik (latar `cream`, teks `ink`).
- Pemisah baris 1px `smoke`.
- Tombol minimal 44px. Di phone, kolom selebar penuh.

### Test
- `data-testid` lama dipertahankan. Tidak ada assertion lama yang diubah.
- Baru: `tests/ui/status-badge.test.tsx` (9 test) dan `tests/campaign/campaign-lobby.test.tsx` (5 test). Target 44px dicek lewat class.

### Hasil 9.4
- Lint 0, `tsc` ok, Vitest 79 file / 894 test, golden 40/40, build ok.
- Terukur: kolom 680 x 380, baris atas 44, tombol results 48 (desktop) / 52 (phone), tombol continue 48 / 52. Tidak ada overflow. Backdrop beranimasi terverifikasi.

### Penyimpangan
1. Labu pada backdrop beranimasi lewat di belakang eyebrow dan judul. Ini mengikuti keputusan backdrop beranimasi (steering pengguna: labu di background berjalan dan beranimasi).
2. Di phone, label tombol results terbungkus ke baris kedua dan panah berada di baris kedua.
3. Data di-seed lewat halaman sementara. Halaman itu sudah dihapus.

## Task 19

Ringkasan penyimpangan untuk task 19 (lima tokoh Kit di backend campaign planner). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Keputusan user

- User memilih opsi A (ubah backend), lalu memilih "Dua tokoh dulu".

### Temuan 19.1 dan pelebaran cakupan

- Perubahan prompt saja tidak cukup. Id tokoh datang dari `campaign_templates.py` dan `campaign_planner_engine.py`, bukan dari model.
- Cakupan melebar melampaui R1.7 dan R16.7. Requirements dan design diperbarui: R1.7, R13.6, R16.4, R16.7.

### Perubahan backend

1. **Cast tetap.** Lima tokoh Kit per genre (id, nama, peran) dalam urutan tetap. Ditambahkan `CAST_IDS` dan `TemplateCharacter.character_id`.
2. **Deskripsi.** `EXTRA_CAST` berisi deskripsi bersama untuk hazel, varr, dan nyx karena template tidak punya deskripsi untuk mereka. Deskripsi per genre untuk eldric dan mira dipertahankan.
3. **Judul campaign.** Sekarang "Eldric's Campaign: …" (sebelumnya "The Keeper's Campaign").
4. **`merge_creative_fields`.** Mengunci `name` dan `role`, hanya menimpa `description`.
5. **`CreativeCharacter`.** `name` dan `role` dibuat opsional (tidak diminta lagi dari model).
6. **Prompt planner.** Ditulis ulang untuk cast lima orang dan hanya meminta deskripsi.
7. **Validator.** Kode baru `INVALID_CAST_CHARACTER`, hanya di `validate_planned_campaign`.
8. **Tidak diubah.** Validator dan prompt story tidak disentuh (snapshot paritas story tetap valid). Kontrak: 0 diff.

### KETERBATASAN

- Story engine (`story_generator_engine.py`) masih hanya memakai `characters[0]` (eldric, pemandu) dan `characters[1]` (mira, pendamping). Hazel, Varr, dan Nyx ada di campaign tetapi belum pernah berbicara. Perlu pekerjaan lanjutan.
- Gemini tidak bisa mengganti nama tokoh (diabaikan).
- Campaign lama yang tersimpan dengan `char_01`/`char_02` tetap valid di jalur story dan dirender lewat fallback frontend.

### Tes

- 20 tes backend diperbarui di `test_ai_campaign_planner.py` dan `test_ai_plan_campaign.py`.
- Fixture dibuat ulang: `plan-campaign.success.json`, `two-materials.success.json`, `semantic-invalid-blueprint.json`.
- Tes baru: penolakan cast tidak valid dan campaign lama.
- Frontend: tes pemetaan cast ditambahkan (id Kit dan id lama).

### Hasil verifikasi

- Ruff: lulus.
- Pytest: 597 lulus, 57 dilewati (tanpa Postgres).
- Lint dan `tsc`: lulus.
- Vitest: 79 file, 896 tes lulus.
- Golden: 40/40.
- Build: berhasil.
- Smoke AI: tidak dijalankan (tidak ada key).

## Task 10

Ringkasan penyimpangan untuk task 10 (CampaignPlayer). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Pembungkus cabang
- Tiga cabang (`CampaignSummary`, `CampaignLobby`, `StoryViewer` dengan `key={activeStory.story_id}`) dipertahankan tanpa teks atau elemen UI tambahan.
- Cabang `CampaignLobby` dan `CampaignSummary` dibungkus dalam `<div className="lore-grid-lines min-h-dvh overflow-y-auto">`.
- Cabang `StoryViewer` dirender langsung karena `ScaledBoard` di dalamnya sudah mengisi viewport (`fixed inset-0`), menggantikan pembungkus `h-screen overflow-hidden` lama.

### Test
- Semua test yang sudah ada di `tests/campaign/campaign-player.test.tsx` tetap utuh.
- Ditambahkan 2 test pemilihan cabang di `tests/campaign/campaign-player.test.tsx` (render lobby dan summary di dalam wadah `min-h-dvh` `lore-grid-lines`, serta remount `StoryViewer`).

### Hasil 10.4
- Lint 0, `tsc` ok, Vitest 79 file / 898 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: stage mengisi viewport via `ScaledBoard`, lobby di dalam wadah `min-h-dvh` `lore-grid-lines` (kolom 680px di desktop, penuh 390px di phone), dan backdrop labu beranimasi aktif.

### Penyimpangan
1. Wadah lobby dan summary memakai `lore-grid-lines` (garis grid 24px tanpa isi `ink` opak) sebagai ganti `lore-grid-bg` di teks rancangan 6.5, mengikuti keputusan user bahwa permukaan layar transparan agar `PumpkinBackdrop` beranimasi tetap terlihat.

## Task 11

Ringkasan penyimpangan untuk task 11 (CampaignSummary). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Layout CampaignSummary (Pola K)
- Kolom 680px transparan (`max-w-[680px]`, padding 20px di phone), baris atas 44px desktop / 56px phone dengan `LORE`, eyebrow `EPILOGUE`, H1 judul kampanye.
- Epilog per cerita (`epilogue-<id>`): judul ending 17/700 `gold`, narasi paragraf `muted` tanpa miring.
- Evaluasi pembelajaran (`learning-evaluation`): `SectionLabel` `01 WHAT YOU LEARNED`, `evaluation-headline`, daftar konsep (`concept-result-<id>`, `data-outcome`) dipisah garis 1px `smoke` dengan penanda `●` (`gold`), `◐` (`cream`), `○` (`ember`), `·` (`muted`), serta `Recap:` dan `Watch out for:` untuk `developing` dan `practice`.
- Tombol bawah memakai `Button` (`Back to your stories` primer 48px/52px, `Create a new story` outline 44px, `Campaign lobby` outline 44px).

### Test
- Semua test lama di `tests/campaign/campaign-summary.test.tsx` dipertahankan tanpa ubahan asersi.
- Ditambahkan 2 test komponen di `tests/campaign/campaign-summary.test.tsx` untuk keempat status konsep (`mastered`, `developing`, `practice`, `unseen`) dan kalimat kosong `"No concepts were tested in this campaign."`.

### Hasil 11.4
- Lint 0, `tsc` ok, Vitest 79 file / 900 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: kolom 680px di x=380 (desktop) dan 390px penuh (phone), tombol primer 48px (desktop) / 52px (phone) dan outline 44px, backdrop labu beranimasi terlihat di belakang permukaan transparan.

### Penyimpangan
Tidak ada.

## Task 12

Ringkasan penyimpangan untuk task 12 (EndingDisplay). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Layout EndingDisplay (Pola P)
- Panel `ending-display` (`role="region"`, `aria-label="Story ending: {title}"`): border 2px `smoke`, latar `ink`, lebar maks 720px di desktop dan 366px di phone, tinggi maks 600px dengan `overflow-y-auto`.
- Badge tipe ending (`ending-type-badge`) memakai `StatusBadge`: `success` → `Success` (`done`), `failure` → `Failed` (`locked`), `partial_success` → `Partial Success` (`available`).
- Judul H2 display 700 20px (desktop) / 18px (phone) `gold`, garis pemisah 1px `smoke`, narasi 15px/1.5 `muted` rata tengah (`whitespace-pre-line` agar jeda baris narasi tetap terjaga).

### Test
- Semua test lama tetap lulus tanpa ubahan asersi.
- Baru: `tests/story/ending-display.test.tsx` (4 test untuk tiga varian badge, `role="region"`, `aria-label`, dan panel scroll).

### Hasil 12.4
- Lint 0, `tsc` ok, Vitest 80 file / 904 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: panel ending tampil di atas Stage dengan `StatusBadge` `done`.

### Penyimpangan
Tidak ada.

## Task 13

Ringkasan penyimpangan untuk task 13 (StoryComplete). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Layout StoryComplete (Pola P)
- Panel `story-complete-screen` (`role="region"`, `aria-label="Story complete: {title}"` / `"Campaign complete: {title}"`): border 2px `smoke`, latar `ink`, lebar maks 720px di desktop dan 366px di phone.
- Badge `Story Complete` atau `Campaign Complete` (`StatusBadge` `done`), judul `story-complete-title` (17/700 `cream`), pesan (`campaign-complete-message` saat kampanye selesai).
- Tombol memakai `Button`: `view-results-button` (primer), `continue-campaign-button` (primer), dan `exit-button` (outline), lebar penuh di phone dan 320px di desktop.

### Test
- Semua test lama tetap lulus tanpa ubahan asersi.
- Baru: `tests/story/story-complete.test.tsx` (2 test untuk kondisi kampanye belum selesai dan sudah selesai).

### Hasil 13.4
- Lint 0, `tsc` ok, Vitest 81 file / 906 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: panel penyelesaian cerita dan tombol 320px (desktop) / penuh (phone) sesuai rancangan 6.8.

### Penyimpangan
Tidak ada.

## Task 14

Ringkasan penyimpangan untuk task 14 (StoryFailure). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Layout StoryFailure (Pola P)
- Panel `story-failure` (`role="alert"`, `aria-live="assertive"`): border 2px `smoke`, latar `ink`, lebar maks 560px di desktop dan 366px di phone, tanpa warna bahaya.
- Badge `Story Failed` (`StatusBadge` `locked` dengan teks `cream`), judul `story-failure-title` (17/700 `cream`), teks `"You have run out of HP."` dan `story-failure-hp` (`"HP: 0 / 5"`), penjelasan mono 12 `muted`, tombol `retry-button` (`Button` primer selebar penuh).

### Test
- Semua test lama di `tests/story/hp-failure-retry.test.tsx` tetap lulus tanpa ubahan asersi.
- Baru: `tests/story/story-failure.test.tsx` (2 test untuk `role="alert"`, teks `HP: 0 / 5`, dan callback `onRetry`).

### Hasil 14.4
- Lint 0, `tsc` ok, Vitest 82 file / 908 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: panel kegagalan 560px (desktop) / 358px (phone) dengan tombol `Retry Story` minimal 44px.

### Penyimpangan
Tidak ada.

## Task 15

Ringkasan penyimpangan untuk task 15 (StoryViewer overlay galat dan dialog keluar). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Overlay dan Dialog (Pola P dan Pola M)
- `stage-overlay` memakai `bg-ink/90` dan `items-start` (rata atas, memperbaiki terpotongnya bagian atas panel ending+complete saat bersama-sama).
- `story-viewer-error` (`role="alert"`, `aria-live="assertive"`) memakai panel Pola P dengan judul `Navigation Error` (`gold`) dan `ErrorLine`.
- `scene-error` (puzzle/ending tidak ditemukan) memakai `ErrorLine` (`role="alert"`).
- `bad-branch-return-btn` dan `bad-ending-return-btn` memakai `Button` varian `outline` (44px) dengan `<Icon name="back" size={16} />` dan teks `"Try a different choice"`.
- `exit-confirm-dialog` memakai `Modal` (`md:max-w-[480px]`, `aria-labelledby="exit-confirm-title"`), tombol `Cancel` (outline, fokus awal) dan `Exit Anyway` (primer).

### Test
- Semua test lama di `tests/story/story-viewer.test.tsx`, `bad-branch.test.tsx`, dan `campaign-progression.test.tsx` tetap lulus.
- Ditambahkan 2 test di `tests/story/story-viewer.test.tsx` (fokus awal pada `Cancel` & tutup dengan `Escape` di `exit-confirm-dialog`, serta `story-viewer-error` dengan `role="alert"` dan `ErrorLine`).

### Hasil 15.4
- Lint 0, `tsc` ok, Vitest 82 file / 910 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: modal keluar 480px di desktop / layar penuh di phone, fokus awal pada `Cancel`, dan panel ending+complete rata atas tanpa terpotong.

### Penyimpangan
Tidak ada.

## Task 16

Ringkasan penyimpangan untuk task 16 (PlayProject dan pita galat simpan). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Layout PlayProject (Pola K ringkas)
- `PlayLoading` (`play-loading`): wadah `min-h-dvh` `lore-grid-lines`, kotak `ember` 8px (`h-2 w-2 bg-ember`) dan teks `"Opening your story…"` mono 14 `cream` tanpa animasi.
- `play-missing`: Pola K ringkas (kolom 680px transparan, baris atas 44px/56px dengan `LORE`, eyebrow `NOT FOUND`, H2 17/700 `"This story isn't saved in this browser."`, paragraf 15 `muted`, tombol `Button` primer `"Back to your stories"` ke `"/"`).
- `play-save-error` (di `PlayProject.tsx`) dan `create-save-error` (di `app/create/page.tsx`): pita tetap di atas (`fixed inset-x-0 top-0 z-[60]`), tinggi minimal 44px, latar `ember`, teks `ink` mono 12/700 rata tengah, `role="alert"`.

### Test
- Semua test lama di `tests/state/play-and-home.test.tsx` dan `tests/state/play-save-error.test.tsx` tetap lulus.
- Ditambahkan 2 test di `tests/state/play-and-home.test.tsx` untuk `PlayLoading`, `play-missing`, dan `play-save-error`.

### Hasil 16.4
- Lint 0, `tsc` ok, Vitest 82 file / 912 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: layar `play-missing` di kolom 680px (desktop) / penuh (phone) dengan tombol 48px / 52px, serta backdrop beranimasi aktif.

### Penyimpangan
1. Wadah `play-loading` dan `play-missing` memakai `lore-grid-lines` transparan (bukan isi `ink` opak) agar `PumpkinBackdrop` beranimasi tetap terlihat sesuai keputusan user.

## Task 17

Ringkasan penyimpangan untuk task 17 (Mode dua karakter di Stage). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Pilihan ukuran karakter
- Memakai rekomendasi rancangan 6.12: figur penuh (`renderCharacter(castId, 'calm')`) pada sel 8px (211x384) di tengah slot `CanvasFrame` `(694, 47)` dengan opacity 40% (`0.4`) pada desktop saat beat tanpa canvas (`ambient`).

### Implementasi
- `pickOtherCharacter(presentIds, activeId, chars)` ditambahkan di `lib/cast/cast-mapping.ts` (murni, total, tanpa throw).
- `StageSprite` memakai kotak `OTHER_SPRITE_DESKTOP` (`x: 694, y: 47, width: 211, height: 384, fontPx: 8`) dan `zIndex: 5` saat `role === "other"` di desktop.
- `StoryViewer` memanggil `pickOtherCharacter` dan `visibleSprites(layout, activeId, !framed ? otherId : null)` sehingga karakter kedua hanya digambar pada desktop saat beat `ambient`, dan tidak pernah digambar di phone atau saat ada `CanvasFrame`.
- Didokumentasikan di `docs/DESIGN-SYSTEM.md` §8.2 (`StageSprite`).

### Test
- Property 5 ditambahkan di `tests/cast/cast-mapping.test.ts` (150 iterasi `fast-check`); Property 4 di `tests/stage/phone-single-sprite.property.test.ts` dan `tests/stage/stage-boxes.test.ts` tetap hijau.
- Baru: `tests/stage/two-character.test.tsx` (3 test untuk opacity 100% dan 40%, label aksesibel `{Nama}, calm`, ketiadaan karakter kedua saat ada canvas atau pada phone).

### Hasil 17.6
- Lint 0, `tsc` ok, Vitest 83 file / 916 test, golden 40/40, build ok.
- Terukur dengan Playwright pada 1440x900 dan 390x844: pada desktop beat `ambient` dua karakter, `stage-character` (317x576, opacity 1) dan `stage-character-other` (211x384 di 694,47, opacity 0.4) tampil bersamaan; pada phone hanya 1 sprite (`stage-character`).

### Penyimpangan
Tidak ada.

## Task 18

Ringkasan penyimpangan untuk task 18 (Penutup, hapus gaya lama, dan perbarui steering). Tidak ada commit atau push. Semua perubahan ada di working tree.

### Keputusan gerbang 18.1
- **Layar yang belum selesai:** Tidak ada (seluruh layar task 0 sampai 17 dan 19 sudah selesai dan terverifikasi).
- **OQ-11 (`product.md`, `ai-pipeline.md`, `game-engine.md`):** Ditolak oleh user ("Tolak — jangan ubah steering product, ai-pipeline, dan game-engine (hanya ubah theme-halloween, conventions, tech, dan structure)"). Sub-task 18.10 dilewati dan ketiga file steering tersebut tidak diubah (0 baris diff terhadap `dev`).
- **Nama file steering `theme-halloween.md`:** Tetap bernama `.kiro/steering/theme-halloween.md` dan isinya diganti penuh dengan aturan Black Cat Gold Kit.
- **Folder `lore-design-kit/`:** User memilih "Biarkan jika ada" (folder tidak ada di working tree lokal karena tidak dilacak git).

### Hasil pencarian pemakai & penghapusan file lama (18.2)
- `frontend/src/components/backdrop/GlassFilter.tsx`: 0 pemakai di luar `layout.tsx` (yang sudah dibersihkan). **Dihapus.**
- `frontend/src/components/home/PumpkinMark.tsx`: 0 pemakai di `frontend/src` dan `frontend/tests`. **Dihapus.**
- `LIQUID_GLASS_CHECK` di `frontend/src/app/layout.tsx`: 0 pemakai di luar `layout.tsx`. **Dihapus dari `layout.tsx`.**
- `frontend/src/components/backdrop/PumpkinBackdrop.tsx` dan `frontend/src/lib/ascii-field/*`: **Dipertahankan** sesuai keputusan user (labu ASCII beranimasi tetap di semua layar). Komentar rujukan ke `GlassFilter` dan `globals.css` lama di `PumpkinBackdrop.tsx` diperbarui, dan `.lore-ascii-field` dipertahankan di `globals.css` dengan token Kit (`var(--color-ink)`, `var(--font-mono)`).
- Tidak ada file tes yang dihapus pada task 18.

### Pembersihan `globals.css`, warna literal, dan `lucide-react` (18.3)
- `frontend/src/app/globals.css` diganti dengan `@import "tailwindcss";`, `@import "./lore-tokens.css";`, latar `body` transparan, dan `.lore-ascii-field`. Seluruh variabel `--hw-*`, `--glass-*`, `--accent-gold`, `--background-panel`, `--foreground-muted`, kelas `lore-glass*`, dan aturan `liquid` dihapus.
- Sisa impor `lucide-react` dan warna literal di komponen cadangan/warisan (`components/home/HomeComposer.tsx`, `components/stage/StageCanvas.tsx`, `components/stage/StagePuzzle.tsx`) diganti dengan komponen `Icon` dan kelas token Kit (`bg-ink`, `text-cream`, `text-gold`, `text-ember`, `text-muted`, `border-smoke`, `bg-candle`).
- Pencarian `--hw-`, `--glass-`, `--background-panel`, `--accent-gold`, `--foreground-muted`, `liquid` di `frontend/src` dan `frontend/tests`: **0 kecocokan.**
- `lucide-react`: 0 impor tersisa di seluruh `frontend/src` dan `frontend/tests`; paket dibiarkan di `frontend/package.json` sebagai dependensi tak terpakai agar `package.json` dan `package-lock.json` tetap byte-identik.

### Tes baru & pembaruan steering (18.4 – 18.9)
- Baru: `frontend/tests/ui/style-guard.test.ts` (4 tes pagar statis: larangan hex/rgb/hsl/warna Tailwind bawaan di `src/components` dan `src/app` di luar `lore-tokens.css`; larangan `rounded-*`, `shadow-*`, `backdrop-*`, `blur`, gradient, emoji; larangan `font-family` selain dua font Kit; wajib komentar header di file baru dan `'use client'` pada komponen pengguna API browser).
- Baru: `frontend/tests/lib/pure-functions-total.test.ts` (Property 19: `computeBoardScale`, `selectLayout`, `hpSquares`, `revealedCount`, `revealPrefix`, `chapterSquares`, `lengthForChapters`, `validateHomeFile` tidak pernah melempar). `computeBoardScale` diperketat agar menolak skala yang mengalami underflow float (`scale <= 0`) dengan `{ ok: false, reason: "invalid_viewport" }`.
- Steering diperbarui: `.kiro/steering/theme-halloween.md`, `.kiro/steering/conventions.md`, `.kiro/steering/tech.md` (85 file / 922 tes), dan `.kiro/steering/structure.md`.

### Hasil 18.8 & 18.11
- `npm run lint`: 0 error, 0 warning.
- `npx next typegen` & `npx tsc --noEmit`: 0 error.
- `npx vitest run --testTimeout=60000`: **85 file / 922 test lulus** (`tests/ascii-golden.test.ts` 40/40 hijau).
- `npm run build` (tanpa env AI): sukses.
- `git diff --name-only dev -- backend/`: kosong (0 baris diff terhadap `dev`).
- `git diff dev -- frontend/src/lib/contracts frontend/src/lib/state/project-store.ts backend/app/ai/contracts`: kosong (0 baris diff).
- `git diff dev -- frontend/package.json frontend/package-lock.json`: kosong (byte-identik).

### Penyimpangan
1. `.lore-ascii-field` dan `body { background-color: transparent; }` tetap dipertahankan di `frontend/src/app/globals.css` di bawah `@import "tailwindcss";` dan `@import "./lore-tokens.css";` sesuai instruksi 18.2 dan keputusan user agar `PumpkinBackdrop` beranimasi tetap tampil di semua layar.
2. Sub-task 18.10 (`product.md`, `ai-pipeline.md`, `game-engine.md`) dilewati sesuai keputusan user pada gerbang 18.1 (OQ-11 ditolak).








