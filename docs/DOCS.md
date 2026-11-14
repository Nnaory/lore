# LORE — Product & Technical Architecture Documentation (v2 Overhaul)

> **Learn by Living the Knowledge.**
>
> LORE adalah *web-based interactive learning visual novel* yang mengubah topik atau materi pembelajaran menjadi petualangan naratif beranimasi. Pemain mempelajari konsep melalui penjelasan karakter dan visualisasi **Remotion**, menghadapi konflik dunia cerita melalui kanvas interaktif, dan membuktikan pemahaman mereka untuk melanjutkan perjalanan.

**Document Type:** Product & Technical Architecture Specification (v2 Overhaul)  
**Frontend Stack:** Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, `@remotion/player`, Zod  
**Backend AI Orchestrator:** Python 3.12, FastAPI, LangChain, LangGraph, Pydantic v2  
**Architecture Status:** Transitioning from v1 (Next.js Dummy-First Monolith) to v2 (3-Pane Remotion Stage + Python LangGraph Orchestrator)

---

# 1. Core Philosophy & Product Principles

## 1.1. What Makes LORE Different?
Pengguna tidak sekadar membaca rangkuman materi atau mengerjakan kuis pilihan ganda biasa. Di dalam LORE:
1. **Scoped & Tailored Curriculum:** Sebelum materi dibuat, AI berdialog (*grilling*) dengan pengguna jika topik yang diminta terlalu luas untuk jumlah chapter yang dipilih.
2. **NotebookLM-Style Deep Preparation:** Setelah cakupan materi dikunci, sistem menjalankan proses latar belakang (*background synthesis*) untuk merancang alur cerita, dialog karakter, animasi visual, dan tantangan interaktif.
3. **3-Pane Synchronized Experience:**
   - **Character (`char`):** Karakter dengan ekspresi dan gerakan yang hidup saat menjelaskan konsep atau bereaksi terhadap keputusan pemain.
   - **Interactive Canvas (`@remotion/player`):** Visualisasi terprogram yang bergerak selaras dengan penjelasan karakter, lalu berhenti (*pause*) pada momen konflik agar pemain dapat berinteraksi langsung di atas kanvas.
   - **Dialogue & Free Inquiry (`chat` + `type something`):** Kotak dialog dengan kontrol kecepatan (`fast | animate`), riwayat percakapan (`log chat`), dan input bebas (`type something`) untuk bertanya langsung kepada karakter saat ada konsep yang belum jelas.

## 1.2. Non-Negotiable Pedagogical Rules (Dipertahankan dari Visi Awal)
- **Story-Driven Learning:** Pembelajaran adalah bagian dari konflik dunia cerita, bukan tempelan di luar cerita.
- **Learning Before Testing:** Setiap konsep wajib diperkenalkan dan divisualisasikan sebelum diuji dalam tantangan/puzzle.
- **Academic Accuracy:** Kreativitas cerita dan genre tidak boleh mengubah kebenaran rumus, definisi, atau prinsip akademik.
- **Retry & Learn with Consequences:** Setiap chapter/cerita memiliki **5 HP**. Jawaban atau tindakan yang salah mengurangi 1 HP, memicu reaksi visual/naratif serta penjelasan akademik, dan mengizinkan pemain mencoba kembali.
- **Evidence-Based Mastery (`demonstrated` vs `developing`):** Status pemahaman konsep (`not_introduced` $\rightarrow$ `introduced` $\rightarrow$ `developing` $\rightarrow$ `demonstrated`) dicatat berdasarkan bukti percobaan nyata lintas sesi *retry*.
- **Deterministic Game Rules:** AI menghasilkan konten dan skema animasi, tetapi evaluasi kebenaran puzzle, pengurangan HP, dan status kelulusan chapter dieksekusi secara deterministik oleh *game engine*.

---

# 2. High-Level System Architecture (v2)

Karena tingkat kedalaman fitur baru—mulai dari *stateful grilling*, *parallel chapter generation*, hingga pembuatan skema animasi Remotion dan *live chat*—Next.js tidak lagi digunakan sebagai AI orchestrator. Orkestrasi AI dipisahkan ke layanan **Python (FastAPI + LangChain + LangGraph)**.

```text
                             USER (Browser)
                                   │
                                   ▼
+----------------------------------------------------------------------+
|                FRONTEND CLIENT (Next.js 16 + React 19)               |
|                                                                      |
|  [Page 1: Preparation & Grilling UI]                                 |
|   - Topic/Material Input + Chapter Count Config                      |
|   - Interactive Grilling Chat (Scope Narrowing)                      |
|   - Credit Simulator Preview & Background Job Progress (SSE)         |
|                                                                      |
|  [Page 2: 3-Pane Main Stage]                                         |
|   ├── Navbar (Chapter Progress, HP 5/5, Simulated Credits, Exit)     |
|   ├── Left Pane: Character Stage (Emotion & Gesture State Machine)   |
|   ├── Right Pane: @remotion/player Canvas (Animates & Pauses)        |
|   └── Bottom Pane: Dialogue Stream, [fast|animate], [type something] |
|                                                                      |
|  [Deterministic Game Engine (TypeScript)]                            |
|   - Beat/Scene Controller, HP Manager, Knowledge Tracker, Validators |
+----------------------------------+-----------------------------------+
                                   │
                  HTTP REST + Server-Sent Events (SSE)
                  (Lightweight JSON Payloads — No MP4s)
                                   │
+----------------------------------▼-----------------------------------+
|          BACKEND AI ORCHESTRATOR (Python + FastAPI + LangGraph)      |
|                                                                      |
|  +----------------------------------------------------------------+  |
|  | Graph 1: Scope & Grilling Workflow (Stateful + HITL Interrupt) |  |
|  +----------------------------------------------------------------+  |
|                                  │                                   |
|  +-------------------------------▼--------------------------------+  |
|  | Credit Calculation & Simulation Engine                         |  |
|  +-------------------------------┬--------------------------------+  |
|                                  │                                   |
|  +-------------------------------▼--------------------------------+  |
|  | Graph 2: NotebookLM-Style Campaign Synthesis (Async + Send)    |  |
|  |  - Material Concept Extractor                                  |  |
|  |  - Curriculum & Narrative Chapter Planner (Topological Order)  |  |
|  |  - Parallel Chapter Generators (Script + Remotion + Puzzles)   |  |
|  |  - Pydantic & Graph Integrity Validator                        |  |
|  +-------------------------------┬--------------------------------+  |
|                                  │                                   |
|  +-------------------------------▼--------------------------------+  |
|  | Graph 3: In-Stage Live Tutor/Character Responder               |  |
|  |  - Handles "type something" queries with Beat & Concept Context|  |
|  +----------------------------------------------------------------+  |
+----------------------------------------------------------------------+
```

---

# 3. End-to-End Workflow & LangGraph Pipelines

## 3.1. Phase 1: Input, Chapter Config & AI Scope Grilling (`Graph 1`)

Ketika pengguna memasukkan topik atau materi di layar `learn something?` beserta target jumlah chapter $N_{\text{chapters}}$:

1. **`ScopeAnalyzerNode`:**
   - Menganalisis keluasan topik/dokumen dan mengestimasi jumlah konsep inti ($N_{\text{concepts}}$) yang dibutuhkan agar materi dapat dipahami secara utuh.
   - Menghitung rasio kepadatan: $\text{Density} = \frac{N_{\text{concepts}}}{N_{\text{chapters}}}$.
2. **Conditional Edge (`should_grill`):**
   - Jika $\text{Density}$ berada dalam batas ideal (misal $\le 3$ konsep per chapter) dan topik sudah spesifik $\rightarrow$ lanjut ke **Credit Preview & Approval**.
   - Jika topik terlalu luas atau ambigu untuk jumlah chapter yang diminta $\rightarrow$ masuk ke **`GrillerNode`**.
3. **`GrillerNode` (Human-in-the-Loop via LangGraph `interrupt`):**
   - Menghasilkan pertanyaan klarifikasi beserta 2–4 opsi penyempitan ruang lingkup (misal: *"Topik 'Machine Learning' terlalu luas untuk 2 chapter. Apakah kamu ingin fokus pada (A) Regresi & Klasifikasi Dasar, (B) Cara Kerja Neural Network, atau (C) menaikkan jumlah chapter menjadi 5?"*).
   - Menghentikan eksekusi graph sementara (`interrupt`) dan menunggu respons pengguna sebelum mengevaluasi ulang di `ScopeAnalyzerNode`.

---

## 3.2. Phase 2: Credit Simulation Engine

Sebelum *background process* dijalankan, sistem menghitung simulasi biaya *credit* secara transparan.

> **Default Credit Formula (Initial v2 Baseline — Configurable):**
> - **Base Material Analysis:** $5\text{ credits}$
> - **Chapter Generation Cost:** $15\text{ credits} \times N_{\text{chapters}}$
> - **Interactive Remotion Canvas Cost:** $10\text{ credits} \times N_{\text{puzzles}}$
> - **Live Question (`type something`) Cost:** $2\text{ credits}$ per pertanyaan bebas saat bermain.

Manfaat desain ini:
- Pengguna melihat dampak langsung dari hasil *grilling*: mempersempit topik atau menyesuaikan jumlah chapter akan mengubah jumlah *credit* yang dibutuhkan.
- Saat bermain, pengguna menggunakan fitur chat bebas (`type something`) dengan bijak karena setiap pertanyaan di luar alur utama memiliki biaya *credit* simulasi.

---

## 3.3. Phase 3: NotebookLM-Style Background Synthesis (`Graph 2`)

Setelah pengguna menyetujui ruang lingkup dan estimasi *credit*, backend menjalankan *asynchronous background job* di LangGraph dan mengirimkan progresnya ke frontend melalui **Server-Sent Events (SSE)**:

1. **`ConceptExtractionNode` (Layer 1):**
   Mengekstrak daftar `Concept` lengkap dengan `definition`, `principles`, `prerequisites`, `misconceptions`, dan `source_evidence`.
2. **`CurriculumPlannerNode` (Layer 2):**
   - Mengurutkan konsep secara topologis berdasarkan prasyarat (`prerequisites`).
   - Membagi konsep ke dalam $N_{\text{chapters}}$ yang diminta pengguna.
   - Merancang premis cerita utama, aturan dunia, dan profil karakter pendamping (`Character`).
3. **`ParallelChapterGeneratorNode` (Layer 3 — Fan-out via LangGraph `Send`):**
   Dijalankan secara paralel untuk setiap chapter:
   - **Narrative & Character Script:** Menulis rangkaian *beat* cerita (narasi, teks dialog, serta `character_state` berupa ekspresi dan gestur).
   - **Remotion Choreography:** Menyusun spesifikasi JSON untuk kanvas `@remotion/player` pada setiap *beat* (komponen primitive mana yang dipakai, *props* visual, durasi frame, dan titik frame `pause_at_frame` untuk interaksi).
   - **Interactive Puzzle & Consequence:** Merancang aturan tantangan interaktif beserta umpan balik akademik dan perubahan state dunia.
4. **`BlueprintValidatorNode` (Layer 4):**
   Memvalidasi keseluruhan output menggunakan **Pydantic** dan pemeriksaan integritas graf (memastikan semua `concept_id` diajarkan sebelum diuji, tidak ada referensi frame/scene yang yatim, dan semua puzzle memiliki solusi valid).

---

# 4. Remotion Interactive Canvas Architecture

## 4.1. Mengapa `@remotion/player` Berbasis JSON (Bukan Video MP4)?

| Aspek | Render Video Server (`.mp4`) ❌ | Client `@remotion/player` + JSON Schema ✅ |
|---|---|---|
| **Ukuran Payload Komunikasi** | Sangat besar (10–50 MB per chapter) | Sangat kecil (**10–30 KB JSON** per chapter) |
| **Waktu Tunggu Server** | Lambat (harus render ribuan frame di CPU/GPU server) | Instan (langsung dirender oleh browser sebagai komponen React) |
| **Interaktivitas Game** | Pasif (hanya bisa ditonton) | **100% Interaktif** (elemen di kanvas adalah DOM/SVG/React hidup yang bisa diklik, di-drag, dan diubah state-nya) |
| **Fitur `fast \| animate`** | Sulit melompat ke state interaktif | Mudah (`playerRef.current.seekTo(targetFrame)` & `pause()`) |

## 4.2. Cara Kerja Sinkronisasi *Story Beat* dengan Remotion

Setiap chapter terdiri dari urutan **Story Beats**. Satu *Beat* menyatukan 3 panel UI sekaligus:

```json
{
  "beat_id": "ch01_beat_04",
  "type": "interactive_puzzle",
  "character_stage": {
    "character_id": "eldric",
    "emotion": "focused",
    "gesture": "pointing_right"
  },
  "dialogue": {
    "speaker": "Eldric",
    "text": "Perhatikan empat simpul resonansi di kanvas. Dua di antaranya memiliki arah vektor yang saling meniadakan. Klik simpul yang harus kita kalibrasi ulang!"
  },
  "canvas": {
    "primitive_id": "node_graph_v1",
    "fps": 30,
    "duration_in_frames": 120,
    "pause_for_interaction_at_frame": 90,
    "props": {
      "title": "Primary Beacon Resonance Lattice",
      "nodes": [
        { "id": "n1", "label": "v1 = (2, 1)", "x": 150, "y": 220, "status": "stable" },
        { "id": "n2", "label": "v2 = (1, 2)", "x": 350, "y": 220, "status": "unstable" },
        { "id": "n3", "label": "v3 = (-2, -1)", "x": 550, "y": 220, "status": "critical" },
        { "id": "n4", "label": "Target (5, 4)", "x": 450, "y": 80, "status": "target" }
      ],
      "edges": [
        { "from": "n1", "to": "n4" },
        { "from": "n2", "to": "n4" },
        { "from": "n3", "to": "n4" }
      ]
    }
  },
  "puzzle": {
    "puzzle_id": "puzzle_ch01_01",
    "concept_ids": ["concept_linear_combination"],
    "interaction_mode": "canvas_node_select",
    "correct_target_id": "n3",
    "explanation": "Vektor v3 = (-2, -1) berlawanan arah dengan v1 = (2, 1) sehingga mengurangi total kombinasi linear menuju target (5, 4)."
  }
}
```

### Perilaku Saat Runtime di Browser:
1. Ketika pemain masuk ke `ch01_beat_04`:
   - **Panel Kiri (`CharacterStage`):** Menampilkan `eldric` dengan ekspresi `focused` dan animasi menunjuk ke kanvas.
   - **Panel Bawah (`DialogueBox`):** Menampilkan dialog Eldric.
   - **Panel Kanan (`RemotionCanvas`):**
     - Jika mode **`animate`**: `@remotion/player` memutar frame `0` hingga `90` (menganimasikan garis-garis node muncul dan berdenyut), lalu otomatis `pause()` di frame `90` dan mengaktifkan klik pada *node*.
     - Jika mode **`fast`**: `@remotion/player` langsung `seekTo(90)` dan `pause()`, sehingga pemain bisa langsung mengklik *node* tanpa menunggu animasi intro selesai.
2. Ketika pemain mengklik *node* di kanvas (atau menjawab via panel bawah):
   - **Deterministic Game Engine** memvalidasi jawaban terhadap `correct_target_id`.
   - Jika **Benar**: `@remotion/player` melanjutkan pemutaran dari frame `91` ke `120` (animasi kristal stabil), status konsep dicatat di `knowledge-manager`, dan cerita lanjut ke *beat* berikutnya.
   - Jika **Salah**: HP berkurang 1 (`hp - 1`), karakter berubah ke ekspresi `worried`, umpan balik akademik ditampilkan, dan pemain dapat mencoba kembali.

---

# 5. In-Stage Live Chat (`type something`) & `log chat`

## 5.1. Fungsi `type something`
Selama berada di dalam cerita, pemain mungkin ingin:
1. **Bertanya tentang materi di kanvas:** *"Kenapa v1 dikali 2 bisa menghasilkan (4, 2)?"*
2. **Mengklarifikasi petunjuk puzzle:** *"Apa maksud dari simpul yang saling meniadakan?"*

Ketika pemain mengirim pesan melalui `type something`:
- Request dikirim ke endpoint Python `POST /api/chat/in-character` dengan menyertakan:
  - `current_beat` (konteks visual di kanvas saat ini),
  - `active_concepts` (definisi & prinsip akademik dari blueprint materi),
  - `character_profile` (gaya bicara karakter).
- Guardrail pada LangGraph memastikan karakter **menjawab sesuai kepribadiannya di dalam cerita**, **menjelaskan konsep dengan benar**, tetapi **tidak membocorkan kunci jawaban puzzle secara langsung** jika pemain sedang berada di tengah puzzle aktif.
- Memotong `2 Simulated Credits` dan menambahkan percakapan tersebut ke dalam `log chat`.

## 5.2. Fungsi `log chat`
- Menyimpan seluruh riwayat *beat* dialog, kartu konsep (`learning_info`), serta tanya-jawab tambahan yang dilakukan pemain melalui `type something`.
- Dapat dibuka kapan saja sebagai *drawer/modal* tanpa menghilangkan progres frame pada kanvas Remotion.

---

# 6. Deterministic Game Engine & Knowledge Progression

Bagian *core domain logic* yang sudah matang di `src/lib/game/` tetap dipertahankan dan diadaptasi ke dalam arsitektur v2:

## 6.1. HP & Retry Rules (`src/lib/game/hp-manager.ts`)
- Setiap chapter/story dimulai dengan **5 HP**.
- Kesalahan pada puzzle/interaksi kanvas mengurangi **1 HP**.
- Jika **HP mencapai 0 (`STORY_FAILED`)**:
  - Pemain dapat memilih **Retry Chapter** (mengulang chapter dari awal dengan HP kembali 5, sementara histori bukti pemahaman di `CampaignState` tetap terjaga) atau **Exit**.

## 6.2. Knowledge Tracking (`src/lib/game/knowledge-manager.ts`)
Setiap konsep dilacak melalui 4 level status yang hanya bisa naik (tidak pernah turun):
- `not_introduced`: Konsep belum pernah ditampilkan di kanvas/dialog.
- `introduced`: Pemain telah melewati *beat* penjelasan visual untuk konsep tersebut.
- `developing`: Pemain telah mencoba puzzle konsep tersebut namun membutuhkan koreksi/feedback (pernah menjawab salah).
- `demonstrated`: Pemain berhasil menyelesaikan puzzle konsep tersebut pada **percobaan pertama tanpa kesalahan** lintas seluruh *run/retry*.

---

# 7. Target Directory Structure (v2 Monorepo)

```text
lore/
├── docs/
│   ├── DESIGN.md                        # UI/UX Specification & Wireframes
│   ├── DOCS.md                          # Product & Technical Architecture (this file)
│   └── assets/
│       ├── wireframe-preparation.png
│       └── wireframe-main-stage.png
│
├── backend/                             # [NEW in v2] Python AI Orchestrator
│   ├── pyproject.toml
│   ├── app/
│   │   ├── main.py                      # FastAPI entrypoint (CORS, SSE, Routes)
│   │   ├── api/
│   │   │   ├── scope.py                 # POST /api/scope/analyze & /api/scope/grill
│   │   │   ├── campaign.py              # POST /api/campaign/generate (Background + SSE)
│   │   │   └── chat.py                  # POST /api/chat/in-character ("type something")
│   │   ├── graphs/
│   │   │   ├── scope_griller_graph.py   # LangGraph HITL Grilling workflow
│   │   │   ├── synthesis_graph.py       # LangGraph NotebookLM-style parallel generator
│   │   │   └── tutor_chat_graph.py      # LangGraph contextual character responder
│   │   ├── schemas/                     # Pydantic v2 models (mirrored with Frontend Zod)
│   │   │   ├── material.py
│   │   │   ├── campaign.py
│   │   │   ├── beat.py
│   │   │   └── remotion_canvas.py
│   │   └── services/
│   │       └── credit_simulator.py      # Deterministic credit estimation & ledger
│   └── tests/
│
├── src/                                 # Next.js 16 Frontend & Game Client
│   ├── app/
│   │   ├── page.tsx                     # Page 1: "learn something?" + Grilling + Background UI
│   │   └── stage/
│   │       └── page.tsx                 # Page 2: 3-Pane Main Stage (Char + Remotion + Chat)
│   ├── components/
│   │   ├── preparation/                 # PromptInput, ChapterConfig, GrillingPanel, JobProgress
│   │   ├── stage/
│   │   │   ├── TopNavbar.tsx
│   │   │   ├── CharacterStage.tsx       # Left Pane: Character emotion & gesture renderer
│   │   │   ├── RemotionStage.tsx        # Right Pane: @remotion/player wrapper + interaction bridge
│   │   │   ├── DialogueController.tsx   # Bottom Pane: chat, [fast|animate], [type something], [log]
│   │   │   └── ChatLogDrawer.tsx
│   │   └── remotion/                    # Remotion Compositions & Interactive Primitives
│   │       ├── primitives/
│   │       │   ├── NodeGraphPrimitive.tsx
│   │       │   ├── SimulationControlPrimitive.tsx
│   │       │   ├── ArtifactInspectorPrimitive.tsx
│   │       │   └── TacticalDecisionPrimitive.tsx
│   │       └── BeatComposition.tsx
│   └── lib/
│       ├── game/                        # Pure deterministic rules (HP, Knowledge, Validator)
│       ├── schemas/                     # Zod validation schemas for backend JSON payloads
│       └── types/
│
└── tests/                               # Frontend Vitest suite
```

---

# 8. Overhaul Roadmap (v1 $\rightarrow$ v2)

| Phase | Milestone | Focus & Deliverables |
|---|---|---|
| **Phase 1** | **Contracts & Schema Alignment** | Menetapkan kontrak JSON bersama (Pydantic di Python $\leftrightarrow$ Zod di TypeScript) untuk `StoryBeat`, `CharacterStageState`, `RemotionCanvasSpec`, dan `CreditEstimate`. |
| **Phase 2** | **3-Pane Stage & `@remotion/player` Foundation** | Membangun layout 3-panel di Next.js (`CharacterStage`, `RemotionStage`, `DialogueController` dengan toggle `fast \| animate` dan `log chat`) menggunakan *dummy beat JSON*. |
| **Phase 3** | **Interactive Remotion Primitives** | Mengimplementasikan komponen kanvas interaktif pertama (`NodeGraphPrimitive` & `TacticalDecisionPrimitive`) yang mendukung *pause-on-frame* dan *click-to-solve* terhubung ke HP & Knowledge Engine. |
| **Phase 4** | **Python + LangGraph Backend Setup** | Menginisialisasi layanan FastAPI + LangGraph untuk **Scope Grilling (`interrupt`)**, **Credit Simulator**, dan **NotebookLM-style Parallel Chapter Synthesis (SSE)**. |
| **Phase 5** | **Preparation Page & End-to-End Integration** | Membangun halaman `learn something?`, menghubungkan alur *Grilling* $\rightarrow$ *Background Synthesis* $\rightarrow$ *3-Pane Stage*, serta mengaktifkan fitur live `type something`. |
| **Phase 6** | **Polish & Verification** | Penyesuaian animasi karakter, *balancing* rumus *credit*, dan pembaruan seluruh *test suite* (Vitest + Pytest). |

---

# 9. Open Items to Finalize During Implementation

Beberapa detail yang sengaja dibuat fleksibel dan akan dikunci saat memasuki masing-masing fase:
1. **Character Asset Format:** Memilih antara *layered SVG components* dengan animasi *spring* atau integrasi Rive/Lottie untuk panel karakter kiri.
2. **Credit Unit Calibration:** Menentukan pemicu utama pengurangan *credit* (apakah murni berbasis struktural: jumlah chapter & komponen interaktif, atau dikombinasikan dengan jumlah token LLM aktual dari LangChain callbacks).
3. **Remotion Primitive Expansion:** Menentukan batas jumlah *primitive* pada rilis pertama v2 agar pembuatan *prompt* di LangGraph tetap sangat reliabel dan mudah divalidasi.
