# LORE × Kiroween 2026 — Analisis Track & Kelayakan

> Disusun 17 November 2026. Halaman Devpost resmi menolak akses otomatis (HTTP 403), jadi aturan di
> bawah diambil dari situs pihak ketiga yang merangkum aturan Kiroween 2026 (lihat [Sumber](#sumber)).
> **Cocokkan dengan [kiroween.devpost.com/rules](https://kiroween.devpost.com/rules) sebelum mendaftar.**

## Ringkasan

- **Track yang direkomendasikan:** **Frankenstein**. Alternatifnya **Costume Contest**.
- **Belum memenuhi syarat wajib:** (1) aplikasi harus dibangun dengan Kiro dan repo wajib memuat
  `/.kiro`, (2) tema Halloween wajib. Keduanya dicek lulus/gagal di tahap 1 penjurian.
- **Sudah memenuhi:** proyek baru (commit pertama 8 November 2026), dan Indonesia tidak termasuk
  negara yang dikecualikan.

---

## 1. Track

| Track | Isi | Kecocokan dengan LORE |
|---|---|---|
| **Frankenstein** | Gabungkan teknologi yang tampaknya tidak cocok menjadi satu aplikasi | ✅ **Paling cocok**: sebagian besar fitur sudah ada |
| **Costume Contest** | Aplikasi apa pun dengan UI yang menghantui, rapi, dan tak terlupakan; elemen seramnya membantu fungsi aplikasi | 🟡 Alternatif: perlu desain ulang tampilan yang cukup besar |
| Resurrection | Menghidupkan teknologi usang dengan tools masa kini | ❌ Lemah: avatar ASCII dan gaya visual novel hanya kaitan tipis |
| Skeleton Crew | Template ringan yang dipakai oleh dua aplikasi berbeda (dua folder aplikasi di repo) | ❌ Menuntut struktur repo yang sama sekali berbeda |

### Mengapa Frankenstein

Ceritanya sudah ada di kode:

- **Remotion**, framework untuk *membuat video*, dipakai sebagai **kanvas game yang hidup** dan
  interaktif (`src/components/stage/`).
- **LLM (Gemini)** menulis **JSON** yang langsung digambar sebagai **diagram animasi**: vektor, grafik,
  diagram alur, tabel, dan rumus (`src/lib/types/visual.ts`, `src/components/stage/visual-compositions.tsx`).
- **Materi kuliah** (PDF/DOCX/PPTX, dibaca di browser) diubah menjadi **visual novel** lengkap dengan
  HP, karakter beremosi, dan puzzle (`src/lib/ingest/`, `src/lib/ai/`).
- **Foto pengguna** diubah menjadi **avatar ASCII** di perangkat (`src/lib/ascii/`).

Yang perlu ditambahkan adalah nuansa Halloween dan cara presentasinya, bukan fitur baru.

### Jika memilih Costume Contest

UI saat ini bertema "Dark Sci-Fi Gold": gelap, tapi tidak seram. Track ini menuntut elemen seram yang
**membantu fungsi aplikasi**, bukan sekadar hiasan. Contohnya HP yang tampil sebagai lilin yang padam,
atau kanvas yang "berhantu" saat jawaban salah.

### Hadiah tambahan yang mungkin relevan

| Hadiah | Nilai | Syarat |
|---|---|---|
| Best Student Project (per track) | $1.500 + 1 tahun Kiro Pro Max | **Semua** anggota tim mahasiswa |
| Best Startup Project | $10.000 | Anda pendiri startup-nya |
| Best Demo | $1.000 | Dari 10% teratas berdasarkan skor Presentation |
| Blog Prize | 2.000 kredit Kiro (100 pemenang) | Blog post publik |
| Social Blitz | 3 bulan Kiro Pro+ (5 pemenang) | Post dengan #KiroweenHackathon26 |

Satu proyek bisa memenangkan satu hadiah Overall **atau** satu hadiah track, ditambah hadiah bonus
berapa pun.

---

## 2. Kelayakan

### ⚠️ Belum terpenuhi

1. **Tema Halloween.** LORE sudah punya genre `horror`, tapi aplikasinya sendiri belum bernuansa
   Halloween.
   - **Tindakan:** misalnya kampanye demo bergenre horror dan sentuhan visual Halloween.
2. **Lisensi open source.** README saat ini berbunyi "Private. All rights reserved".
   - **Tindakan:** pilih lisensi yang disetujui OSI (mis. MIT), lalu tampilkan di bagian About repo.

### ✅ Sudah terpenuhi

- **Dibangun dengan Kiro, dan folder `/.kiro` ada di root repo.**
  - Folder ini berisi specs, hooks, dan steering, dan **tidak boleh** masuk `.gitignore`.
  - Tahap 1 penjurian memeriksa apakah tools yang diwajibkan "dipakai secara wajar". Seberapa ketat
    juri menilai ini belum diketahui.
  - Kriteria *Technical implementation* (20%) juga menilai seberapa baik aplikasi memanfaatkan Kiro.
  - **Tindakan lanjutan:** terus kembangkan di Kiro (specs untuk fitur berikutnya, hooks, steering), dan
    tulis write-up penggunaan Kiro secara jujur.
- **Proyek baru.** Commit pertama repo ini (`6ae9e6d`) tertanggal **8 November 2026**, setelah periode
  submission dibuka 30 Oktober 2026. Ini aman, selama proyeknya memang tidak dimulai sebelum tanggal
  itu di tempat lain.
- **Negara.** Indonesia tidak ada di daftar negara yang dikecualikan.
- **Tim.** Maksimal 3 orang; boleh solo.

### Yang perlu disiapkan untuk submission

- [ ] Repo **GitHub publik** (bukan GitLab/Bitbucket) dengan lisensi OSI dan petunjuk menjalankan aplikasi
- [x] Folder `/.kiro` di root repo (specs, hooks, steering)
- [ ] **Link aplikasi** yang bisa diakses gratis sampai **29 Januari 2027** (sertakan akun uji jika perlu)
- [ ] **Video demo YouTube publik, kurang dari 3 menit**, memperlihatkan aplikasi berjalan; tanpa merek
      dagang pihak ketiga atau musik tanpa lisensi
- [ ] **Deskripsi** fitur dan fungsi aplikasi
- [ ] **Write-up** cara memakai Kiro (spec-driven development, hooks, steering, MCP, custom agents, powers)
- [ ] Semua materi dalam **bahasa Inggris** (atau disertai terjemahan Inggris)
- [ ] Minta **4.000 kredit Kiro gratis** di tab Resources sebelum **1 Desember 2026, 12.00 PT**

---

## 3. Penjurian

- **Tahap 1 (lulus/gagal):** cocok dengan tema Halloween, dan memakai tools yang diwajibkan secara wajar.
- **Tahap 2:** lima kriteria, masing-masing **20%**:
  1. Potential Impact
  2. Technical Implementation (termasuk seberapa baik memakai Kiro)
  3. Design
  4. Innovation / Idea
  5. Presentation

---

## 4. Tanggal penting

| Kegiatan | Waktu (PT) | WIB |
|---|---|---|
| Submission dibuka | 30 Okt 2026, 09.00 PDT | 30 Okt 2026, 23.00 |
| Batas permintaan kredit Kiro | 1 Des 2026, 12.00 PST | 2 Des 2026, 03.00 |
| **Deadline submission** | **4 Des 2026, 14.00 PST** | **5 Des 2026, 05.00** |
| Penjurian | 16 Des 2026 – 29 Jan 2027 | |
| Pengumuman pemenang | ±3 Feb 2027, 09.00 PST | ±4 Feb 2027, 00.00 |

> Satu sumber mencatat deadline 21.00 UTC di tautan kalendernya, sedangkan teksnya menyebut
> 14.00 PST (22.00 UTC). Pastikan di halaman resmi, dan sebaiknya kumpulkan jauh sebelum batas.

---

## 5. Langkah berikutnya (jika ikut lewat track Frankenstein)

1. Siapkan `/.kiro`: steering (konteks proyek, konvensi kode), specs untuk fitur berikutnya, dan hooks
   (mis. menjalankan test atau lint saat file disimpan).
2. Kerjakan fitur berikutnya **di Kiro**, misalnya tanya-jawab dengan karakter berbasis materi atau
   puzzle interaktif di kanvas, supaya penggunaan Kiro nyata dan bisa diceritakan.
3. Tambahkan nuansa Halloween: kampanye demo bergenre horror dan sentuhan visual Halloween.
4. Ganti lisensi ke lisensi OSI, lalu jadikan repo publik.
5. Deploy aplikasi (link yang bisa diakses juri), rekam video demo, dan tulis deskripsi serta write-up
   dalam bahasa Inggris.

---

## Sumber

- [Kiroween 2026 — Devpost (halaman resmi; diblokir untuk akses otomatis)](https://kiroween.devpost.com/)
- [Kiroween 2026 Hackathon: $100,000, Deadline 4 Dec, Rules — ReconScribe](https://reconscribe.com/kiroween-2026-hackathon/)
- [Kiroween 2026: Dates, Prizes and How to Join — LaunchPanda](https://www.launchpanda.dev/vibe-jams/kiroween-2026)
- [Kiroween 2025 — Devpost](https://kiroween-2025.devpost.com/)
