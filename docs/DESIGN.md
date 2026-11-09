# LORE — Design System & UI Guidelines

> **Status:** Draft v1.0  
> **Fokus:** UI utama aplikasi LORE  
> **Tema:** Modern Dark Editorial  
> **Referensi atmosfer:** Reverse: 1999  
> **Target:** Web Application

---

## 1. Design Philosophy

LORE merupakan aplikasi pembelajaran interaktif berbasis cerita atau _interactive visual novel_.

Antarmuka LORE harus mampu membawa pengguna masuk ke dalam sebuah dunia cerita. Pengguna tidak seharusnya merasa sedang menggunakan aplikasi pembelajaran konvensional, melainkan sedang membaca dan menjalani sebuah kisah interaktif.

UI menjadi bagian dari pengalaman bercerita, bukan sekadar wadah untuk menampilkan teks dan pilihan.

### Prinsip desain

1. **Story-driven:** Cerita menjadi pusat perhatian dan elemen utama antarmuka.
2. **Immersive:** UI harus membantu pengguna merasa berada di dalam dunia cerita.
3. **Minimalist:** Hindari elemen visual yang tidak memiliki fungsi.
4. **Modern:** Menggunakan pendekatan desain web modern, bukan meniru tampilan game klasik secara keseluruhan.
5. **Atmospheric:** Menciptakan suasana misterius, privat, dan elegan melalui warna, tipografi, serta komposisi layout.

### Arah visual

Konsep utama LORE adalah:

**Modern Dark Editorial — sebuah aplikasi modern dengan atmosfer dark fantasy yang elegan.**

Reverse: 1999 digunakan sebagai referensi atmosfer dan penyajian cerita, bukan sebagai acuan untuk menyalin desain antarmukanya.

Tema Halloween untuk keperluan hackathon tidak ditampilkan secara eksplisit. Nuansanya harus terasa melalui atmosfer visual, bukan melalui dekorasi Halloween yang literal.

Hindari penggunaan elemen seperti labu, tengkorak, kelelawar, atau dekorasi Halloween berlebihan.

---

## 2. Visual Identity

### 2.1 Atmosfer

Karakter visual yang ingin dibangun:

- Misterius.
- Estetik dan elegan.
- Gelap tetapi tetap nyaman dibaca.
- Modern dan minimalis.
- Memiliki kesan privat, seperti membuka arsip atau memasuki dunia rahasia.

### 2.2 Color Direction

Fondasi warna menggunakan palet gelap dengan aksen warna yang tidak terlalu mencolok.

Palet awal yang direkomendasikan:

| Warna          | Hex       | Penggunaan                   |
| -------------- | --------- | ---------------------------- |
| Obsidian       | `#171719` | Background utama             |
| Dark Plum      | `#30212D` | Variasi background dan panel |
| Muted Burgundy | `#563744` | Aksen dan elemen interaktif  |
| Antique Gold   | `#B49A70` | Aksen dekoratif              |
| Warm Ivory     | `#E5DED2` | Teks utama                   |

Palet ini merupakan rekomendasi awal dan masih dapat disesuaikan selama proses implementasi.

**Panduan penggunaan warna:**

- Background dominan gelap.
- Teks harus memiliki kontras yang cukup.
- Warna aksen digunakan secara terbatas.
- Hindari warna yang terlalu terang atau terlalu jenuh.
- Jangan menjadikan warna aksen sebagai dekorasi di setiap elemen.

### 2.3 Background & Decoration

Background tidak menggunakan gambar PNG atau JPG.

Seluruh dekorasi latar dibuat menggunakan CSS, misalnya:

- Dark gradient.
- Garis-garis tipis.
- Pola geometris sederhana.
- Gradient overlay.
- Ornamen abstrak yang subtil.

Pola visual harus konsisten dari awal hingga akhir cerita agar dunia LORE memiliki identitas visual yang menyatu.

Hindari animasi berlebihan dan dekorasi yang mengganggu fokus membaca.

### 2.4 Typography

Tipografi harus mendukung kesan editorial, misterius, dan modern.

Arah yang diinginkan:

- Tipografi utama mudah dibaca untuk teks cerita yang panjang.
- Judul lokasi, chapter, dan elemen penting boleh menggunakan karakter tipografi yang lebih khas.
- Hierarki ukuran dan ketebalan teks harus jelas.
- Hindari penggunaan terlalu banyak jenis font.

Pilihan font final belum ditentukan.

---

## 3. Application Scope

Dokumen ini hanya membahas antarmuka utama LORE.

Fokus utama terdiri dari dua halaman:

1. **Preparation Page:** Pengguna menyiapkan materi dan menentukan genre cerita.
2. **Main Story Page:** Pengguna membaca dan menjalani cerita interaktif.

Halaman seperti dashboard, autentikasi, profil pengguna, dan fitur di luar pengalaman utama tidak termasuk dalam pembahasan dokumen ini.

---

## 4. Preparation Page

Preparation Page merupakan halaman awal sebelum pengguna memasuki dunia cerita.

Halaman ini digunakan untuk menentukan materi pembelajaran dan genre cerita.

### 4.1 Material Input

Pengguna dapat memasukkan satu dokumen atau materi pembelajaran.

Ketentuan:

- Hanya satu dokumen untuk satu sesi persiapan.
- Pengguna dapat mengunggah dokumen sebagai sumber materi cerita.
- UI perlu menampilkan dokumen yang sudah dipilih.
- Hindari tampilan upload yang terlalu kompleks.

### 4.2 Genre Selection

Pengguna dapat memilih genre cerita.

Genre awal yang tersedia:

- Fantasy
- Non-fiction
- Sci-fi

Genre digunakan untuk menentukan dunia dan atmosfer cerita.

Secara konseptual, ketiga genre dapat memberikan nuansa waktu dan dunia yang berbeda:

- Fantasy: dunia imajinatif dengan nuansa historis atau magis.
- Non-fiction: dunia yang lebih dekat dengan realitas.
- Sci-fi: dunia futuristik dengan teknologi dan konsep masa depan.

Pembagian tersebut merupakan arah konseptual, bukan batasan mutlak untuk sistem pembentukan cerita.

### 4.3 Transition to Story

Setelah materi dan genre ditentukan, pengguna melanjutkan ke proses pembentukan cerita.

Hasil akhirnya adalah sebuah cerita yang dibagi menjadi beberapa chapter.

Setiap chapter memiliki permasalahan atau tantangan tersendiri, tetapi seluruh chapter tetap menjadi bagian dari satu cerita yang saling terhubung.

---

## 5. Main Story Page

Main Story Page merupakan pusat pengalaman LORE.

Seluruh aktivitas membaca cerita, mengikuti dialog, mempelajari materi, dan menyelesaikan tantangan dilakukan di halaman ini.

### 5.1 Overall Layout

Antarmuka utama menggunakan tiga bagian vertikal:

1. Left Sidebar
2. Main Story Area
3. Right Sidebar

Ketiga bagian membentang dari atas hingga bawah layar (_full height layout_).

Pembagian layout:

| Area   | Fungsi                                           |
| ------ | ------------------------------------------------ |
| Kiri   | Sidebar dan navigasi keluar dari cerita          |
| Tengah | Area utama untuk membaca cerita dan berinteraksi |
| Kanan  | Informasi chapter dan progress cerita            |

Area tengah mendapatkan ruang paling besar karena merupakan pusat perhatian pengguna.

### 5.2 Left Sidebar

Sidebar kiri memiliki fungsi navigasi sederhana.

Fungsi utama:

- Menyediakan opsi untuk keluar dari cerita.
- Menjadi elemen navigasi yang selalu tersedia selama pengguna berada di halaman cerita.

Untuk versi awal, belum ada fitur save atau load story.

Karena itu, sidebar tidak perlu memiliki banyak menu atau kontrol tambahan.

### 5.3 Main Story Area

Area tengah menjadi tempat seluruh konten cerita ditampilkan.

Konsep layout menyerupai area membaca artikel atau ruang percakapan, dengan lebar yang cukup untuk membaca teks secara nyaman.

Area ini terdiri dari dua bagian utama:

#### A. Story Header

Header berada di bagian atas area cerita.

Contoh:

**Nom City**

`Dec 13, 1995 · 19:30`

Header menampilkan konteks lokasi dan waktu dalam cerita.

Ketentuan:

- Header selalu terlihat.
- Header tidak ikut bergeser ketika pengguna menggulir isi cerita.
- Konten percakapan berada di bawah header.
- Header berfungsi seperti nama dan informasi kontak pada aplikasi chat.

Informasi lokasi dan waktu dapat berubah mengikuti perkembangan cerita.

#### B. Story Content

Bagian ini menampilkan seluruh narasi dan dialog cerita.

Konten dapat digulir secara vertikal.

Cerita ditampilkan secara berurutan dan membentuk satu alur yang berkelanjutan.

Elemen yang dapat muncul:

- Narasi.
- Dialog karakter.
- Interaksi atau pilihan pemain.
- Tantangan pembelajaran.
- Konsekuensi dari keputusan pemain.

### 5.4 Dialogue Design

Dialog menggunakan pendekatan sederhana seperti chat bubble.

Format dialog:

`(Ekspresi) Nama Karakter`

`Isi dialog karakter.`

Contoh:

`(>_<) Character Name`

`Aku rasa ada sesuatu yang aneh di tempat ini.`

Ketentuan:

- Karakter NPC ditempatkan di sisi kiri.
- Main Character (MC) ditempatkan di sisi kanan.
- Dialog menggunakan bubble dengan border atau rounded corner sederhana.
- Ekspresi karakter ditampilkan menggunakan emoji atau teks sederhana.
- Nama karakter ditampilkan sebelum isi dialog.
- Hindari bubble dengan dekorasi berlebihan.

Narasi memiliki format berbeda dari dialog.

Ketentuan narasi:

- Tidak memerlukan nama karakter.
- Tidak memerlukan ekspresi.
- Ditampilkan secara netral.
- Memiliki perbedaan visual yang cukup jelas dari dialog karakter.

### 5.5 Story Progression

Cerita berjalan secara berurutan.

Namun, tidak semua dialog membutuhkan interaksi pemain.

Pembagian alur:

**Ordinary Dialogue**

- Dialog dan narasi berjalan sebagai bagian dari cerita.
- Tidak perlu menampilkan pilihan jawaban.
- Pengguna membaca dan melanjutkan cerita secara manual.

**Interaction Moment**

- Muncul ketika cerita mencapai permasalahan atau tantangan.
- Pemain diminta memberikan respons atau mengambil keputusan.
- Pilihan ditampilkan sebagai elemen interaktif.

Dengan demikian, pengguna tidak terus-menerus diminta memilih jawaban selama membaca cerita.

Interaksi hanya muncul ketika memang dibutuhkan oleh alur cerita.

### 5.6 Continue Interaction

Tidak menggunakan tombol Continue sebagai kontrol utama.

Sebagai gantinya, pengguna dapat mengklik area cerita atau area chat untuk melanjutkan ke bagian berikutnya.

Prinsip interaksi:

- Pengguna memiliki kontrol atas kecepatan membaca.
- Cerita tidak berjalan otomatis.
- Tidak ada autoplay.
- Pengguna melanjutkan cerita ketika sudah siap.

Ketika pengguna mencapai bagian interaktif, area pilihan menggantikan mekanisme melanjutkan cerita biasa.

### 5.7 Choice Interface

Pilihan pemain muncul dari bagian bawah layar dan bergerak ke atas ketika dibutuhkan.

Pendekatan visual yang diinginkan:

- Pilihan muncul sebagai panel atau elemen yang terpisah dari dialog biasa.
- Transisi slide-up yang sederhana.
- Pilihan mudah dibaca dan diklik.
- Animasi tidak berlebihan.
- Tetap mengikuti identitas visual utama LORE.

Detail tampilan pilihan, termasuk bentuk panel dan jumlah pilihan, masih dapat dikembangkan.

---

## 6. Right Sidebar

Sidebar kanan digunakan untuk menampilkan informasi progress cerita.

Informasi utama yang direncanakan adalah chapter saat ini.

Contoh:

`CHAPTER`

`02 / 03`

Informasi ini membantu pengguna memahami posisi mereka dalam keseluruhan cerita.

Sidebar kanan tidak perlu dipenuhi informasi tambahan.

Untuk versi awal, cukup tampilkan informasi chapter dan progress yang relevan.

---

## 7. Story Structure & Continuity

Satu materi pembelajaran menghasilkan satu cerita yang terdiri dari beberapa chapter.

Setiap chapter memiliki permasalahan atau tantangan yang berbeda.

Namun, seluruh chapter harus terhubung menjadi satu kesatuan cerita.

Contoh struktur:

```text
Campaign
│
├── Chapter 01
│   ├── Story
│   ├── Dialogue
│   └── Problem
│
├── Chapter 02
│   ├── Story
│   ├── Dialogue
│   └── Problem
│
└── Chapter 03
    ├── Story
    ├── Dialogue
    └── Problem
        │
        └── Ending
```

UI harus mendukung pengalaman membaca yang berkelanjutan dari awal hingga akhir cerita.

Perpindahan chapter tidak boleh terasa seperti membuka cerita yang benar-benar berbeda.

---

## 8. Interaction & Navigation Principles

Prinsip interaksi utama:

| Elemen        | Perilaku                             |
| ------------- | ------------------------------------ |
| Story Content | Dapat digulir secara vertikal        |
| Story Header  | Tetap terlihat ketika konten digulir |
| Continue      | Menggunakan klik pada area cerita    |
| Choice        | Muncul ketika ada tantangan          |
| Choice Panel  | Muncul dari bawah                    |
| Left Sidebar  | Menyediakan opsi keluar              |
| Right Sidebar | Menampilkan informasi chapter        |

### Reading Experience

LORE menggunakan pendekatan manual reading.

Pengguna menentukan sendiri kapan ingin melanjutkan cerita.

Tidak ada:

- Autoplay dialog.
- Autoplay narasi.
- Perpindahan cerita tanpa tindakan pengguna.

Tujuannya adalah memberikan ruang bagi pengguna untuk memahami materi dan menikmati cerita.

---

## 9. Design Constraints

Beberapa batasan desain yang perlu dijaga:

1. Jangan menggunakan background gambar PNG/JPG.
2. Jangan menggunakan dekorasi Halloween secara literal dan berlebihan.
3. Jangan menggunakan animasi yang mengganggu pengalaman membaca.
4. Jangan memenuhi sidebar dengan fitur yang belum diperlukan.
5. Jangan membuat UI menyerupai aplikasi pembelajaran konvensional.
6. Jangan membuat interaksi muncul pada setiap dialog.
7. Jangan menggunakan autoplay untuk melanjutkan cerita.
8. Jangan mengorbankan keterbacaan demi estetika.

---

## 10. Design Decisions & Future Improvements

Dokumen ini merupakan fondasi awal desain UI LORE. Beberapa keputusan sudah ditetapkan, sedangkan detail visual lainnya dapat dikembangkan selama implementasi.

### Sudah ditentukan

- [x] Fokus desain pada Preparation Page dan Main Story Page.
- [x] Arah visual Modern Dark Editorial.
- [x] Atmosfer misterius, privat, gelap, dan estetik.
- [x] Tidak menggunakan dekorasi Halloween secara literal.
- [x] Background menggunakan CSS.
- [x] Main Story Page menggunakan tiga kolom.
- [x] Ketiga kolom membentang dari atas hingga bawah.
- [x] Header cerita selalu terlihat.
- [x] Konten cerita dapat digulir.
- [x] Dialog menggunakan chat bubble sederhana.
- [x] NPC di kiri dan MC di kanan.
- [x] Narasi tidak menggunakan format dialog karakter.
- [x] Cerita dilanjutkan secara manual dengan klik area cerita.
- [x] Pilihan interaksi muncul dari bawah.
- [x] Sidebar kiri memiliki navigasi keluar.
- [x] Sidebar kanan menampilkan chapter progress.

### Masih dapat dikembangkan

- [ ] Font final.
- [ ] Warna final dan design tokens.
- [ ] Ukuran dan proporsi ketiga kolom.
- [ ] Detail ikon dan ornamen sidebar.
- [ ] Bentuk dan animasi chat bubble.
- [ ] Desain panel pilihan.
- [ ] Detail transisi antar-chapter.
- [ ] Responsive layout untuk tablet dan mobile.
- [ ] Loading, error, dan empty states.
- [ ] Accessibility dan keyboard navigation.

---

## 11. Closing Design Direction

LORE harus terasa seperti sebuah ruang cerita digital yang elegan dan misterius.

Pengguna membuka materi, memasuki sebuah dunia, bertemu karakter, membaca narasi, menghadapi permasalahan, dan menyelesaikan perjalanan mereka.

Antarmuka tidak perlu terus-menerus menarik perhatian pengguna.

Justru, UI yang baik adalah UI yang membuat pengguna fokus pada cerita tanpa melupakan atmosfer dunia yang sedang mereka jalani.

**The interface is not the story. It is the doorway into the story.**
