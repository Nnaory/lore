---
inclusion: fileMatch
fileMatchPattern: ["frontend/src/app/globals.css", "frontend/src/app/lore-tokens.css", "frontend/src/app/layout.tsx", "frontend/src/components/**/*.tsx", "frontend/src/lib/ascii/**", "frontend/src/lib/ascii-field/**"]
---

# Sistem Desain Black Cat Gold (seluruh app)

Sumber kebenaran: `AGENTS.md` dan `docs/DESIGN-SYSTEM.md`, diikuti frame referensi `reference/canvas/*.dc.html` dan token di `frontend/src/app/lore-tokens.css`.

- **Token warna (`lore-tokens.css`):** `bg-ink` (`#0F0F12`), `border-smoke` / `bg-smoke` (`#2A2A2E`), `text-gold` / `border-gold` (`#C9A227`), `bg-ember` / `text-ember` (`#FF7A18`, satu-satunya aksen interaktif), `text-cream` / `bg-cream` (`#F4EFE6`), `text-muted` (`#A8A49C`), `text-ink-soft` (`#5A5650`), `bg-candle` (`#F2D27A`), `text-candle-ink` (`#6B5418`), serta warna pakaian cast (`--color-cloth-eldric|mira|hazel|varr|nyx`, hanya untuk karakter). Tidak ada hex lain di komponen.
- **Tipografi (`frontend/src/app/fonts.ts`):** `Space Grotesk` (`font-display`) untuk judul/narasi dan `JetBrains Mono` (`font-mono`) untuk dialog, label, tombol, chip, dan seni ASCII (`advance 0.6em`).
- **Bentuk & permukaan:** Tanpa sudut membulat (`* { border-radius: 0 !important }`), tanpa blur, tanpa `backdrop-filter`, tanpa bayangan (kecuali ring 2px cream pada `.lore-dialog`), tanpa gradient (kecuali grid 24px `.lore-grid-bg` dan `.lore-grid-lines`), tanpa emoji, dan tanpa kartu. Pengelompokan memakai garis 1px `smoke`, `SectionLabel` bernomor (`01 MATERIAL ────`), dan baris terpilih terbalik (`bg-cream text-ink`). Target sentuh minimal 44px.
- **Seni ASCII (`frontend/src/lib/ascii/*` + `<AsciiArt>`):** Semua karakter (`renderCharacter`, `renderBust`), scene (`renderScene`), labu statis (`pumpkin`, `jackMouth`), dan wordmark (`wordmark`) digambar lewat generator dan diuji terhadap `frontend/tests/fixtures/ascii-golden.json` (`tests/ascii-golden.test.ts`, 40/40). Jangan menyalin ASCII manual ke JSX atau mengubah angka generator.
- **Latar labu beranimasi (`PumpkinBackdrop` + `frontend/src/lib/ascii-field/*`):** Tetap dipasang sekali di `frontend/src/app/layout.tsx` (`canvas.lore-ascii-field`, `position: fixed`, `z-index: -1`, `100vw × 100lvh`, `background: [15, 15, 18]` selaras `--color-ink`). Halaman Home, Lobby, Summary, `/create`, dan fallback memakai `.lore-grid-lines` transparan agar animasi labu terlihat.
- **Stage (`StoryViewer`):** Gameplay Stage penuh layar memakai `.lore-grid-bg` opak (`bg-ink` + grid 24px, tanpa labu), dengan `StageHud` (`bg-ink`) dan `StageScene` (`city_gate`) membentang penuh 100vw × 100vh lewat slot `fullBleed` milik `ScaledBoard`. Elemen latar depan (`StageSprite`, `CanvasPane`, `StageDialogue`, `KeyHints`) diskalakan utuh oleh `ScaledBoard` (papan desain `1440×900` desktop / `390×844` phone) tanpa kotak bingkai `1200×675` ataupun `StageBackdrop`.
