# Requirements Document

## Introduction

Fitur ini mengganti seluruh tampilan web LORE ("interactive learning visual novel") dengan design kit "Black Cat Gold" yang berada di `lore-design-kit/lore-design-kit/` (belum dilacak git). Kit berisi spesifikasi `docs/DESIGN-SYSTEM.md` (sumber kebenaran, ukuran px tiap layar di §4), frame canvas `reference/canvas/*.dc.html`, token Tailwind 4 (`lore-tokens.css`), generator ASCII `lib/ascii/*`, komponen (`AsciiArt`, `PumpkinField`, `DialogueBox`, `ChoiceButton`, `CanvasFrame`, `PlayerBar`, `PumpkinMouthInput`), dan tes golden `ascii-golden.test.ts` (40 tes).

Lingkup hanya UI. Alur game, generasi AI, persistensi, kontrak AI (`StoryBlueprint`/`LessonVisual`), dan backend tidak berubah. Gaya lama (Halloween "Trick-or-Treat", liquid glass, rounded, blur, shadow, gradient, emoji, kartu) digantikan sepenuhnya oleh aturan kit, tanpa dicampur.

Pekerjaan dijalankan lewat alur Spec (requirements, design, tasks), satu layar per task, dimulai dari task 0 (pasang kit). Dokumen ini hanya requirements; tidak ada kode yang diubah.

### Keputusan yang sudah diambil

- Home memakai salah satu opsi A, B, atau C dari §4.7; dua opsi lain dihapus. Opsi mana yang dipilih belum diputuskan (lihat OQ-1).
- Aturan kit menggantikan gaya lama. Steering `theme-halloween` dan `conventions` diperbarui agar sesuai kit.
- `SceneBlueprint` dari kit (`lib/schemas/visual.ts`, `backend/app/schemas/visual.py`) tidak dipasang ke alur AI sekarang; dicatat di design sebagai pekerjaan lanjutan.
- `LessonVisual` tetap digambar seperti sekarang di dalam `CanvasFrame`; karakter Stage memakai `renderCharacter`/`renderBust`.
- Layar yang belum didesain kit disusun dari komponen dan token kit, ditandai "tanpa frame canvas", dan memerlukan persetujuan user di design.
- Git: mulai dari branch `dev`, buat branch `feat/redesign-black-cat-gold`. Tidak ada commit atau push tanpa permintaan user.

### Pertanyaan terbuka dan asumsi

- **OQ-1 (Home A/B/C):** Belum dipilih. Asumsi sementara: tidak ada. Diputuskan di design sebelum task Home dimulai. Hanya komponen opsi A (`PumpkinMouthInput`) yang sudah tersedia di kit; B dan C disusun dari `DialogueBox`, `wordmark()`, dan token.
- **OQ-2 (Zod 3 atau 4):** Belum dipilih. Steering `tech` menyebut Zod 3, tetapi working tree sudah memuat perubahan belum di-commit `frontend/package.json` (`zod` `^3.25.28` menjadi `^4.6.7`) dan `frontend/package-lock.json`. Kit mengimpor `zod` di `lib/schemas/visual.ts`. Asumsi default: tetap Zod 3 kecuali kit terbukti memerlukan Zod 4 (dicek di task 0). Perubahan `package.json` di luar keputusan ini tidak dilakukan, dan perubahan Zod yang sudah ada di working tree harus dikonfirmasi user (dipertahankan, dikembalikan, atau dipisah) sebelum task 0.
- **OQ-3 (layar tanpa desain kit):** Grilling dan estimasi kredit tidak ada di kode sekarang (pencarian `grill|credit|kredit` di `frontend/src` kosong; steering `product` menyebutnya fitur v2). Asumsi: keduanya tidak dibangun. Layar yang ada dan tidak didesain kit adalah Generating (`GenerationScreen`), log chat (`ChatLog`), mode dua karakter, `AdvancedOptions`, `SavedStories`, `CampaignLobby`, `CampaignPlayer`, `CampaignSummary`, `EndingDisplay`, `StoryComplete`, `StoryFailure`, dan `PlayProject`.
- **OQ-4 (frame Main):** `reference/canvas/Main.dc.html` bertitle "Story stage (desktop)" dan dianggap frame §4.1. `Cast.dc.html` adalah lembar cast (§6). Tidak ada frame desktop untuk Stage dengan dua karakter.
- **OQ-5 (file kit yang akan memengaruhi tes lama):** `frontend/tests/ascii-golden.test.ts` dan `fixtures/ascii-golden.json` ada di akar `tests/`, sedangkan tes repo dikelompokkan per domain. Asumsi: tes golden tetap di lokasi kit.

## Glossary

- **Kit**: Folder `lore-design-kit/lore-design-kit/` berisi spesifikasi, token, generator ASCII, komponen, dan frame canvas.
- **Design_System**: Dokumen `docs/DESIGN-SYSTEM.md` dari Kit; sumber kebenaran, mengalahkan kode bila berbeda.
- **Canvas_Frame_File**: File `reference/canvas/*.dc.html` (Cast, HomeA, HomeAMobile, HomeB, HomeBMobile, HomeC, HomeCMobile, Main, Prep, PrepMobile, StageMobile); atribut `style` inline adalah spesifikasi persis.
- **Token_CSS**: File `lore-tokens.css` (warna `ink`, `smoke`, `gold`, `ember`, `cream`, `muted`, `ink-soft`, `candle`, `candle-ink`, font `display` dan `mono`, gaya dasar).
- **ASCII_Generator**: Modul `lib/ascii/*` (`renderCharacter`, `renderBust`, `renderScene`, `pumpkin`, `jackMouth`, `wordmark`) bersama komponen `AsciiArt`.
- **Golden_Test**: Tes `ascii-golden.test.ts` yang membandingkan keluaran ASCII_Generator dengan `ascii-golden.json` karakter demi karakter.
- **UI**: Seluruh halaman dan komponen React di `frontend/src/app` dan `frontend/src/components`.
- **Layar_Kit**: Layar yang punya frame canvas dan spesifikasi §4 (Stage desktop §4.1, Stage phone §4.2, Preparation desktop §4.5, Preparation phone §4.6, Home §4.7).
- **Layar_Tanpa_Frame**: Layar tanpa frame canvas yang disusun dari komponen dan token Kit, dan memerlukan persetujuan user di design.
- **Logika_Murni**: Fungsi dan reducer di `frontend/src/lib/*` beserta hook tipis `use-*.ts`.
- **Kontrak_AI**: `StoryBlueprint` dan `LessonVisual` di `frontend/src/lib/contracts` dan `backend/app/ai/contracts`.
- **Viewport_Desktop**: 1440x900 px. **Viewport_Phone**: 390x844 px.
- **Verifikasi_Task**: Urutan `npm run lint`, `npx tsc --noEmit`, `npx vitest run --testTimeout=60000`, `npm run build` dari `frontend/`.
- **Ringkasan_Penyimpangan**: Daftar setiap perbedaan tampilan antara hasil dan Canvas_Frame_File pada Viewport_Desktop dan Viewport_Phone, ditulis di akhir tiap task.

## Requirements

### Requirement 1: Branch dan batas kerja

**User Story:** Sebagai pemilik repo, saya ingin pekerjaan redesign terisolasi di satu branch tanpa commit otomatis, agar saya mengendalikan riwayat git.

#### Acceptance Criteria

1. WHEN task 0 dimulai, THE UI_Redesign_Workflow SHALL membuat branch `feat/redesign-black-cat-gold` dari ujung (HEAD) branch `dev` lokal dan memindahkan working tree ke branch tersebut.
2. IF branch `dev` tidak ada, atau branch `feat/redesign-black-cat-gold` sudah ada, THEN THE UI_Redesign_Workflow SHALL berhenti tanpa membuat atau mengubah branch apa pun dan menampilkan pesan ke user yang menyebut penyebabnya.
3. THE UI_Redesign_Workflow SHALL menjalankan `git commit` dan `git push` hanya setelah user memintanya secara eksplisit dalam pesan terbaru, dan SHALL NOT menjalankan keduanya pada kasus lain, termasuk di akhir task.
4. IF `git status` sebelum pembuatan branch menunjukkan perubahan yang tidak berasal dari redesign (misalnya `frontend/package.json` dan `frontend/package-lock.json`), THEN THE UI_Redesign_Workflow SHALL menampilkan daftar path file tersebut ke user sebelum membuat branch, meminta konfirmasi user untuk melanjutkan, dan membiarkan isi file tersebut tidak berubah (byte-identik) selama dan setelah pekerjaan redesign.
5. THE UI_Redesign_Workflow SHALL membatasi file yang dibuat, diubah, atau dihapus pada path berikut: `frontend/src`, `frontend/tests`, `docs/`, `reference/`, `scripts/`, `.kiro/steering`, dan file akar yang disebut di Requirement 2.
6. IF sebuah perubahan akan mengenai path di luar daftar pada kriteria 5, THEN THE UI_Redesign_Workflow SHALL membatalkan perubahan itu, menyebut path tersebut ke user, dan melanjutkan hanya setelah user menyetujui path itu secara eksplisit.
7. THE UI_Redesign_Workflow SHALL menyisakan seluruh isi `backend/` tanpa perubahan, termasuk `backend/app/schemas/visual.py` dari Kit, kecuali path yang diizinkan Requirement 16 (hanya `backend/app/ai/prompts`, `backend/app/ai/validation`, `backend/app/ai/campaign_templates.py`, `backend/app/ai/campaign_planner_engine.py`, `backend/app/ai/campaign_planner.py` bila perlu mengunci nama dan peran, dan tes terkait di `backend/tests`), sehingga `git diff --name-only dev -- backend/` menghasilkan keluaran kosong atau hanya path tersebut.

### Requirement 2: Task 0, pasang Kit

**User Story:** Sebagai developer, saya ingin Kit terpasang sesuai README Kit dan terbukti identik dengan canvas sebelum layar mana pun diubah, agar semua layar berdiri di atas fondasi yang benar.

#### Acceptance Criteria

1. BEFORE menyalin file apa pun, THE UI_Redesign_Workflow SHALL menampilkan ke user daftar lengkap path file Kit yang akan disalin atau ditimpa beserta daftar bentrokan nama dengan file yang sudah ada di repo, dan SHALL menunggu persetujuan eksplisit user tanpa menyalin, mengubah, atau menghapus file apa pun sebelum persetujuan diterima.
2. THE daftar bentrokan SHALL mencantumkan hasil pemeriksaan berikut: `lib/ascii` (Kit) berdampingan dengan `lib/ascii-field` (repo) tanpa nama file yang sama; direktori `components/home` dan `components/story` sudah ada di repo sehingga file Kit ditambahkan di dalamnya; `components/ascii` baru; `app/fonts.ts` baru; `lib/schemas/visual.ts` baru; `tests/ascii-golden.test.ts` dan `tests/fixtures/ascii-golden.json` baru; `docs/DESIGN-SYSTEM.md`, `reference/`, `scripts/export-ascii-golden.cjs`, dan `AGENTS.md` akar baru. IF ada file Kit yang path-nya sama dengan file repo yang sudah ada, THEN THE UI_Redesign_Workflow SHALL menandai file itu sebagai "menimpa" dalam daftar dan meminta persetujuan terpisah per file tersebut.
3. WHEN user menyetujui daftar, THE UI_Redesign_Workflow SHALL menyalin `frontend/src/*` dan `frontend/tests/*` Kit ke `frontend/`, `docs/DESIGN-SYSTEM.md` ke `docs/`, `reference/` dan `scripts/` ke akar repo, dan `AGENTS.md` ke akar repo, serta SHALL melaporkan jumlah file yang disalin dan jumlah file yang ditimpa.
4. WHEN penyalinan selesai, THE UI_Redesign_Workflow SHALL menambahkan tepat satu baris "Visual identity: see DESIGN-SYSTEM.md" ke `docs/DESIGN.md` tanpa mengubah baris lain file tersebut.
5. WHEN penyalinan selesai, THE UI_Redesign_Workflow SHALL menambahkan `@import "./lore-tokens.css";` di `frontend/src/app/globals.css` pada baris tepat setelah `@import "tailwindcss";`, dan SHALL tidak menambahkan baris itu bila sudah ada.
6. WHEN penyalinan selesai, THE UI_Redesign_Workflow SHALL memakai `spaceGrotesk` dan `jetbrainsMono` dari `fonts.ts` pada elemen `<html>` di `frontend/src/app/layout.tsx`, dan SHALL menghapus semua rujukan font Geist dari file itu.
7. WHEN penyalinan selesai, THE UI_Redesign_Workflow SHALL memverifikasi bahwa alias `@/*` ke `src/*` di `frontend/tsconfig.json` ada, dan bahwa `tsc --noEmit` meresolusi impor `@/` dari file Kit tanpa error "module not found".
8. WHEN penyalinan dan perubahan pada kriteria 4 sampai 7 selesai, THE Golden_Test SHALL lulus 40 dari 40 tes (0 gagal, 0 dilewati) sebelum task layar pertama dimulai.
9. IF Golden_Test lulus kurang dari 40 dari 40 tes, atau `npx tsc --noEmit` atau `npm run lint` mengembalikan exit code bukan 0, THEN THE UI_Redesign_Workflow SHALL berhenti, melaporkan nama tes atau pesan error yang gagal ke user, mempertahankan file yang sudah disalin tanpa menghapusnya, dan tidak memulai task layar apa pun.
10. IF `lib/schemas/visual.ts` Kit memerlukan Zod 4 dan repo memakai Zod 3, THEN THE UI_Redesign_Workflow SHALL melaporkan ketidakcocokan ke user, menunggu keputusan OQ-2, dan tidak mengubah `package.json` maupun `frontend/package-lock.json` sebelum keputusan diterima.
11. WHEN kriteria 8 terpenuhi dan `tsc --noEmit` serta `lint` lulus, THE UI_Redesign_Workflow SHALL menjalankan Verifikasi_Task dan melaporkan hasilnya (lulus atau gagal per pemeriksaan) sebelum menandai task 0 selesai.

### Requirement 3: Token, tipografi, dan bentuk permukaan

**User Story:** Sebagai pengguna, saya ingin seluruh UI memakai palet, font, dan bentuk yang sama dengan canvas, agar tampilannya konsisten.

#### Acceptance Criteria

1. THE UI SHALL memakai warna hanya dari Token_CSS (`ink`, `smoke`, `gold`, `ember`, `cream`, `muted`, `ink-soft`, `candle`, `candle-ink`) lewat kelas Tailwind token, kecuali warna kain karakter yang berada di `CAST`. Setiap nilai warna lain (hex, `rgb()`, `hsl()`, atau kelas warna Tailwind bawaan) di `frontend/src/components` dan `frontend/src/app` yang bukan bagian dari `CAST` dihitung sebagai pelanggaran.
2. THE UI SHALL memakai Space Grotesk (`font-display`) dan JetBrains Mono (`font-mono`) sesuai tabel tipografi Design_System §2. Setiap elemen teks yang tidak tercantum di tabel tersebut SHALL memakai `font-mono`, dan tidak ada `font-family` lain yang dideklarasikan di luar dua font ini.
3. THE UI SHALL menampilkan layar dengan nilai `border-radius` 0 pada semua elemen, tanpa `rounded-*`, `shadow-*` (kecuali cincin dialog pada `.lore-dialog`), `blur`, `backdrop-*`, gradient (kecuali `.lore-grid-bg`), emoji, dan kontainer kartu. Kontainer kartu berarti elemen yang memadukan latar berbeda dari induk, border tertutup di keempat sisi, dan padding sebagai pembungkus konten.
4. THE UI SHALL memakai ikon SVG inline dengan `stroke-width` 2, `stroke-linecap` `square`, dan `stroke` bernilai `currentColor`. Ikon SHALL tidak berasal dari berkas gambar atau font ikon.
5. THE UI SHALL membuat setiap elemen interaktif (tombol, tautan, input, dan kontrol pilihan) memiliki area sentuh minimal 44 px × 44 px, diukur dari kotak elemen yang dapat diklik termasuk padding.
6. WHEN elemen interaktif menerima fokus keyboard, THE UI SHALL menampilkan outline `ember` setebal 2 px dengan offset 2 px, dan outline tersebut SHALL tidak terpotong oleh `overflow` induk.
7. WHILE `prefers-reduced-motion: reduce` aktif, THE UI SHALL menetapkan mode teks dialog default ke `fast`. IF pengguna sudah memilih mode secara eksplisit, THEN THE UI SHALL mempertahankan pilihan pengguna tersebut.
8. THE UI SHALL menandai elemen dekoratif (labu latar, `PumpkinField`) dengan `aria-hidden="true"` dan `pointer-events: none`, sehingga elemen tersebut tidak menerima klik, tidak menerima fokus keyboard, dan tidak dibacakan oleh pembaca layar.

### Requirement 4: Penghapusan gaya lama

**User Story:** Sebagai developer, saya ingin gaya Halloween/glass lama hilang sepenuhnya, agar dua sistem desain tidak tercampur.

#### Acceptance Criteria

1. WHEN semua layar sudah dipindah ke Kit, THE UI SHALL tidak mereferensikan satu pun dari variabel `--hw-*`, `--glass-*`, `--background-panel`, `--accent-gold`, `--foreground-muted`, atau kelas `liquid` dari gaya lama, dengan bukti berupa pencarian teks di seluruh `frontend/src` (termasuk CSS, TSX, dan `layout.tsx`) dan `frontend/tests` yang mengembalikan 0 kecocokan untuk setiap pola tersebut.
2. WHEN task penutup dijalankan dan pencarian pada `frontend/src` dan `frontend/tests` mengembalikan 0 pemakai (impor, referensi JSX, atau referensi string) di luar file itu sendiri, THE UI_Redesign_Workflow SHALL menghapus `components/backdrop/GlassFilter.tsx`, `components/home/PumpkinMark.tsx`, dan skrip `LIQUID_GLASS_CHECK` di `layout.tsx`, lalu mencatat hasil pencarian tiap file di Ringkasan_Penyimpangan. `components/backdrop/PumpkinBackdrop.tsx` dan `lib/ascii-field/*` TIDAK dihapus: keputusan user 2026-11-21, labu ASCII beranimasi tetap tampil di semua layar dan menjadi pengecualian yang disetujui dari "gaya lama".
3. IF pencarian menemukan 1 atau lebih pemakai file lama saat task penutup, THEN THE UI_Redesign_Workflow SHALL mencantumkan path file dan nomor baris tiap pemakai, tidak menghapus file yang masih dipakai itu, dan menandai task penutup sebagai belum selesai di Ringkasan_Penyimpangan.
4. WHEN file lama dihapus, THE UI_Redesign_Workflow SHALL menghapus atau memperbarui setiap tes yang hanya menguji file itu, mencatat nama file tes dan alasannya di Ringkasan_Penyimpangan, dan memastikan `npm run lint`, `npx tsc --noEmit`, dan `npx vitest run --testTimeout=60000` selesai tanpa error dan tanpa tes yang gagal.
5. WHEN task penutup selesai, THE UI_Redesign_Workflow SHALL mengganti seluruh isi steering `theme-halloween` dengan aturan Kit yang memuat bagian token, tipografi, bentuk, ASCII, dan larangan, sehingga pencarian steering tersebut untuk `--hw-`, `--glass-`, `liquid`, dan `Halloween` mengembalikan 0 kecocokan sebagai aturan gaya.
6. WHEN task penutup selesai, THE UI_Redesign_Workflow SHALL mengganti pada steering `conventions` hanya butir gaya (CSS variable semantik lewat `style` inline) dengan aturan token Tailwind Kit, dan menambahkan rujukan ke `AGENTS.md` dan Design_System, sehingga semua butir non-gaya (logika murni, union hasil, Zod, `data-testid`, komentar header, Conventional Commits, branch, larangan commit, tes, file terlarang) tetap identik dengan versi sebelumnya.
7. WHEN task penutup selesai, THE UI_Redesign_Workflow SHALL memperbarui steering `tech` dan `structure` hanya pada fakta yang berubah, yaitu font, folder `components/ascii`, folder `lib/ascii`, dan jumlah file serta jumlah tes frontend sesuai hasil `npx vitest run` terakhir, dengan baris lain tidak berubah.
### Requirement 5: Alur kerja satu layar per task

**User Story:** Sebagai pemilik repo, saya ingin setiap layar dikerjakan sebagai task terpisah dengan rujukan jelas dan hasil terverifikasi, agar kualitas mudah ditinjau.

#### Acceptance Criteria

1. THE tasks.md SHALL memuat tepat satu task per layar, dengan urutan tetap: task 0 (pasang Kit), Stage desktop, Stage phone, Preparation desktop, Preparation phone, Home, Layar_Tanpa_Frame, lalu task penutup (hapus gaya lama dan perbarui steering), dan setiap task diberi nomor urut berurutan tanpa nomor yang terlewat.
2. THE setiap task layar SHALL menyebut sedikitnya satu nomor bagian Design_System dan tepat nama Canvas_Frame_File yang dipakai, dengan nama file sama persis seperti yang ada di repo.
3. WHEN sebuah task layar dijalankan, THE setiap task layar SHALL menjalankan Verifikasi_Task dan mensyaratkan keempat perintah selesai dengan exit code 0, 0 error, dan 0 warning lint.
4. IF salah satu dari keempat perintah Verifikasi_Task gagal atau menghasilkan warning lint, THEN THE task layar SHALL berstatus belum selesai dan hasil perintah yang gagal SHALL dicatat di Ringkasan_Penyimpangan.
5. WHEN sebuah task layar selesai, THE Golden_Test SHALL lulus 100% (0 test gagal, 0 test dilewati yang sebelumnya berjalan).
6. WHEN sebuah task layar selesai, THE task layar SHALL membandingkan hasil dengan Canvas_Frame_File pada Viewport_Desktop dan Viewport_Phone, dan THE task SHALL melampirkan satu screenshot per viewport bila tersedia.
7. IF screenshot tidak tersedia untuk sebuah viewport, THEN THE task layar SHALL mencatat alasan screenshot tidak tersedia di Ringkasan_Penyimpangan dan membandingkan hasil dengan Canvas_Frame_File secara tertulis, per bagian Design_System yang dirujuk.
8. WHEN sebuah task layar selesai, THE task layar SHALL menutup dengan Ringkasan_Penyimpangan; IF tidak ada penyimpangan, THEN THE ringkasan SHALL berisi teks persis "tidak ada".
9. IF nilai pada Design_System dan Canvas_Frame_File berbeda untuk suatu properti, THEN THE UI_Redesign_Workflow SHALL memakai nilai Design_System dan mencatat properti, nilai Design_System, dan nilai Canvas_Frame_File di Ringkasan_Penyimpangan.
10. IF sebuah nilai tidak ada di Design_System, THEN THE UI_Redesign_Workflow SHALL memakai nilai dari atribut `style` inline pada Canvas_Frame_File terkait dan mencatat properti yang diambil dengan cara ini di Ringkasan_Penyimpangan.
11. WHERE komponen yang dibutuhkan belum ada di Kit, THE UI_Redesign_Workflow SHALL menambahkannya sebagai komponen baru, mendokumentasikannya di Design_System pada task yang sama, dan mencatatnya di Ringkasan_Penyimpangan.

### Requirement 6: Penggambaran ASCII

**User Story:** Sebagai pengguna, saya ingin karakter, scene, labu, dan wordmark tampil persis seperti di canvas, agar identitas visual terjaga.

#### Acceptance Criteria

1. THE UI SHALL menggambar setiap seni ASCII (karakter, bust, scene, labu, mulut labu, wordmark, dan seni dekoratif lain) hanya melalui `renderCharacter`, `renderBust`, `renderScene`, `pumpkin`, `jackMouth`, `wordmark`, dan `AsciiArt`.
2. THE UI SHALL menghasilkan keluaran generator ASCII yang identik karakter demi karakter dengan keluaran canvas referensi untuk masukan (id cast, ekspresi, ukuran) yang sama.
3. THE UI SHALL tidak memuat literal seni ASCII di JSX, tidak menggambar karakter secara manual di komponen, dan tidak mengubah angka konstanta generator (ukuran grid, nilai palet, dan seed).
4. THE Stage SHALL hanya menerima id cast `eldric`, `mira`, `hazel`, `varr`, `nyx` dari daftar cast Design_System §6 dan hanya lima ekspresi `calm`, `smile`, `worried`, `surprised`, `angry`.
5. WHEN kontrak StoryBlueprint menyebut karakter atau emosi, THE UI SHALL memetakannya ke satu id cast dan satu ekspresi Kit melalui fungsi murni di `lib/` yang punya tes Vitest yang mencakup setiap id cast, setiap ekspresi, dan minimal satu masukan tanpa padanan.
6. WHEN fungsi pemetaan menerima nama karakter atau emosi yang sama, THE pemetaan SHALL mengembalikan hasil yang sama pada setiap pemanggilan (deterministik, tanpa efek samping).
7. IF karakter atau emosi dari StoryBlueprint tidak punya padanan di Kit, THEN THE pemetaan SHALL mengembalikan `{ ok: false, ... }` yang menyebut nilai yang tidak dikenali, TIDAK melempar exception, dan THE UI SHALL menampilkan fallback yang didefinisikan di Design_System, sehingga Stage tetap dapat dirender tanpa menghentikan story.
8. THE sprite karakter pada Stage SHALL memiliki `role="img"` dengan nama aksesibel yang tidak kosong dan memuat nama karakter serta ekspresi saat ini, dan THE seni ASCII dekoratif SHALL memiliki `aria-hidden="true"`.

### Requirement 7: Stage desktop (Task 1)

**User Story:** Sebagai pemain, saya ingin stage desktop tampil seperti frame Main, agar pengalaman bermain sesuai desain.

*Rujukan:* Design_System §4.1, §4.3, §4.4, §6; `Main.dc.html`; `Cast.dc.html`.

#### Acceptance Criteria

1. THE Stage SHALL dirender pada ukuran desain 1440x900 dan diskalakan sebagai satu unit dengan `scale(min(100vw / 1440, 100vh / 900))`, origin top-center, tanpa mengalirkan ulang anak elemen, sehingga posisi dan ukuran semua elemen anak terhadap kanvas 1440x900 tetap sama pada setiap ukuran viewport dengan lebar 320 px sampai 3840 px dan tinggi 240 px sampai 2160 px.
2. THE Stage SHALL menampilkan HUD 1440x64 (tombol kembali 44 px, `LORE`, judul cerita, `Chapter n / m`, `HP` dengan 5 kotak ember 12 px, dan `n/5`), papan stage 1200x675 di (120,92), `CanvasFrame` 736x414 di (432,32), `DialogueBox` 876x181 di (300,470), sprite speaker 317x576 di (20,99), dan petunjuk tombol di y 800. Semua koordinat dan ukuran dalam piksel desain, dan setiap elemen diukur dengan toleransi 0 px pada kanvas desain sebelum penskalaan.
3. THE Stage SHALL menggambar sprite speaker setelah (di depan) kotak dialog, sehingga pada area yang tumpang tindih piksel sprite speaker terlihat di atas piksel `DialogueBox`.
4. THE `CanvasFrame` SHALL menampung pemutar Remotion yang ada, `LessonVisual` yang digambar seperti sekarang, dan `PlayerBar` setinggi 40 px, tanpa ketiganya meluap di luar batas 736x414 `CanvasFrame`.
5. WHEN sebuah puzzle pilihan ganda ditampilkan, THE Stage SHALL menampilkan pilihan jawaban sebagai `ChoiceButton` setinggi 44 px (lebar minimum 112 px, jarak 10 px antar tombol) di bawah puzzle di dalam `CanvasFrame`.
6. WHEN pemain memilih jawaban, THE UI SHALL memakai hasil benar-salah dan perubahan HP dari Logika_Murni yang ada tanpa menghitungnya di komponen, dan nilai `n/5` serta jumlah kotak ember HP yang terisi pada HUD SHALL diperbarui sesuai HP hasil Logika_Murni dalam 100 ms setelah pilihan.
7. WHERE mode `animate` dipilih, THE `DialogueBox` SHALL menampilkan satu karakter per 25 ms.
8. WHEN pemain menekan SPACE atau mengklik `DialogueBox` saat teks animate masih berjalan, THE `DialogueBox` SHALL menampilkan baris penuh seketika (dalam 100 ms) dan menghentikan animasi.
9. WHERE mode `fast` dipilih, THE `DialogueBox` SHALL menampilkan baris penuh langsung tanpa animasi per karakter, dan toggle `fast | animate` yang ada SHALL tetap berfungsi dengan mengganti mode pada baris dialog berikutnya.
10. THE input `type something` SHALL tetap tampil dalam keadaan disabled dengan keterangan "coming soon", dan SHALL tidak menerima fokus atau masukan teks.
11. WHEN pemain mengklik tombol `log` atau menekan `L`, THE UI SHALL membuka log chat yang ada.
12. WHEN pemain menekan `SPACE` atau `F`, THE UI SHALL memicu aksi yang sama dengan kontrol layar padanannya (`SPACE`: maju/tampilkan baris penuh; `F`: toggle `fast | animate`), dan petunjuk tombol `SPACE`, `F`, `L` SHALL tampil di y 800.
13. IF fokus berada pada elemen input teks atau elemen yang dapat diedit, THEN THE Stage SHALL mengabaikan pintasan `SPACE`, `F`, dan `L`.
14. THE komponen Stage SHALL mempertahankan `data-testid` yang ada pada elemen interaktif (atau menggantinya dengan padanan yang tes-nya diperbarui dalam perubahan yang sama) dan menambahkan `data-testid` pada setiap elemen interaktif baru.
15. WHILE `prefers-reduced-motion` aktif, THE `DialogueBox` SHALL memulai dalam mode `fast`.

### Requirement 8: Stage phone (Task 2)

**User Story:** Sebagai pemain di ponsel, saya ingin stage phone tampil seperti frame StageMobile, agar bisa bermain nyaman di layar kecil.

*Rujukan:* Design_System §4.2, §4.3, §4.4; `StageMobile.dc.html`.

#### Acceptance Criteria

1. WHILE layout phone aktif, THE Stage SHALL dirender pada ukuran desain 390x844 px dan diskalakan sebagai satu unit dengan faktor skala seragam (rasio lebar:tinggi tetap 390:844) sehingga seluruh Stage terlihat penuh di viewport tanpa terpotong dan tanpa scroll.
2. WHILE layout phone aktif, THE Stage phone SHALL menampilkan HUD 390x56 px, scene setinggi 8 px di (0,56), `CanvasFrame` 366x246 px di (12,68) dengan `PlayerBar` setinggi 38 px dan tick sudut 10 px, sprite speaker 211x384 px di (6,318), dan `DialogueBox` 366x250 px di (12,582), semua dalam koordinat ruang desain 390x844 px dengan toleransi 0 px sebelum penskalaan.
3. WHILE layout phone aktif, THE Stage phone SHALL menggambar sprite speaker sebelum (di belakang) `DialogueBox` dalam urutan z-order, sehingga `DialogueBox` menutupi bagian sprite yang beririsan dengannya (area sprite di bawah y=582, yaitu 120 px dari tinggi sprite 384 px).
4. WHILE layout phone aktif, THE `DialogueBox` SHALL menampilkan pilihan jawaban di dalam dirinya sebagai satu sampai empat tombol (sesuai jumlah pilihan yang tersedia) dengan `flex 1` (lebar sama) dan tinggi 44 px, serta bar bawah setinggi 46 px yang memuat input `type something` (berstatus disabled), toggle `fast | animate`, dan tombol `log`.
5. WHEN lebar viewport kurang dari atau sama dengan batas phone yang ditetapkan di design, THE UI SHALL memilih layout phone; WHEN lebar viewport lebih besar dari batas tersebut, THE UI SHALL memilih layout desktop. Nilai batas (px) ditetapkan di design dan SHALL dipakai sebagai satu-satunya titik pemisah kategori.
6. WHEN lebar viewport melewati batas phone saat Stage sedang tampil (misalnya rotasi atau perubahan ukuran jendela), THE UI SHALL berpindah ke layout yang sesuai tanpa mengubah state permainan (HP, posisi story, dan pilihan yang sudah dijawab) dan dalam waktu 300 ms setelah perubahan ukuran terakhir.
7. WHILE layout phone aktif, THE Stage phone SHALL menampilkan tepat satu sprite karakter (speaker) dan SHALL tidak merender karakter kedua, termasuk ketika data story menyebut lawan bicara.
8. IF jumlah pilihan jawaban pada langkah story yang sedang tampil tidak sama dengan empat, THEN THE `DialogueBox` SHALL menampilkan semua pilihan yang tersedia (minimal 1, maksimal 4) sebagai tombol `flex 1` setinggi 44 px tanpa menampilkan tombol kosong, dan tata letak elemen lain pada ruang desain SHALL tetap tidak berubah.
### Requirement 9: Preparation desktop (Task 3)

**User Story:** Sebagai pengguna, saya ingin layar pembuatan cerita desktop tampil seperti frame Prep, agar langkah persiapan jelas.

*Rujukan:* Design_System §4.5; `Prep.dc.html`. Layar yang dipakai: `app/create/page.tsx`, `components/setup/*`.

#### Acceptance Criteria

1. THE layar SHALL berupa satu kolom datar pada x 380 px, lebar 680 px, tinggi penuh viewport, fill `ink`, border kiri dan kanan masing-masing 1 px `smoke`, padding `24px 48px 0`, dengan `PUMPKINS_PREP_DESKTOP`.
2. THE layar SHALL menampilkan elemen berikut secara berurutan dari atas ke bawah: baris atas setinggi 44 px (tautan `← Back` dan teks `LORE`), label `NEW STORY`, H1 36 px, satu paragraf, bagian bernomor `01 MATERIAL`, `02 WORLD`, `03 CHAPTERS`, dan bar aksi bawah setinggi 80 px.
3. WHILE tidak ada file dipilih, THE dropzone `01 MATERIAL` SHALL setinggi 128 px, berborder 2 px putus-putus `smoke`, dan menampilkan tombol `Choose a file`.
4. WHILE satu file valid dipilih, THE dropzone `01 MATERIAL` SHALL setinggi 128 px, berborder 2 px solid `gold`, menampilkan nama file lengkap (teks terlalu panjang dipotong dengan elipsis pada satu baris), dan menampilkan tombol `Replace` sebagai pengganti `Choose a file`.
5. THE bagian `02 WORLD` SHALL berupa grid 3 kolom dengan sel berukuran 84 px; sel yang dipilih SHALL berlatar `cream` dengan kotak `ember` 8 px, dan tepat satu sel terpilih pada satu waktu.
6. THE bagian `03 CHAPTERS` SHALL berupa lima kotak berukuran 44 px dan tautan `Advanced options`; kotak yang dipilih SHALL berisi `ember`, tepat satu kotak terpilih pada satu waktu, dan kotak lain SHALL kosong.
7. WHILE syarat generasi belum terpenuhi (belum ada file valid, atau generasi sedang berjalan), THE tombol `Build the world →` SHALL setinggi 48 px, berlatar `smoke`, berteks `muted`, dan tidak dapat diaktifkan.
8. WHILE syarat generasi terpenuhi (ada file valid dan generasi tidak sedang berjalan), THE tombol `Build the world →` SHALL setinggi 48 px, berlatar `ember`, berteks `ink`, dan dapat diaktifkan.
9. THE layar SHALL mensyaratkan file sebagai materi; teks yang diketik pengguna SHALL hanya diperlakukan sebagai instruksi tambahan dan tidak pernah menggantikan file.
10. THE layar SHALL mempertahankan perilaku yang ada: validasi tipe file (PDF, DOCX, PPTX, TXT, MD) dan ukuran file maksimum 25 MB, pembacaan file di perangkat pengguna, pemilihan genre/world, pemilihan jumlah bab, opsi lanjutan, dan pemicu generasi.
11. IF file ditolak karena tipe tidak didukung atau ukuran melebihi 25 MB, THEN THE layar SHALL menampilkan pesan kesalahan dengan teks yang sudah ada untuk alasan tersebut, hanya memakai warna token desain dan tanpa kartu, mempertahankan dropzone dalam keadaan tanpa file, dan menjaga tombol `Build the world →` tetap disabled.
12. IF pembacaan file di perangkat gagal, THEN THE layar SHALL menampilkan pesan kesalahan dengan teks yang sudah ada, mempertahankan pilihan world, jumlah bab, dan instruksi tambahan yang sudah diisi, dan menjaga tombol `Build the world →` tetap disabled.

### Requirement 10: Preparation phone (Task 4)

**User Story:** Sebagai pengguna ponsel, saya ingin layar pembuatan cerita phone tampil seperti frame PrepMobile.

*Rujukan:* Design_System §4.6; `PrepMobile.dc.html`.

#### Acceptance Criteria

1. WHEN layar Preparation dirender pada viewport phone, THE layar SHALL menampilkan header setinggi 56 px berisi ikon kembali dan teks `LORE`, dengan padding horizontal dan vertikal konten 20 px, dan bagian-bagian yang sama dengan Preparation desktop tersusun bertumpuk satu kolom dari atas ke bawah tanpa scroll horizontal.
2. WHEN layar Preparation dirender pada viewport phone, THE opsi world SHALL berupa baris yang masing-masing setinggi 54 px dan selebar penuh konten, dan THE pilihan chapters SHALL berupa grid 5 kolom dengan lebar kolom yang sama.
3. WHEN layar Preparation dirender pada viewport phone, THE dropzone SHALL menumpuk ikon di atas teks secara vertikal, dan tombol pilih file di dalam dropzone SHALL selebar penuh dropzone.
4. WHILE layar Preparation tampil pada viewport phone, THE bar bawah SHALL tetap menempel di tepi bawah viewport saat konten digulir, dan SHALL berisi satu baris status di atas tombol CTA setinggi 52 px selebar penuh.
5. WHEN pengguna menekan ikon kembali di header, THE layar SHALL kembali ke layar sebelumnya tanpa menghapus pilihan world, chapters, file, atau instruksi tambahan yang sudah diisi pada sesi itu.
6. IF belum ada file yang dipilih, THEN THE tombol CTA SHALL berstatus disabled dan baris status SHALL menunjukkan bahwa file wajib dipilih.
7. THE layar SHALL memakai Logika_Murni dan komponen data yang sama dengan Preparation desktop, sehingga untuk input yang sama hasil validasi, nilai pilihan, dan payload yang dikirim identik dengan versi desktop, dan hanya tata letak yang berbeda.

### Requirement 11: Home (Task 5)

**User Story:** Sebagai pengguna, saya ingin halaman awal memakai satu input bergaya Kit, agar kesan pertama sesuai identitas visual.

*Rujukan:* Design_System §4.7; `HomeA/B/C.dc.html` dan `HomeA/B/CMobile.dc.html` sesuai opsi terpilih (OQ-1). Layar yang dipakai: `app/page.tsx`, `components/home/*`.

#### Acceptance Criteria

1. THE Home SHALL mengimplementasikan tepat satu opsi (A, B, atau C) sesuai keputusan OQ-1, pada tata letak desktop dan phone, dan tidak merender elemen khas opsi lain pada viewport mana pun.
2. WHEN opsi Home dipilih, THE UI_Redesign_Workflow SHALL menghapus dari `frontend/src` semua komponen dan file referensi milik dua opsi yang tidak dipilih yang dibawa Kit (untuk opsi A yang tidak dipilih: `PumpkinMouthInput`), sehingga pencarian nama komponen tersebut di `frontend/src` dan `frontend/tests` menghasilkan 0 kecocokan.
3. THE UI_Redesign_Workflow SHALL membiarkan isi `reference/canvas` Kit tidak berubah (0 file ditambah, diubah, atau dihapus).
4. THE Home SHALL menerima file berformat PDF, DOCX, PPTX, TXT, dan MD dengan ukuran 1 byte hingga 25 MB (26.214.400 byte) dan membacanya di perangkat pengguna tanpa mengunggahnya ke server pada tahap Home.
5. IF pengguna memilih file dengan format di luar daftar, ukuran 0 byte, atau ukuran di atas 25 MB, THEN THE Home SHALL menolak file tersebut, menampilkan pesan error yang menyebut alasan penolakan (format tidak didukung, file kosong, atau melebihi batas ukuran), dan mempertahankan teks serta file valid yang sudah ada pada input.
6. WHEN pengguna mengaktifkan aksi "Play the demo: The Last Beacon", THE Home SHALL memulai demo tersebut dengan perilaku yang sama seperti sebelum redesign.
7. THE Home SHALL menampilkan `SavedStories` (daftar project tersimpan) dengan perilaku yang sama seperti sebelum redesign (urutan, isi tiap item, aksi buka dan hapus), disusun dari token Kit sebagai Layar_Tanpa_Frame.
8. WHILE tidak ada project tersimpan, THE Home SHALL menampilkan keadaan kosong pada area `SavedStories` tanpa error.
9. WHEN pengguna mengirim input Home, THE Home SHALL meneruskan teks dan file ke alur `/create` yang ada dengan struktur data yang identik dengan kontrak sebelum redesign (tidak ada field ditambah, dihapus, atau diubah tipenya).
10. IF pengguna mengirim input Home tanpa file, THEN THE Home SHALL tidak berpindah ke `/create` dan menampilkan pesan error yang menyatakan file wajib diisi, karena teks yang diketik hanya menjadi instruksi tambahan dan bukan materi.
11. IF opsi B dipilih, THEN WHEN file ditambahkan ke input, THE Home SHALL mengganti ekspresi Hazel menjadi `surprised` dan mengubah baris dialog ke teks khusus keadaan file ditambahkan.
12. IF opsi B dipilih, THEN WHEN semua file dihapus dari input, THE Home SHALL mengembalikan ekspresi Hazel dan baris dialog ke keadaan awal.
13. THE input teks Home SHALL memiliki elemen `<label>` yang terhubung ke input dan atribut `aria-*` yang sama seperti komponen input Kit, sehingga nama aksesibelnya tidak kosong.
### Requirement 12: Layar tanpa frame desain (Task 6 dan seterusnya)

**User Story:** Sebagai pengguna, saya ingin layar yang belum didesain tetap konsisten dengan gaya Kit, agar tidak ada layar bergaya lama yang tersisa.

*Rujukan:* Design_System §1–§3 dan §8 (aturan umum); tidak ada Canvas_Frame_File.

#### Acceptance Criteria

1. WHEN sebuah Layar_Tanpa_Frame dirender, THE UI_Redesign_Workflow SHALL menyusun layar itu hanya dari komponen Kit dan token Kit, tanpa warna, font, atau ukuran literal di luar token Kit. Daftar Layar_Tanpa_Frame terdiri dari tepat 11 layar: Generating (`GenerationScreen`), log chat (`ChatLog`/`ChatBox`), `AdvancedOptions`, `CampaignLobby`, `CampaignPlayer`, `CampaignSummary`, `EndingDisplay`, `StoryComplete`, `StoryFailure`, `StoryViewer`, dan `PlayProject`.
2. THE UI_Redesign_Workflow SHALL menandai setiap Layar_Tanpa_Frame dengan label "tanpa frame canvas" satu kali di bagian design dan satu kali di tasks.md, sehingga 11 layar memiliki 11 tanda di tiap dokumen.
3. THE design SHALL memuat untuk setiap Layar_Tanpa_Frame: struktur (urutan elemen dari atas ke bawah), ukuran untuk breakpoint desktop dan phone, dan teks tampilan (label, judul, pesan kosong, pesan galat).
4. WHEN rancangan sebuah Layar_Tanpa_Frame selesai ditulis, THE UI_Redesign_Workflow SHALL berhenti dan menunggu persetujuan eksplisit user atas rancangan itu sebelum mengimplementasikan layar tersebut.
5. IF user belum memberi persetujuan atas rancangan sebuah Layar_Tanpa_Frame, THEN THE UI_Redesign_Workflow SHALL tidak mengubah file implementasi layar itu dan SHALL tetap melanjutkan layar lain yang sudah disetujui.
6. WHILE Stage dalam mode dua karakter, THE Stage SHALL menampilkan speaker aktif di slot sprite dengan opacity 100% dan karakter lain dengan opacity 40%, sesuai Design_System §6.
7. WHILE Stage dalam mode dua karakter di desktop dan beat tidak memiliki canvas, THE Stage SHALL menampilkan karakter lain di tempat `CanvasFrame`.
8. WHILE Stage dalam mode dua karakter di phone, THE Stage SHALL tidak menampilkan karakter lain.
9. THE UI_Redesign_Workflow SHALL menandai mode dua karakter di Stage dengan label "tanpa frame canvas" di design dan tasks.md.
10. THE UI_Redesign_Workflow SHALL tidak membangun Grilling dan estimasi kredit, karena keduanya tidak ada di kode saat ini (OQ-3).
11. IF user meminta Grilling atau estimasi kredit, THEN THE UI_Redesign_Workflow SHALL mencatatnya sebagai requirement baru dengan nomor berikutnya di requirements.md, dan SHALL tidak mengimplementasikannya sebelum requirement itu disetujui.
12. WHEN sebuah Layar_Tanpa_Frame selesai diimplementasikan, THE Layar_Tanpa_Frame SHALL mempertahankan perilaku, state, dan seluruh nilai `data-testid` yang ada sebelum perubahan, sehingga seluruh test frontend yang ada di `frontend/tests/` yang menyentuh layar itu lulus tanpa mengubah assertion `data-testid` atau perilaku.

### Requirement 13: Pelestarian perilaku dan batas kepercayaan

**User Story:** Sebagai developer, saya ingin redesign hanya mengganti tampilan, agar alur game, generasi, dan persistensi tidak rusak.

#### Acceptance Criteria

1. THE UI_Redesign_Workflow SHALL mempertahankan Logika_Murni di `lib/game`, `lib/story`, `lib/campaign`, `lib/generation`, `lib/ingest`, `lib/setup`, `lib/state`, dan `lib/contracts` tanpa perubahan perilaku, dibuktikan dengan 0 file non-test yang berubah di folder tersebut dalam diff redesign dan seluruh test di `frontend/tests/` untuk domain tersebut lulus tanpa test yang dihapus, dilewati, atau dilonggarkan asersinya.
2. THE komponen SHALL tidak menghitung HP atau benar-salah sendiri; WHEN UI membutuhkan logika baru, THE UI_Redesign_Workflow SHALL menempatkannya di `lib/*` sebagai fungsi murni dengan hook `use-*.ts` yang hanya memanggil fungsi tersebut dan mengelola state React, tanpa aturan HP atau penilaian jawaban di dalam hook atau komponen.
3. THE fungsi murni baru SHALL mengembalikan union `{ ok: true, ... } | { ok: false, ... }` dan tidak throw di batas modul, dibuktikan dengan test untuk setidaknya satu input valid dan satu input tidak valid per fungsi yang mengembalikan `{ ok: false, ... }`.
4. WHEN UI membaca data dari IndexedDB, localStorage, atau respons backend, THE UI SHALL memvalidasi data tersebut dengan skema Zod sebelum dipakai, seperti perilaku sebelum redesign.
5. IF data dari IndexedDB, localStorage, atau respons backend gagal validasi Zod, THEN THE UI SHALL menolak data tersebut tanpa crash, menampilkan indikasi error kepada pengguna, dan tidak menimpa data tersimpan yang ada.
6. THE Kontrak_AI (`StoryBlueprint`, `LessonVisual`) di `frontend/src/lib/contracts` dan `backend/app/ai/contracts` SHALL tetap tidak berubah, dibuktikan dengan 0 baris diff pada kedua direktori tersebut dan test kontrak frontend serta backend yang lulus; satu-satunya perubahan backend yang diizinkan adalah teks prompt AI, template dan engine planner, serta validasi planner sesuai Requirement 16, dengan direktori `contracts` tetap tanpa diff.
7. THE `SceneBlueprintSchema` dan `SceneBlueprint` Kit SHALL tidak dipakai di alur AI (tidak diimpor oleh kode di `lib/generation` maupun `backend/app/ai`); THE design SHALL mencatat penggunaannya sebagai pekerjaan lanjutan.
8. THE UI SHALL tidak menerima, menyimpan, atau merender gambar maupun koordinat yang berasal dari keluaran model AI; IF respons AI memuat field gambar atau koordinat, THEN THE UI SHALL mengabaikan field tersebut dan tidak merendernya.
9. THE tiap file baru SHALL memiliki komentar header di baris pertama berisi tujuan dan alasan file tersebut dibuat.
10. WHILE `NEXT_PUBLIC_PROJECT_STORE` bernilai `idb` atau `http`, THE UI SHALL menjalankan alur buat, muat, simpan, dan hapus project sesuai mode tersebut dengan 0 baris diff pada `project-store.ts` dan test persistensi untuk kedua mode lulus.

### Requirement 14: Pengujian

**User Story:** Sebagai developer, saya ingin tes tetap melindungi perilaku setelah tampilan diganti, agar tidak ada regresi diam-diam.

#### Acceptance Criteria

1. WHEN tampilan sebuah komponen UI berubah (selector, teks, atau struktur), THE UI_Redesign_Workflow SHALL memperbarui tes komponen itu sehingga setiap perilaku yang diuji sebelum perubahan (hasil interaksi, state, dan data yang ditampilkan) tetap diuji setelah perubahan, dan jumlah asersi perilaku pada tes yang diperbarui tidak lebih sedikit daripada sebelum perubahan, kecuali asersi itu tercatat di Ringkasan_Penyimpangan.
2. IF sebuah tes dihapus karena komponennya dihapus, THEN THE UI_Redesign_Workflow SHALL mencatat di Ringkasan_Penyimpangan, untuk setiap tes yang dihapus, nama file tes, nama komponen yang dihapus, dan nama file tes pengganti yang menutup perilaku yang sama, atau alasan tertulis bahwa perilaku itu ikut dihapus.
3. WHEN sebuah komponen baru yang menerima interaksi pengguna (klik, input, atau navigasi keyboard) ditambahkan, THE UI_Redesign_Workflow SHALL menambahkan file tes di `frontend/tests/<domain>/` dengan nama domain sesuai folder komponen di `frontend/src/components/`, yang memakai docblock `@vitest-environment jsdom` dan mencakup minimal satu kasus per interaksi yang didukung komponen itu.
4. WHEN sebuah pemetaan murni baru ditambahkan (Requirement 6.5), THE UI_Redesign_Workflow SHALL menambahkan tes untuk pemetaan itu yang mencakup minimal satu kasus dengan hasil `{ ok: true }` dan minimal satu kasus dengan hasil `{ ok: false }` untuk setiap alasan kegagalan yang dikembalikan pemetaan itu.
5. WHEN suite Vitest dijalankan, THE Golden_Test SHALL membandingkan keluaran generator ASCII untuk setiap kasus di `ascii-golden.json` dan SHALL lulus hanya bila setiap keluaran identik karakter demi karakter dengan nilai di `ascii-golden.json`.
6. IF keluaran generator ASCII berbeda dari `ascii-golden.json` pada satu karakter atau lebih, THEN THE Golden_Test SHALL gagal dan menampilkan nama kasus yang berbeda, tanpa menimpa `ascii-golden.json` secara otomatis.
7. WHEN sebuah task selesai, THE UI_Redesign_Workflow SHALL memastikan `npx vitest run --testTimeout=60000` berakhir dengan 0 tes gagal, `npm run lint` berakhir dengan 0 error, dan `npx tsc --noEmit` berakhir dengan 0 error, semuanya dijalankan dari `frontend/`.
8. WHEN sebuah task selesai, THE UI_Redesign_Workflow SHALL memastikan `npm run build` dari `frontend/` berakhir dengan kode keluar 0 tanpa variabel env AI (`GOOGLE_API_KEY`, `GEMINI_API_KEY`) terpasang.
9. THE UI_Redesign_Workflow SHALL tidak mengubah file apa pun di bawah `backend/`, sehingga `ruff check . && ruff format --check .` dan `pytest -q` dari `backend/` menghasilkan hasil yang sama dengan sebelum perubahan (0 pelanggaran ruff, jumlah tes lulus dan skip tidak berubah).

### Requirement 15: Performa dan kompatibilitas

**User Story:** Sebagai pengguna, saya ingin layar tetap responsif dan kompatibel, agar redesign tidak memperlambat aplikasi.

#### Acceptance Criteria

1. THE `AsciiArt` SHALL merender ASCII lewat elemen `<canvas>`.
2. WHEN `AsciiArt` dirender ulang dengan nilai props yang sama dengan render sebelumnya, THE UI SHALL tidak menggambar ulang canvas dan SHALL tidak membuat ulang layer ASCII (nol panggilan gambar ke canvas pada render ulang tersebut).
3. IF props `AsciiArt` berubah, THEN THE UI SHALL menggambar ulang canvas tepat satu kali per perubahan dan SHALL menampilkan hasil dengan props terbaru.
4. THE UI SHALL kompatibel dengan Next 16 (`cacheComponents`, `reactCompiler`) dan Turbopack, dibuktikan dengan `npm run build` selesai dengan exit code 0 tanpa error dan tanpa peringatan terkait komponen Kit.
5. THE setiap komponen yang memakai API browser (`window`, `document`, `canvas`, atau `localStorage`) SHALL memiliki direktif `'use client'` di baris pertama file.
6. WHEN `npm run lint` dijalankan, THE komponen Kit yang dipasang SHALL menghasilkan 0 error dan 0 warning.
7. WHEN `npx tsc --noEmit` dijalankan dengan mode strict, THE komponen Kit yang dipasang SHALL menghasilkan 0 error.
8. IF sebuah `eslint-disable` baru ditambahkan pada komponen Kit, THEN THE `eslint-disable` tersebut SHALL memuat komentar satu baris di baris yang sama atau sebelumnya yang menyebutkan nama aturan dan alasannya.
9. THE `next/font` SHALL memuat font Space Grotesk dan JetBrains Mono dari aset yang dilayani oleh origin aplikasi sendiri, sehingga 0 permintaan jaringan ke domain font eksternal terjadi saat runtime di browser.
10. IF salah satu font gagal dimuat, THEN THE UI SHALL tetap menampilkan teks dengan font sistem cadangan dan SHALL tidak menyembunyikan teks lebih dari 3000 ms.

### Requirement 16: Tokoh AI memakai cast Kit

**User Story:** Sebagai pemain, saya ingin tokoh pada story hasil AI memakai cast Kit (Eldric, Mira, Hazel, Varr, Nyx), agar sprite ASCII di Stage cocok dengan tokoh yang berbicara tanpa pemetaan acak.

*Pengecualian:* Keputusan user (opsi A, disetujui eksplisit) membuka lingkup `backend/` secara terbatas sebagai pengecualian atas Requirement 1.5, 1.7, 13.6, dan 14.9. Hanya teks prompt, template dan engine planner (`campaign_templates.py`, `campaign_planner_engine.py`, dan `campaign_planner.py` bila perlu mengunci nama dan peran), serta validasi keluaran di `backend/app/ai` yang boleh berubah; kontrak tidak berubah. Keputusan user "Dua tokoh dulu": campaign memakai lima tokoh cast dengan urutan tetap, tetapi story (Layer 3) tetap memakai `characters[0]` (eldric) dan `characters[1]` (mira); `prompts/story_generator.py` tidak berubah.

#### Acceptance Criteria

1. THE AI_Prompt di `backend/app/ai/prompts` SHALL menginstruksikan model untuk memakai hanya lima tokoh cast Kit: `eldric` (Eldric, guide), `mira` (Mira, peer), `hazel` (Hazel, practice), `varr` (Varr, examiner), dan `nyx` (Nyx, rival), sesuai Design_System §6.
2. THE AI_Prompt SHALL menginstruksikan model untuk mengisi `character_id` dan nama tokoh dengan id dan nama cast tersebut dan menyesuaikan peran tiap tokoh dengan peran Kit-nya.
3. THE Kontrak_AI (`StoryBlueprint`, `LessonVisual`) di `frontend/src/lib/contracts` dan `backend/app/ai/contracts` SHALL tetap tanpa field yang ditambah atau dihapus, dengan 0 baris diff pada kedua direktori tersebut.
4. IF keluaran model memuat tokoh di luar lima id cast, THEN THE AI_Validator planner (`validate_planned_campaign`) SHALL menolak keluaran itu dengan galat validasi `INVALID_CAST_CHARACTER` (jalur story tidak memeriksa cast, agar campaign lama `char_01`/`char_02` tetap valid) atau memetakan tokoh itu ke satu id cast secara deterministik, dan SHALL tidak melempar exception di batas modul.
5. THE UI SHALL mempertahankan pemetaan fallback di `lib/cast` untuk story lama yang sudah tersimpan dengan `character_id` di luar lima id cast, sehingga Stage tetap dapat dirender.
6. THE tes backend untuk prompt dan validasi SHALL diperbarui untuk mencakup lima id cast, peran Kit, dan tokoh di luar cast, dan `ruff check .`, `ruff format --check .`, serta `pytest -q` dari `backend/` SHALL lulus tanpa tes yang dihapus atau dilewati.
7. THE perubahan backend SHALL terbatas pada teks prompt dan validasi keluaran, dibuktikan dengan `git diff --name-only dev -- backend/` yang hanya memuat path di `backend/app/ai/prompts`, `backend/app/ai/validation`, `backend/app/ai/campaign_templates.py`, `backend/app/ai/campaign_planner_engine.py`, `backend/app/ai/campaign_planner.py`, dan `backend/tests`.