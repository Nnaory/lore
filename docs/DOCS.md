# LORE — Project Documentation

> **Learn by Living the Knowledge.**
>
> LORE adalah web-based interactive learning visual novel yang mengubah materi pembelajaran menjadi petualangan naratif. Pemain mempelajari konsep melalui cerita, menghadapi masalah yang membutuhkan pemahaman materi, membuat keputusan, dan mengalami konsekuensi dari pilihannya.

**Document Type:** Product & Technical Architecture  
**Project:** LORE  
**Platform:** Web Application  
**Framework:** Next.js  
**Language:** TypeScript  
**AI Integration:** Provider abstraction — dummy provider active (real LLM integration deferred)  
**Current Scope:** Core Game Logic MVP + AI Layer 1 & 2 (dummy-first)  
**Document Status:** Implementation-aligned architecture & roadmap (reconciled after Milestone 8)

---

# 1. Project Overview

## 1.1. What is LORE?

LORE adalah aplikasi pembelajaran berbasis cerita interaktif.

Pengguna memberikan satu atau beberapa materi pembelajaran. Sistem kemudian memproses materi tersebut menjadi sebuah campaign yang terdiri dari beberapa cerita yang saling berhubungan.

Setiap cerita berfokus pada satu materi pembelajaran.

Pemain berperan sebagai karakter utama (MC) dan menjalani dunia yang dibentuk berdasarkan materi tersebut.

Pemain tidak hanya membaca penjelasan atau menjawab pertanyaan. Mereka akan:

1. Menjelajahi cerita.
2. Berinteraksi dengan karakter.
3. Menemukan informasi dan konsep pembelajaran.
4. Menghadapi permasalahan dalam dunia cerita.
5. Memilih solusi berdasarkan pemahaman materi.
6. Mengalami konsekuensi dari keputusan.
7. Belajar dari kesalahan dan mencoba kembali.
8. Melanjutkan petualangan ke materi berikutnya.

**Core Philosophy:**

> Pemain tidak sedang membaca cerita tentang seseorang yang belajar. Pemain sedang menjalani sebuah cerita dan belajar karena harus menghadapi masalah di dalamnya.

## 1.2. Product Principles

LORE harus mempertahankan prinsip berikut:

- **Story-driven learning:** cerita menjadi media utama pembelajaran.
- **Learning before testing:** konsep harus diperkenalkan sebelum diuji.
- **Meaningful decisions:** pilihan harus memiliki konsekuensi.
- **Retry and learn:** pemain boleh salah, tetapi harus memperoleh kesempatan belajar dan mencoba kembali.
- **Academic accuracy:** kebenaran akademik tidak boleh dikorbankan demi kreativitas cerita.
- **Persistent campaign:** keputusan dan kondisi dari cerita sebelumnya dapat memengaruhi cerita berikutnya.
- **Deterministic gameplay:** aturan permainan dijalankan oleh game engine, bukan diserahkan sepenuhnya kepada AI.

## 1.3. What LORE Is Not

LORE bukan:

- Quiz application dengan tampilan game.
- AI chatbot yang hanya menjelaskan materi.
- Generator cerita biasa.
- Visual novel yang tidak memiliki sistem pembelajaran.
- Game yang hanya memberikan skor tanpa mengukur pemahaman.

---

# 2. MVP Scope

Pengembangan awal difokuskan pada logika utama permainan.

## 2.1. Included in MVP

| Feature              | Description                                               |
| -------------------- | --------------------------------------------------------- |
| Material input       | Pengguna memasukkan materi pembelajaran                   |
| AI material analysis | AI mengekstrak konsep dan tujuan belajar                  |
| Genre selection      | Pengguna menentukan genre cerita                          |
| Campaign planning    | AI merancang hubungan antarcerita                         |
| Story generation     | AI menghasilkan cerita per materi                         |
| Scene rendering      | Aplikasi menampilkan narasi dan dialog                    |
| Character dialogue   | Dialog karakter dengan format visual novel                |
| Choice system        | Pemain memilih tindakan atau jawaban                      |
| Puzzle system        | Tantangan berdasarkan materi                              |
| Consequence system   | Respons cerita berdasarkan jawaban                        |
| HP system            | Setiap cerita memiliki 5 HP                               |
| Retry system         | Pemain dapat mencoba kembali                              |
| Campaign state       | Status cerita dan keputusan disimpan selama sesi          |
| Learning evaluation  | Sistem mencatat bukti pemahaman                           |
| Ending system        | Cerita memiliki penyelesaian dan campaign memiliki epilog |

## 2.2. Not Included in MVP

Fitur berikut tidak perlu diimplementasikan dahulu:

- User registration.
- Login dan authentication.
- Database persistence.
- Cloud save.
- User profile.
- Subscription dan payment.
- Multiplayer.
- Public story sharing.
- Community features.
- Real-time AI-generated images.
- Character customization yang kompleks.

Arsitektur boleh menyediakan tempat untuk fitur tersebut di masa depan, tetapi jangan membuat implementasinya sekarang.

## 2.3. Technology Stack

| Area                  | Technology                     |
| --------------------- | ------------------------------ |
| Application           | Next.js                        |
| Language              | TypeScript                     |
| UI                    | React                          |
| Styling               | CSS / Tailwind CSS             |
| API                   | Next.js Route Handlers         |
| AI                    | External LLM API               |
| Validation            | Zod                            |
| Game state            | TypeScript state management    |
| Temporary persistence | Browser session / local state  |
| Testing               | Vitest / React Testing Library |

Tidak diperlukan backend Python terpisah pada MVP.

Next.js akan menangani frontend sekaligus server-side API integration.

---

# 3. Overall Application Architecture

LORE memiliki empat bagian utama:

1. Presentation Layer
2. AI Generation Layer
3. Game Logic Layer
4. Session State Layer

## 3.1. High-Level Architecture

```text
                  USER
                    |
                    v
          +---------------------+
          |     NEXT.JS APP     |
          +---------------------+
                    |
          +---------+----------+
          |                    |
          v                    v
  PRESENTATION LAYER     GAME SESSION
  - Story display       - Current story
  - Dialog textbox      - Current scene
  - Choice buttons      - HP
  - Status display      - Campaign state
  - Puzzle interface   - Player knowledge
          |                    |
          |                    |
          v                    v
          +--------------------+
                    |
                    v
             GAME ENGINE
          - Scene controller
          - Choice resolver
          - Consequence handler
          - HP manager
          - Retry manager
          - Story transition
                    |
                    |
                    v
             AI GENERATION
          - Material analysis
          - Campaign planning
          - Story generation
          - Scene generation
                    |
                    v
              LLM API
```

## 3.2. Responsibility Separation

### Presentation Layer

Bertanggung jawab terhadap tampilan dan interaksi pemain.

Tidak boleh menentukan sendiri apakah jawaban benar atau salah.

### AI Generation Layer

Bertanggung jawab menghasilkan konten dan struktur cerita.

AI tidak boleh menjadi satu-satunya pihak yang mengontrol status permainan.

### Game Logic Layer

Bertanggung jawab menjalankan aturan permainan.

Contohnya:

- Memeriksa jawaban.
- Mengurangi HP.
- Menampilkan konsekuensi.
- Mengatur percobaan ulang.
- Menentukan perpindahan scene.
- Mengubah campaign state.

### Session State Layer

Menyimpan kondisi permainan sementara selama campaign berjalan.

Untuk MVP, penyimpanan dapat menggunakan state aplikasi dan mekanisme session/local persistence yang sederhana.

Tidak memerlukan database.

---

# 4. AI Generation Architecture

AI generation merupakan bagian penting LORE.

Namun, kita tidak akan meminta AI membuat seluruh permainan dalam satu prompt.

Kita menggunakan pendekatan multi-stage generation.

Setiap layer memiliki tanggung jawab, input, output, dan kontrak data yang jelas.

## 4.1. AI Pipeline

```text
USER MATERIALS
      |
      v
+-------------------------+
| LAYER 1                 |
| Material Intelligence   |
+-------------------------+
      |
      v
Material Blueprints
      |
      v
+-------------------------+
| LAYER 2                 |
| Campaign Planner        |
+-------------------------+
      |
      v
Campaign Blueprint
      |
      v
+-------------------------+
| LAYER 3                 |
| Story Generator         |
+-------------------------+
      |
      v
Story Blueprint
      |
      v
+-------------------------+
| LAYER 4                 |
| Scene & Content Builder |
+-------------------------+
      |
      v
Validated Game Content
      |
      v
+-------------------------+
| GAME ENGINE             |
| Deterministic Execution |
+-------------------------+
      |
      v
PLAYER EXPERIENCE
```

Layer 4 dapat digabungkan dengan proses Layer 3 pada implementasi awal. Pemisahan tersebut menunjukkan tanggung jawab sistem, bukan kewajiban membuat empat model AI terpisah.

## 4.2. Layer 1 — Material Intelligence

**Purpose:** memahami materi pembelajaran sebelum cerita dibuat.

Input:

- Satu atau beberapa dokumen atau teks materi.
- Pengaturan pembelajaran jika tersedia.

Tugas AI:

1. Mengidentifikasi topik utama.
2. Mengekstrak konsep penting.
3. Mengidentifikasi definisi dan prinsip.
4. Mengekstrak rumus atau metode.
5. Mengidentifikasi hubungan antar-konsep.
6. Menentukan tujuan pembelajaran.
7. Mengidentifikasi contoh penerapan.
8. Mengidentifikasi kemungkinan miskonsepsi.
9. Menentukan prasyarat pemahaman.
10. Mencatat batas informasi yang tersedia.

AI tidak boleh menciptakan fakta akademik yang tidak didukung materi.

Output: `MaterialBlueprint`.

Contoh struktur:

```json
{
  "material_id": "material_01",
  "title": "Linear Algebra",
  "summary": "Introduction to vector operations.",
  "learning_objectives": [
    "Understand linear combinations",
    "Understand vector span"
  ],
  "concepts": [
    {
      "concept_id": "concept_01",
      "name": "Linear Combination",
      "definition": "A combination of vectors using scalar coefficients.",
      "principles": ["Vectors can be scaled", "Scaled vectors can be added"],
      "methods": ["Solve for scalar coefficients"],
      "prerequisites": [],
      "misconceptions": [
        "Confusing vector addition with scalar multiplication"
      ],
      "source_evidence": ["Relevant extracted passage"]
    }
  ],
  "scope_limitations": []
}
```

Output harus berupa JSON terstruktur yang dapat divalidasi aplikasi.

## 4.3. Layer 2 — Campaign Planner

**Purpose:** merancang keseluruhan perjalanan cerita.

Layer ini menerima seluruh MaterialBlueprint sekaligus.

Misalnya pengguna memasukkan tiga materi:

- Material 1.
- Material 2.
- Material 3.

AI harus memahami ketiganya sebelum menentukan cerita.

Tugas:

1. Menentukan urutan pembelajaran.
2. Menentukan hubungan antar-materi.
3. Menentukan prasyarat konsep.
4. Menentukan campaign premise.
5. Membentuk dunia cerita.
6. Membentuk konflik utama.
7. Membuat karakter dan motivasi.
8. Menentukan genre dan atmosfer.
9. Menentukan cerita untuk setiap materi.
10. Merancang kemungkinan jalur keputusan.
11. Menentukan konsekuensi jangka panjang.
12. Menentukan hubungan antara ending setiap cerita.

Output: `CampaignBlueprint`.

### 4.3.1. Implementasi Aktual (M8 — Dummy-First)

> Status: **implemented (M8)**. Real LLM campaign planning is **deferred**.
> The active implementation is a deterministic planner behind the same
> `ICampaignPlannerProvider` interface a future real provider must implement.

Pipeline:

```text
PlanCampaignRequest
  |
  v
PlanCampaignRequestSchema (Zod)
  |
  v
ICampaignPlannerProvider (dummy)
  |
  v
Deterministic planning engine
  |
  v
CampaignBlueprintSchema -> planner semantic validator
  |
  v
PlanCampaignResult { ok, blueprint, meta }
```

Aturan perencanaan yang ditegakkan:

1. **One material → one story.** Setiap materi input menghasilkan tepat satu
   entri `story_sequence`. Materi yang hilang atau terduplikasi ditolak.
2. **Global `concept_id` uniqueness.** Seluruh materi dalam satu request harus
   memiliki `concept_id` yang unik. Duplikasi → `DUPLICATE_CONCEPT_ID`.
3. **Urutan lintas materi.** Urutan cerita ditentukan oleh topological sort atas
   edge prasyarat konsep lintas materi. Tie-break memakai urutan input agar
   deterministik. Siklus prasyarat → `PREREQUISITE_CYCLE`.
4. **`required_knowledge` hanya dari cerita sebelumnya.** Prasyarat konsep dari
   materi yang sama atau materi setelahnya tidak pernah dimasukkan.
5. **Determinisme penuh.** Tidak ada `Date.now()` di dalam engine, tidak ada
   `Math.random()`, tidak ada network. Input tidak pernah dimutasi.

Catatan penting: fixture legacy (`dummyCampaign`) memiliki dua cerita pada satu
materi (`material_01`). Aturan one-material-one-story **hanya** berlaku untuk
Campaign Planner. Validator legacy (`validateCampaign`) dan fixture lama tidak
diubah; aturan planner diisolasi di `planner-validator.ts`.

Peringatan non-blocking `PREREQUISITE_TESTABILITY_PENDING` dilampirkan pada
setiap prasyarat turunan, karena apakah sebuah konsep dapat benar-benar
di-`demonstrated` baru bisa dipastikan setelah Layer 3 menghasilkan puzzle.

Contoh:

```json
{
  "campaign_id": "campaign_001",
  "title": "The Last Beacon",
  "genre": "fantasy",
  "premise": "A world where ancient systems are collapsing.",
  "main_conflict": "The central beacon is losing its power.",
  "characters": [],
  "world_rules": [],
  "story_sequence": [
    {
      "story_id": "story_01",
      "material_id": "material_01",
      "purpose": "Introduce the first learning concepts",
      "main_conflict": "The first beacon is unstable",
      "required_knowledge": [],
      "outcomes": []
    },
    {
      "story_id": "story_02",
      "material_id": "material_02",
      "purpose": "Build upon previous knowledge",
      "main_conflict": "A second system has failed",
      "required_knowledge": ["concept_01"],
      "outcomes": []
    },
    {
      "story_id": "story_03",
      "material_id": "material_03",
      "purpose": "Resolve the campaign conflict",
      "main_conflict": "The final beacon must be restored",
      "required_knowledge": [],
      "outcomes": []
    }
  ]
}
```

Campaign Planner tidak perlu menulis seluruh dialog.

Fokusnya adalah kesinambungan cerita dan hubungan antar-materi.

## 4.4. Layer 3 — Story Generator

**Purpose:** membuat satu cerita berdasarkan campaign blueprint.

Layer ini dipanggil untuk setiap materi.

Contoh:

- Story Generator 1 membuat cerita pertama.
- Story Generator 2 membuat cerita kedua.
- Story Generator 3 membuat cerita ketiga.

Setiap pemanggilan menerima:

- MaterialBlueprint yang sesuai.
- CampaignBlueprint.
- Story bible.
- Story sebelumnya.
- Campaign state.
- Pengaturan panjang dan tingkat kesulitan.

Output: `StoryBlueprint`.

Setiap cerita memiliki:

- Premis lokal.
- Chapter.
- Scene.
- Karakter yang terlibat.
- Dialog.
- Narasi.
- Informasi pembelajaran.
- Puzzle.
- Pilihan jawaban.
- Jawaban benar.
- Penjelasan.
- Konsekuensi.
- Kondisi perpindahan scene.
- Ending state.

### Story Continuity

Cerita berikutnya tidak boleh dibuat tanpa mempertimbangkan cerita sebelumnya.

Namun, tidak perlu mengirim seluruh percakapan sebelumnya.

Gunakan:

1. CampaignBlueprint.
2. Story bible.
3. Previous story summary.
4. Campaign state.
5. Next MaterialBlueprint.

Dengan cara ini, cerita tetap konsisten tanpa mengirim terlalu banyak token.

## 4.5. Layer 4 — Scene & Content Builder

**Purpose:** mengubah struktur cerita menjadi konten yang siap ditampilkan.

Layer ini dapat menjadi bagian dari Story Generator dalam MVP.

Tugas:

- Menyiapkan narasi.
- Menyiapkan dialog karakter.
- Menyiapkan informasi pembelajaran.
- Menyiapkan puzzle.
- Menyiapkan pilihan.
- Menyiapkan consequence content.
- Menyiapkan transisi antar-scene.

Semua output harus mengikuti schema yang ditentukan aplikasi.

### AI Content vs Game Execution

Pemisahan ini wajib dipertahankan.

AI bertanggung jawab atas:

- Apa yang terjadi dalam cerita.
- Apa masalah yang dihadapi.
- Apa pilihan pemain.
- Mengapa jawaban benar.
- Bagaimana karakter merespons.
- Apa konsekuensi naratif.

Game engine bertanggung jawab atas:

- Apakah pilihan benar.
- Pengurangan HP.
- Perpindahan scene.
- Pengulangan puzzle.
- Pencatatan keputusan.
- Perubahan status.
- Penentuan kapan cerita selesai.

Jangan meminta AI menjadi game engine.

---

# 5. Genre System

LORE tidak terkunci pada genre fantasi.

Genre merupakan konfigurasi yang memengaruhi cara AI membangun dunia.

## 5.1. Default Genres

| Genre              | Description                                  |
| ------------------ | -------------------------------------------- |
| Fantasy            | Magic, kingdoms, ancient mysteries           |
| Modern / Realistic | Contemporary real-world setting              |
| Science Fiction    | Futuristic technology and exploration        |
| Mystery            | Investigation and hidden information         |
| Historical         | Historical-inspired environments             |
| Survival           | Resource management and difficult situations |
| Horror             | Suspense, danger, and psychological tension  |
| Custom             | User-defined genre                           |

## 5.2. Genre Configuration

Contoh:

```json
{
  "genre": "science_fiction",
  "tone": "mysterious",
  "setting": "abandoned_research_station",
  "story_style": "character_driven",
  "custom_instructions": ""
}
```

Genre harus memengaruhi:

- Worldbuilding.
- Character design.
- Conflict.
- Narrative atmosphere.
- Dialogue style.
- Types of challenges.

Genre tidak boleh mengubah kebenaran akademik.

Materi fisika tetap harus benar meskipun ceritanya berlatar dunia fantasi.

---

# 6. Campaign and Story Structure

## 6.1. Campaign Concept

Campaign adalah satu rangkaian petualangan yang terdiri dari beberapa cerita.

Satu campaign dapat memiliki beberapa materi pembelajaran.

Contoh:

```text
CAMPAIGN
|
+-- STORY 01: Material A
|     |
|     +-- Introduction
|     +-- Learning Scene
|     +-- Puzzle
|     +-- Consequence
|     +-- Story Ending
|
+-- STORY 02: Material B
|     |
|     +-- Introduction
|     +-- Learning Scene
|     +-- Puzzle
|     +-- Consequence
|     +-- Story Ending
|
+-- STORY 03: Material C
      |
      +-- Introduction
      +-- Learning Scene
      +-- Puzzle
      +-- Consequence
      +-- Story Ending
```

Satu materi menghasilkan satu cerita utama.

Untuk MVP, jumlah cerita mengikuti jumlah materi yang dimasukkan pengguna.

## 6.2. Branching System

Setiap cerita dapat memiliki beberapa jalur keputusan.

Contoh:

```text
                  START
                    |
                    v
                SCENE 01
                    |
              PLAYER CHOICE
              /     |      \
             A      B       C
             |      |       |
          ROUTE A ROUTE B ROUTE C
             |      |       |
             +------+-------+
                    |
                    v
                SCENE 02
                    |
                    v
                  ENDING
```

Ketiga jalur dapat kembali bertemu.

Namun, konsekuensi pilihan tetap disimpan.

Contohnya:

- Route A membuat karakter mempercayai MC.
- Route B membuat MC kehilangan sumber daya.
- Route C membuka informasi tambahan.

Ketika jalur bertemu kembali, kondisi dunia tetap berbeda.

Tidak perlu membuat seluruh kombinasi jalur menjadi cerita yang benar-benar terpisah.

Gunakan prinsip **branch and reconverge** untuk mengontrol kompleksitas.

## 6.3. Story Length

Panjang cerita tidak harus selalu sama.

Namun, untuk MVP, gunakan batas konfigurasi yang masuk akal.

Contoh:

- 3–5 chapter per cerita.
- Beberapa scene per chapter.
- Satu atau lebih puzzle yang relevan dengan materi.
- Satu ending utama dengan variasi kondisi.

Jumlah puzzle dan scene ditentukan berdasarkan materi dan kompleksitasnya.

Jangan memaksakan jumlah puzzle jika materi tidak mendukungnya.

---

# 7. Main Gameplay Loop

Ini merupakan logika permainan paling utama.

**Satu cerita memiliki alur:**

```text
STORY INTRODUCTION
        |
        v
NARRATIVE SCENES
        |
        v
LEARNING MATERIAL
        |
        v
PUZZLE / CHALLENGE
        |
        v
PLAYER ANSWER
        |
        v
ANSWER VALIDATION
        |
   +----+----+
   |         |
 CORRECT   INCORRECT
   |         |
   v         v
 STORY     HP - 1
 CONTINUE    |
   |         v
   |    CONSEQUENCE
   |    + FEEDBACK
   |    + CORRECT ANSWER
   |    + EXPLANATION
   |         |
   |         v
   |      RETRY?
   |         |
   |    +----+----+
   |    |         |
   |  RETRY     EXIT
   |    |
   |    v
   |   PUZZLE
   |    |
   +----+
        |
        v
   STORY ENDING
        |
        v
   NEXT STORY
```

## 7.1. Story Introduction

Pemain memasuki cerita.

Sistem menampilkan:

- Judul cerita.
- Premis.
- Lokasi.
- Karakter.
- Narasi pembuka.
- Dialog awal.

Tidak ada puzzle sebelum pemain memperoleh konteks yang diperlukan.

## 7.2. Narrative Scenes

Pemain membaca cerita melalui kombinasi:

- Narasi.
- Dialog.
- Informasi lingkungan.
- Interaksi karakter.
- Penemuan objek atau dokumen.

Cerita harus mengalir seperti visual novel.

Dialog menjadi media utama interaksi.

Format karakter:

```text
Eldric (¬_¬): "Kau datang pada waktu yang buruk."

MC (o_o): "Apa yang sebenarnya terjadi?"
```

Narasi tidak menggunakan nama karakter.

Contoh:

```text
Angin dingin melewati lorong batu. Cahaya dari
lentera mulai meredup ketika kalian mendekati
ruangan utama.
```

## 7.3. Learning Scene

Sebelum puzzle, pemain harus memiliki informasi yang cukup.

Informasi dapat diperoleh melalui:

- Dialog NPC.
- Dokumen.
- Eksperimen.
- Observasi.
- Penemuan.
- Penjelasan dalam cerita.

Informasi harus mengajarkan prinsip, bukan langsung membocorkan jawaban puzzle.

## 7.4. Puzzle / Challenge

Puzzle merupakan masalah yang harus diselesaikan MC dalam konteks dunia cerita.

Puzzle harus:

- Berhubungan dengan materi.
- Memiliki jawaban yang dapat divalidasi.
- Menguji pemahaman, bukan sekadar hafalan jika memungkinkan.
- Memiliki penjelasan akademik.
- Tidak membutuhkan pengetahuan yang belum diperkenalkan.

Format puzzle:

```json
{
  "puzzle_id": "puzzle_01",
  "concept_ids": ["concept_01"],
  "narrative_context": "The beacon requires a specific combination of crystals.",
  "question": "Which combination can restore the beacon?",
  "choices": [
    {
      "choice_id": "A",
      "text": "Use one crystal from each source.",
      "is_correct": false
    },
    {
      "choice_id": "B",
      "text": "Use two units from source A and one from source B.",
      "is_correct": true
    },
    {
      "choice_id": "C",
      "text": "Use only source B.",
      "is_correct": false
    }
  ],
  "correct_choice_id": "B",
  "explanation": "The combination produces the required vector.",
  "learning_reference": "concept_01",
  "retry_allowed": true
}
```

Aplikasi tidak boleh mempercayai teks jawaban dari AI tanpa validasi schema dan pemeriksaan konsistensi.

---

# 8. Consequence and Learning Feedback System

## 8.1. Core Rule

Pemain boleh salah.

Namun, setiap kesalahan harus menjadi kesempatan belajar.

**Pemain harus tetap memiliki kesempatan untuk mencapai jawaban yang benar.**

Kesalahan tidak boleh langsung membuat pemain kehilangan seluruh progress campaign.

## 8.2. Incorrect Answer Flow

Ketika pemain memilih jawaban yang salah:

1. Sistem memvalidasi jawaban.
2. HP berkurang satu.
3. Sistem menampilkan reaksi cerita.
4. Sistem menjelaskan mengapa jawaban tersebut salah.
5. Sistem memberikan jawaban yang benar.
6. Sistem menjelaskan alasan jawaban benar.
7. Pemain mendapatkan kesempatan mencoba kembali.

Contoh:

```text
[MC] (o_o): "Mungkin kita harus menggunakan
kristal yang pertama saja."

Eldric (ಠ_ಠ): "Tidak. Energinya tidak cukup."

Cahaya kristal meredup. Sebagian energi yang
terkumpul menghilang.

[LEARNING FEEDBACK]

Jawaban tersebut belum tepat.

Kombinasi yang benar adalah pilihan B.

Alasannya:
Kristal A memberikan kontribusi (2,1),
sedangkan kristal B memberikan kontribusi (1,2).

Untuk mencapai target (5,4), diperlukan
2 unit A dan 1 unit B.

[HP: 4/5]

[Coba Lagi]
```

Penting: konsekuensi naratif boleh berbeda berdasarkan jawaban, tetapi feedback akademik harus tetap benar.

## 8.3. Correct Answer Flow

Ketika pemain memilih jawaban yang benar:

1. Sistem memvalidasi jawaban.
2. Tidak ada pengurangan HP.
3. Sistem menampilkan reaksi karakter.
4. Cerita berlanjut.
5. Sistem mencatat bukti pemahaman.
6. Status campaign diperbarui jika diperlukan.

Contoh:

```text
Eldric (o_o): "Kau berhasil!"

Kristal mulai menyala. Energi mengalir menuju
pusat beacon.

[LEARNING FEEDBACK]

Benar. Kombinasi tersebut menghasilkan
target yang diperlukan.

[Continue]
```

## 8.4. Feedback Principles

Feedback harus menjelaskan:

- Apakah jawaban benar atau salah.
- Mengapa pilihan tersebut salah atau benar.
- Prinsip materi yang relevan.
- Bagaimana cara berpikir yang benar.

Feedback tidak boleh sekadar mengatakan "Wrong!" atau "Correct!".

Feedback dapat disampaikan melalui karakter agar tetap menyatu dengan cerita.

---

# 9. HP System

Setiap cerita memiliki HP sendiri.

**Initial HP: 5**

HP merupakan resource yang merepresentasikan kesempatan pemain dalam menyelesaikan tantangan cerita.

## 9.1. Rules

| Event            |            HP Change |
| ---------------- | -------------------: |
| Story begins     |             Set to 5 |
| Correct answer   |                    0 |
| Incorrect answer |                   -1 |
| Story completed  | No further deduction |
| New story begins |           Reset to 5 |

HP tidak dibawa dari satu cerita ke cerita lainnya.

Setiap cerita dimulai dengan lima HP.

## 9.2. HP States

```text
5 HP = Full
4 HP = Minor mistake
3 HP = Moderate mistakes
2 HP = Critical
1 HP = Last chance
0 HP = Story failed
```

HP tidak dimaksudkan untuk menghukum pemain karena belum memahami materi.

HP hanya menambahkan tekanan dan konsekuensi pada permainan.

## 9.3. HP Reaches Zero

Jika HP mencapai nol:

Pemain memasuki kondisi `STORY_FAILED`.

Sistem menampilkan:

- Reaksi cerita.
- Ringkasan kesalahan.
- Penjelasan materi yang relevan.
- Pilihan untuk mengulang cerita atau keluar dari cerita.

Pilihan:

**Retry Story**

- Mengulang cerita dari awal.
- HP kembali menjadi 5.
- Progress cerita yang gagal di-reset.
- Campaign state dari cerita yang sudah selesai sebelumnya tetap dipertahankan.

**Exit Story**

- Keluar dari cerita.
- Kembali ke halaman campaign atau menu.
- Campaign belum dianggap selesai.
- Tidak boleh membuka cerita berikutnya sebelum cerita saat ini berhasil diselesaikan.

Penting: retry harus mengulang state cerita, bukan menghapus seluruh campaign.

---

# 10. Campaign State Management

Campaign state menyimpan kondisi yang perlu dibawa dari satu cerita ke cerita berikutnya.

Contoh:

```json
{
  "campaign_id": "campaign_001",
  "current_story_id": "story_02",
  "completed_stories": ["story_01"],
  "world_state": {
    "stability": 65,
    "resources": 40
  },
  "relationships": {
    "eldric": 75,
    "lyra": 30
  },
  "major_decisions": [
    {
      "decision_id": "choice_01_03",
      "result": "trusted_eldric"
    }
  ],
  "player_knowledge": {
    "concept_01": {
      "status": "developing",
      "evidence": ["puzzle_01_correct_after_retry"]
    }
  }
}
```

## 10.1. Campaign State Responsibilities

State harus menyimpan:

- Cerita yang sudah selesai.
- Cerita yang sedang berjalan.
- Keputusan penting.
- Status dunia.
- Hubungan karakter.
- Pengetahuan pemain.
- Ringkasan hasil cerita.

Tidak semua dialog perlu disimpan.

Simpan hanya informasi yang diperlukan untuk menjaga konsistensi cerita dan evaluasi pembelajaran.

## 10.2. Story State vs Campaign State

Keduanya harus dipisahkan.

**Story State:**

- HP cerita saat ini.
- Scene saat ini.
- Chapter saat ini.
- Puzzle aktif.
- Percobaan pemain.
- Status cerita.

**Campaign State:**

- Cerita yang sudah selesai.
- Status dunia secara keseluruhan.
- Keputusan jangka panjang.
- Hubungan karakter.
- Bukti pemahaman lintas cerita.

Ketika pemain mengulang cerita:

- Story State di-reset.
- Campaign State dari cerita sebelumnya tetap aman.

---

# 11. Learning Progression

LORE tidak boleh menganggap pemain langsung memahami materi hanya karena berhasil mencapai akhir cerita.

Sistem perlu mencatat bukti pemahaman.

## 11.1. Knowledge Evidence

Setiap puzzle memiliki referensi ke satu atau beberapa konsep.

Ketika pemain menyelesaikan puzzle, sistem mencatat:

- Concept ID.
- Jawaban pertama.
- Jumlah percobaan.
- Apakah jawaban akhirnya benar.
- Apakah jawaban benar setelah feedback.
- Jenis kesalahan.
- Penjelasan yang sudah diberikan.

Contoh:

```json
{
  "concept_id": "concept_01",
  "attempts": [
    {
      "attempt": 1,
      "answer": "A",
      "correct": false
    },
    {
      "attempt": 2,
      "answer": "B",
      "correct": true
    }
  ],
  "final_result": "correct_after_feedback",
  "understanding_status": "developing"
}
```

## 11.2. Knowledge Status

Status awal yang dapat digunakan:

- `not_introduced`
- `introduced`
- `developing`
- `demonstrated`

Definisi:

| Status         | Meaning                                        |
| -------------- | ---------------------------------------------- |
| Not introduced | Konsep belum diajarkan                         |
| Introduced     | Konsep sudah diperkenalkan                     |
| Developing     | Pemain masih membutuhkan feedback              |
| Demonstrated   | Pemain menunjukkan pemahaman melalui tantangan |

Sistem tidak boleh memberikan status `demonstrated` hanya karena pemain menebak jawaban benar setelah mendapatkan jawaban dan penjelasan.

## 11.3. Learning Evaluation

Di akhir campaign, sistem merangkum:

- Konsep yang sudah dipelajari.
- Konsep yang berhasil diterapkan.
- Kesalahan yang sering terjadi.
- Konsep yang membutuhkan latihan tambahan.
- Perkembangan pemahaman dari cerita pertama hingga terakhir.

Evaluasi harus berdasarkan bukti yang benar-benar dicatat.

---

# 12. Main Game State Machine

Game engine harus memiliki state yang eksplisit.

Contoh:

```text
CAMPAIGN_SETUP
      |
      v
CAMPAIGN_GENERATING
      |
      v
STORY_INTRO
      |
      v
NARRATIVE
      |
      v
LEARNING_SCENE
      |
      v
PUZZLE_ACTIVE
      |
      v
ANSWER_VALIDATION
      |
   +--+--+
   |     |
 WRONG  RIGHT
   |     |
   v     v
FEEDBACK STORY_CONTINUE
   |
   v
RETRY_AVAILABLE
   |
   +----> PUZZLE_ACTIVE

STORY_CONTINUE
      |
      v
STORY_ENDING
      |
      +---- More stories?
      |        |
      |        v
      |    NEXT_STORY
      |
      v
CAMPAIGN_ENDING
      |
      v
FINAL_EVALUATION
      |
      v
CAMPAIGN_COMPLETE
```

Additional failure state:

```text
PUZZLE_ACTIVE
      |
      v
ANSWER_WRONG
      |
      v
HP_DECREASED
      |
      +---- HP > 0 ---> FEEDBACK ---> RETRY
      |
      +---- HP = 0 ---> STORY_FAILED
                              |
                         +----+----+
                         |         |
                       RETRY      EXIT
```

## 12.1. Important State Rules

- Tidak boleh menjawab puzzle ketika story state tidak berada di `PUZZLE_ACTIVE`.
- Tidak boleh mengurangi HP dua kali untuk satu jawaban.
- Tidak boleh mengirim jawaban yang sama berulang kali akibat double click.
- Jawaban benar tidak boleh menyebabkan HP berkurang.
- Puzzle yang sudah selesai tidak boleh diselesaikan lagi.
- Cerita berikutnya tidak boleh dibuka sebelum cerita saat ini selesai.
- Campaign tidak boleh dinyatakan selesai sebelum seluruh cerita selesai.
- Retry tidak boleh menghapus progress cerita sebelumnya.

---

# 13. Story Content Data Contract

Semua konten AI harus mengikuti schema yang dapat dibaca aplikasi.

Contoh struktur utama:

```json
{
  "story_id": "story_01",
  "material_id": "material_01",
  "title": "The Last Beacon",
  "summary": "The first part of the campaign.",
  "characters": [],
  "chapters": [
    {
      "chapter_id": "chapter_01",
      "title": "The Fading Light",
      "scenes": [
        {
          "scene_id": "scene_01",
          "type": "narrative",
          "location": "Old Lighthouse",
          "characters_present": ["eldric"],
          "content": [
            {
              "type": "narration",
              "text": "The lighthouse begins to lose its light."
            },
            {
              "type": "dialogue",
              "character_id": "eldric",
              "expression": "worried",
              "text": "Something is wrong with the beacon."
            }
          ],
          "next_scene_id": "scene_02"
        },
        {
          "scene_id": "scene_02",
          "type": "learning",
          "content": []
        },
        {
          "scene_id": "scene_03",
          "type": "puzzle",
          "puzzle_id": "puzzle_01"
        }
      ]
    }
  ],
  "puzzles": [],
  "endings": [],
  "continuity_summary": {},
  "knowledge_mapping": []
}
```

## 13.1. Scene Types

Scene dapat memiliki beberapa tipe:

| Type          | Purpose                              |
| ------------- | ------------------------------------ |
| `narrative`   | Narasi dan dialog                    |
| `learning`    | Penyampaian konsep                   |
| `interaction` | Interaksi dengan karakter atau objek |
| `puzzle`      | Tantangan pembelajaran               |
| `consequence` | Respons setelah pilihan              |
| `ending`      | Penyelesaian cerita                  |

## 13.2. Content Validation

Semua respons AI harus:

1. Berupa JSON valid.
2. Memiliki field wajib.
3. Memiliki ID yang unik dalam konteksnya.
4. Menggunakan tipe scene yang dikenal.
5. Menggunakan referensi karakter yang valid.
6. Menggunakan referensi puzzle yang valid.
7. Memiliki jawaban benar yang tersedia.
8. Memiliki penjelasan untuk setiap puzzle.
9. Memiliki transisi scene yang valid.
10. Tidak memiliki referensi ke scene yang tidak ada.

Gunakan Zod untuk validasi.

Jika respons AI tidak valid, sistem harus menangani kegagalan dengan aman. Jangan langsung menjalankan konten yang tidak tervalidasi.

---

# 14. Next.js Application Architecture

LORE akan dibangun menggunakan Next.js.

Tidak ada backend Python terpisah pada MVP.

## 14.1. Architecture Principles

- UI tidak boleh mengandung logika game yang kompleks.
- Game engine tidak boleh bergantung langsung pada komponen React.
- AI API calls harus dilakukan dari server.
- AI response harus divalidasi sebelum digunakan.
- Session state harus terpisah dari tampilan.
- Seluruh gameplay harus dapat diuji tanpa memanggil AI API.

## 14.2. Proposed Directory Structure

```text
lore/
|
+-- public/
|   +-- assets/
|   +-- backgrounds/
|   +-- characters/
|
+-- src/
|   |
|   +-- app/
|   |   +-- page.tsx
|   |   +-- campaign/
|   |   |   +-- page.tsx
|   |   +-- game/
|   |   |   +-- page.tsx
|   |   +-- api/
|   |       +-- ai/
|   |           +-- analyze-material/
|   |           |   +-- route.ts
|   |           +-- plan-campaign/
|   |           |   +-- route.ts
|   |           +-- generate-story/
|   |           |   +-- route.ts
|   |           +-- generate-scene/
|   |               +-- route.ts
|   |
|   +-- components/
|   |   +-- setup/
|   |   +-- story/
|   |   +-- dialogue/
|   |   +-- puzzle/
|   |   +-- feedback/
|   |   +-- status/
|   |   +-- campaign/
|   |
|   +-- lib/
|   |   |
|   |   +-- ai/
|   |   |   +-- client.ts
|   |   |   +-- prompts/
|   |   |   |   +-- material-analysis.ts
|   |   |   |   +-- campaign-planner.ts
|   |   |   |   +-- story-generator.ts
|   |   |   |   +-- scene-generator.ts
|   |   |   +-- schemas/
|   |   |   +-- validators/
|   |   |
|   |   +-- game/
|   |   |   +-- engine.ts
|   |   |   +-- scene-manager.ts
|   |   |   +-- choice-resolver.ts
|   |   |   +-- consequence-manager.ts
|   |   |   +-- hp-manager.ts
|   |   |   +-- retry-manager.ts
|   |   |   +-- story-manager.ts
|   |   |   +-- campaign-manager.ts
|   |   |   +-- knowledge-manager.ts
|   |   |
|   |   +-- state/
|   |   |   +-- game-state.ts
|   |   |   +-- campaign-state.ts
|   |   |   +-- story-state.ts
|   |   |   +-- session-store.ts
|   |   |
|   |   +-- types/
|   |   |   +-- material.ts
|   |   |   +-- campaign.ts
|   |   |   +-- story.ts
|   |   |   +-- scene.ts
|   |   |   +-- puzzle.ts
|   |   |   +-- game.ts
|   |   |
|   |   +-- utils/
|   |
|   +-- hooks/
|   |
|   +-- styles/
|
+-- tests/
|   +-- game/
|   +-- ai/
|   +-- schemas/
|
+-- docs/
|
+-- .env.example
+-- package.json
+-- tsconfig.json
+-- next.config.ts
+-- DOCS.md
```

Direktori ini merupakan rancangan awal. Tidak semua file harus dibuat pada hari pertama.

Buat struktur secara bertahap mengikuti roadmap.

---

# 15. AI Integration (Dummy-First)

> Status: **M7 and M8 implemented with a deterministic dummy provider.**
> No AI SDK is installed. No external API calls are made. No API key is required.

## 15.1. Provider Configuration

The application talks to AI layers exclusively through provider interfaces:

| Layer | Interface                          | Active implementation                  |
| ----- | ---------------------------------- | -------------------------------------- |
| 1     | `IMaterialIntelligenceProvider`    | `DummyProvider` (`dummy-v1`)           |
| 2     | `ICampaignPlannerProvider`         | `DummyCampaignPlannerProvider` (`dummy-planner-v1`) |

Configuration via environment variables (`.env.example`):

```env
AI_PROVIDER=dummy

# Reserved for future real providers — NOT used in M7/M8.
# AI_API_KEY=your_api_key_here
# AI_MODEL=your_model_name
# AI_MAX_TOKENS=4000
```

Selection rules:

- `AI_PROVIDER` unset or `dummy` → dummy provider.
- Unknown value → fallback to dummy with a `console.warn`. Never crashes.
- Real provider values (`openai`, `anthropic`, `google`) are **reserved and
  unimplemented**; they currently fall back to dummy.

API keys, when a real provider is eventually added, must stay server-side only:

- Not in client components.
- Not in `NEXT_PUBLIC_*` variables.
- Not in browser storage.
- Not committed to source.

All AI requests must go through server-side Route Handlers.

## 15.2. API Routes

| Route                           | Responsibility                     | Status      |
| ------------------------------- | ---------------------------------- | ----------- |
| `POST /api/ai/analyze-material` | Layer 1 — Material Intelligence     | Implemented |
| `POST /api/ai/plan-campaign`    | Layer 2 — Campaign Planner          | Implemented |
| `POST /api/ai/generate-story`   | Layer 3 — Story Generation          | Not built   |
| `POST /api/ai/generate-scene`   | Layer 4 — Scene Generation (opt.)   | Not built   |

Shared envelope (both implemented routes):

```ts
// success
{ ok: true, data: { blueprint, meta } }
// failure
{ ok: false, error: { code, message, detail? } }
```

`POST /api/ai/plan-campaign` status codes:

| Status | Condition                                                        |
| ------ | ---------------------------------------------------------------- |
| 200    | Blueprint produced and validated                                  |
| 400    | Malformed request (`INVALID_REQUEST`)                             |
| 422    | Semantically invalid input (`DUPLICATE_MATERIAL_ID`, `DUPLICATE_CONCEPT_ID`, `INVALID_PREREQUISITE_REF`, `PREREQUISITE_CYCLE`, `REQUIRED_KNOWLEDGE_ORDER`) |
| 502    | Upstream provider output invalid (`OUTPUT_PARSE_FAILED`, `VALIDATION_FAILED`) |
| 500    | Unexpected internal error (`UNKNOWN`, `PROVIDER_UNAVAILABLE`)      |

Route handlers validate input, invoke the service, validate output with Zod,
and return structured data. The game engine never sees provider details.
Secrets, stack traces, and provider internals are never exposed.

## 15.3. Error Handling

Handled conditions:

- Provider unavailable / not configured.
- Provider output not valid JSON or fails schema validation.
- Planner-semantic violations (duplicate IDs, cycles, unusable prerequisites).
- Invalid or malformed request body.
- Unexpected provider exceptions (contained by the service, never propagated).

Expected failures are always returned as structured results — never thrown.
A failed AI call is not a game failure; existing player progress is preserved.

---

# 16. User Flow

## 16.1. Campaign Creation

```text
OPEN APPLICATION
      |
      v
CREATE NEW CAMPAIGN
      |
      v
ADD LEARNING MATERIALS
      |
      v
SELECT GENRE
      |
      v
SET CAMPAIGN OPTIONS
      |
      v
ANALYZE MATERIALS
      |
      v
REVIEW MATERIAL BLUEPRINT
      |
      v
GENERATE CAMPAIGN
      |
      v
GENERATE STORY 01
      |
      v
START ADVENTURE
```

## 16.2. Gameplay Flow

```text
STORY INTRO
    |
    v
READ SCENE
    |
    v
LEARN CONCEPT
    |
    v
SOLVE PUZZLE
    |
    v
RECEIVE CONSEQUENCE
    |
    v
RETRY UNTIL CORRECT
    |
    v
CONTINUE STORY
    |
    v
STORY ENDING
    |
    v
NEXT MATERIAL
```

## 16.3. Campaign Completion

Setelah seluruh cerita selesai:

1. Tampilkan final scene.
2. Tampilkan epilog.
3. Tampilkan ringkasan keputusan.
4. Tampilkan kondisi dunia.
5. Tampilkan hubungan karakter.
6. Tampilkan perkembangan pemahaman.
7. Tampilkan konsep yang masih perlu dipelajari.
8. Tampilkan kesimpulan campaign.

---

# 17. Development Roadmap

Roadmap dibagi menjadi beberapa milestone.

Prioritasnya adalah memastikan game engine bekerja sebelum mengintegrasikan AI secara penuh.

## Milestone 0 — Project Foundation

**Goal:** menyiapkan fondasi Next.js.

Tasks:

- [x] Membuat Next.js project.
- [x] Mengaktifkan TypeScript.
- [x] Menyiapkan styling.
- [x] Membuat struktur direktori dasar.
- [x] Menyiapkan environment variable.
- [x] Menyiapkan linting.
- [x] Menyiapkan testing.
- [x] Membuat halaman utama sederhana.

Deliverable:

Next.js application yang dapat dijalankan secara lokal.

## Milestone 1 — Core Types and Data Contracts

**Goal:** menentukan struktur data utama LORE.

Tasks:

- [x] Membuat MaterialBlueprint type.
- [x] Membuat CampaignBlueprint type.
- [x] Membuat StoryBlueprint type.
- [x] Membuat Scene type.
- [x] Membuat Puzzle type.
- [x] Membuat CampaignState type.
- [x] Membuat StoryState type.
- [x] Membuat Zod schemas.
- [x] Membuat sample JSON untuk pengujian.

Deliverable:

Seluruh struktur data utama sudah ditentukan dan dapat divalidasi.

## Milestone 2 — Story Viewer and Dialogue System

**Goal:** menampilkan cerita seperti visual novel.

Tasks:

- [x] Membuat story container.
- [x] Membuat narrative renderer.
- [x] Membuat dialogue renderer.
- [x] Membuat character name dan expression.
- [x] Membuat textbox.
- [x] Membuat continue interaction.
- [x] Membuat scene transition.
- [x] Membuat character display sederhana.
- [x] Membuat dummy story JSON.

Deliverable:

Pemain dapat membaca dan menjalankan cerita statis tanpa AI.

## Milestone 3 — Puzzle and Choice System

**Goal:** membuat sistem tantangan yang berfungsi.

Tasks:

- [x] Membuat puzzle component.
- [x] Menampilkan pilihan jawaban.
- [x] Membuat choice resolver.
- [x] Memvalidasi jawaban.
- [x] Menangani jawaban benar.
- [x] Menangani jawaban salah.
- [x] Membuat learning feedback.
- [x] Membuat consequence display.
- [x] Membuat retry flow.

Deliverable:

Pemain dapat menyelesaikan puzzle dengan konsekuensi yang sesuai.

## Milestone 4 — HP and Story Failure System

**Goal:** mengimplementasikan sistem HP.

Tasks:

- [x] HP awal 5.
- [x] Mengurangi HP ketika jawaban salah.
- [x] Tidak mengurangi HP ketika jawaban benar.
- [x] Membuat HP indicator.
- [x] Membuat STORY_FAILED state.
- [x] Membuat retry story.
- [x] Membuat exit story.
- [x] Memastikan retry tidak menghapus campaign sebelumnya.

Deliverable:

Sistem HP dan pengulangan cerita berfungsi.

## Milestone 5 — Campaign and State Management

**Goal:** menghubungkan beberapa cerita dalam satu campaign.

Tasks:

- [x] Membuat campaign manager.
- [x] Membuat story manager.
- [x] Memisahkan StoryState dan CampaignState.
- [x] Menyimpan keputusan penting.
- [x] Membuat story transition.
- [x] Membuat HP reset per cerita.
- [x] Membuat previous story summary.
- [x] Membuat next story initialization.
- [x] Membuat campaign completion.

Deliverable:

Tiga cerita dummy dapat dijalankan berurutan dengan status yang saling terhubung.

## Milestone 6 — Learning Progression

**Goal:** mencatat pemahaman pemain.

Tasks:

- [x] Membuat knowledge manager.
- [x] Menghubungkan puzzle dengan concept ID.
- [x] Mencatat setiap percobaan.
- [x] Mencatat kesalahan.
- [x] Mencatat jawaban benar setelah feedback.
- [x] Menentukan knowledge status.
- [x] Membuat learning summary.

Deliverable:

Sistem dapat menunjukkan perkembangan pemahaman pemain.

## Milestone 7 — AI Layer 1: Material Intelligence

**Goal:** mengubah materi menjadi blueprint terstruktur.

**Status:** selesai (dummy-first). Real LLM integration ditunda.

Tasks:

- [x] Membuat `IMaterialIntelligenceProvider` dan tipe request/response.
- [x] Membuat `DummyProvider` deterministik (`dummy-v1`).
- [x] Membuat Zod schema `MaterialBlueprint` + parser output.
- [x] Memvalidasi output dan menangani kegagalan provider.
- [x] Membuat semantic validator untuk MaterialBlueprint.
- [x] Membuat service `analyzeMaterial()`.
- [x] Membuat `POST /api/ai/analyze-material`.
- [x] Menguji beberapa jenis materi.
- [ ] Menyiapkan AI API client nyata (ditunda).
- [ ] Mengirim materi ke LLM eksternal (ditunda).

Deliverable:

Materi pengguna dapat diubah menjadi MaterialBlueprint melalui provider dummy
yang deterministik, dengan antarmuka siap untuk provider nyata di masa depan.

## Milestone 8 — AI Layer 2: Campaign Planner

**Goal:** membuat rancangan campaign dari beberapa materi.

**Status:** selesai (dummy-first). Real LLM campaign planning ditunda.

Tasks:

- [x] Membuat `ICampaignPlannerProvider` dan `PlanCampaignRequestSchema`.
- [x] Membuat deterministic planning engine (topological ordering).
- [x] Menegakkan one-material-one-story.
- [x] Menegakkan global `concept_id` uniqueness.
- [x] Menurunkan `required_knowledge` lintas materi.
- [x] Mendeteksi siklus dan referensi prasyarat tidak valid.
- [x] Membuat `planner-validator.ts` (terisolasi dari `validateCampaign`).
- [x] Membuat `DummyCampaignPlannerProvider` (`dummy-planner-v1`).
- [x] Membuat campaign output parser + service `planCampaign()`.
- [x] Membuat `POST /api/ai/plan-campaign`.
- [x] Menambahkan fixture materi planner dan integration test ke game engine.
- [ ] Menyiapkan campaign planner prompt nyata (ditunda).
- [ ] Menghasilkan konten campaign dengan LLM (ditunda).

Deliverable:

Satu `CampaignBlueprint` valid dan deterministik dapat dihasilkan dari beberapa
materi, dan langsung dapat dikonsumsi game engine tanpa perubahan pada engine.

## Milestone 9 — AI Layer 3 and 4: Story Generation

**Goal:** menghasilkan cerita yang siap dimainkan.

Tasks:

- [ ] Menyiapkan story generator prompt.
- [ ] Menghasilkan cerita pertama.
- [ ] Menghasilkan chapter dan scene.
- [ ] Menghasilkan dialog dan narasi.
- [ ] Menghasilkan learning scene.
- [ ] Menghasilkan puzzle.
- [ ] Menghasilkan jawaban dan feedback.
- [ ] Menghasilkan consequence content.
- [ ] Menghasilkan continuity summary.
- [ ] Menguji generasi cerita kedua dan ketiga.

Deliverable:

Campaign hasil AI dapat dimainkan menggunakan game engine.

## Milestone 10 — Integration and Testing

**Goal:** mengintegrasikan seluruh sistem.

Tasks:

- [ ] Menghubungkan campaign creation dengan AI.
- [ ] Menghubungkan story generation dengan game engine.
- [ ] Menguji gameplay dari awal hingga akhir.
- [ ] Menguji jawaban salah.
- [ ] Menguji retry puzzle.
- [ ] Menguji HP mencapai nol.
- [ ] Menguji retry story.
- [ ] Menguji perpindahan antarcerita.
- [ ] Menguji konsistensi campaign.
- [ ] Menguji error handling AI.
- [ ] Menguji berbagai genre.

Deliverable:

MVP LORE dapat menjalankan satu campaign dari beberapa materi sampai epilog.

## Milestone 11 — Final Polish

**Goal:** meningkatkan pengalaman pengguna.

Tasks:

- [ ] Memperbaiki tampilan textbox.
- [ ] Memperbaiki alur dialog.
- [ ] Menambahkan transisi scene.
- [ ] Memperbaiki indikator HP.
- [ ] Memperbaiki tampilan puzzle.
- [ ] Menambahkan loading states.
- [ ] Menambahkan error states.
- [ ] Memperbaiki responsive layout.
- [ ] Menyiapkan demo campaign.

Deliverable:

MVP siap didemonstrasikan.

---

# 18. Testing Strategy

Testing harus dimulai sebelum AI diintegrasikan.

Gunakan dummy data untuk memastikan game engine bekerja dengan benar.

## 18.1. Core Game Logic Tests

| Test                 | Expected Result                      |
| -------------------- | ------------------------------------ |
| Start story          | HP = 5                               |
| Correct answer       | HP tidak berubah                     |
| Wrong answer         | HP berkurang 1                       |
| Wrong answer at 1 HP | HP menjadi 0                         |
| HP reaches 0         | STORY_FAILED                         |
| Retry story          | HP kembali 5                         |
| Retry story          | Story state di-reset                 |
| Retry story          | Previous campaign progress tetap ada |
| Complete story       | Next story dapat dibuka              |
| Complete final story | Campaign complete                    |

## 18.2. AI Validation Tests

- Output JSON valid.
- Semua scene memiliki ID.
- Semua puzzle memiliki jawaban benar.
- Semua puzzle memiliki explanation.
- Semua referensi scene valid.
- Semua referensi karakter valid.
- Semua concept ID berasal dari blueprint.
- Tidak ada materi yang tidak didukung sumber.
- Cerita berikutnya menerima continuity data.

## 18.3. End-to-End Scenario

Skenario minimum:

1. User membuat campaign dengan tiga materi.
2. User memilih genre.
3. AI menghasilkan blueprint.
4. AI menghasilkan tiga cerita.
5. User memulai cerita pertama.
6. User membuat kesalahan.
7. HP berkurang.
8. Feedback memberikan jawaban benar dan penjelasan.
9. User mencoba lagi dan menjawab benar.
10. Cerita berlanjut hingga selesai.
11. Cerita kedua dimulai dengan HP 5.
12. Keputusan cerita pertama memengaruhi cerita kedua.
13. Cerita ketiga selesai.
14. Campaign menampilkan epilog dan evaluasi pembelajaran.

---

# 19. Future Architecture — After MVP

Fitur berikut baru dipertimbangkan setelah core gameplay stabil.

## Authentication

- User registration.
- Login.
- User profile.

## Database

- User data.
- Campaign storage.
- Story storage.
- Game progress.
- Learning history.

## Persistence

- Save campaign.
- Resume campaign.
- Multiple campaigns.
- Campaign history.

## Advanced AI

- Adaptive dialogue.
- Free-form player actions.
- NPC question answering.
- Dynamic scene generation.
- Personalized learning difficulty.

## Visual Expansion

- Reusable character portraits.
- Character expressions.
- Background illustrations.
- Scene atmosphere.
- Simple animation.

## More Advanced Learning

- Adaptive puzzle difficulty.
- Spaced repetition.
- Cross-campaign knowledge.
- More detailed learning analytics.

Semua fitur ini harus mengikuti arsitektur yang sudah dibuat, bukan memaksa game engine dibangun ulang.

---

# 20. Critical Design Decisions

Keputusan berikut menjadi pegangan selama pengembangan MVP.

| Decision          | Rule                                        |
| ----------------- | ------------------------------------------- |
| Framework         | Next.js only                                |
| Backend           | Next.js server-side routes                  |
| Language          | TypeScript                                  |
| AI integration    | API key through environment variables       |
| AI architecture   | Multi-stage generation                      |
| Campaign          | Multiple connected stories                  |
| Story structure   | One main story per material                 |
| Branching         | Branch and reconverge                       |
| Gameplay          | Narrative → Learning → Puzzle → Consequence |
| Wrong answer      | HP -1                                       |
| Feedback          | Must explain the correct answer             |
| Retry puzzle      | Allowed                                     |
| Initial HP        | 5 per story                                 |
| HP at zero        | Retry story or exit                         |
| Retry story       | Reset current story only                    |
| Next story        | HP resets to 5                              |
| Game execution    | Deterministic game engine                   |
| AI responsibility | Generate content and structured plans       |
| Database          | Not implemented in MVP                      |
| Authentication    | Not implemented in MVP                      |
| Testing           | Dummy data before AI integration            |

---

# 21. Final MVP Definition

LORE MVP dianggap berhasil ketika pengguna dapat:

1. Membuka web app.
2. Memasukkan beberapa materi pembelajaran.
3. Memilih genre.
4. Memproses materi menggunakan AI.
5. Membuat satu campaign yang terdiri dari beberapa cerita.
6. Memulai cerita pertama.
7. Membaca narasi dan dialog.
8. Mempelajari konsep melalui cerita.
9. Menyelesaikan puzzle.
10. Mendapatkan konsekuensi ketika salah.
11. Melihat jawaban benar beserta penjelasannya.
12. Kehilangan HP akibat jawaban salah.
13. Mengulang puzzle sampai berhasil.
14. Mengulang cerita ketika HP habis.
15. Melanjutkan cerita berikutnya.
16. Membawa konsekuensi cerita sebelumnya.
17. Menyelesaikan seluruh campaign.
18. Melihat epilog dan evaluasi pembelajaran.

**The most important success criterion:**

LORE harus benar-benar terasa seperti sebuah petualangan interaktif yang mengajarkan sesuatu, bukan aplikasi kuis yang dibungkus dengan cerita.

---

# 22. Development Starting Point

> **Status:** Milestone 0–8 selesai. Milestone 9–11 belum dikerjakan.

Pengembangan mengikuti urutan milestone. Integrasi AI nyata **belum** dilakukan:
M7 dan M8 diimplementasikan dengan provider dummy deterministik di balik
interface provider yang sama dengan yang akan dipakai provider nyata.

Urutan prioritas:

1. Foundation. ✅
2. Data contracts. ✅
3. Story viewer. ✅
4. Puzzle system. ✅
5. Consequence system. ✅
6. HP and retry. ✅
7. Campaign state. ✅
8. Learning progression. ✅
9. AI Layer 1 & 2 (dummy-first). ✅
10. AI Layer 3 & 4 (story generation). ⏳
11. End-to-end testing. ⏳
12. Polish. ⏳

**Next target:** Milestone 9 — Story Generation (Layer 3), mengikuti pola yang
sama: kontrak tipe → engine/parser → provider dummy → service → API route →
integration test. Real LLM tetap ditunda sampai pola dummy terbukti stabil.

---

**End of LORE Documentation**
