---
inclusion: fileMatch
fileMatchPattern: ["frontend/src/app/globals.css", "frontend/src/app/layout.tsx", "frontend/src/components/**/*.tsx", "frontend/src/lib/ascii-field/**"]
---

# Tema Halloween + liquid glass (seluruh app, sejak 17 Nov 2026)

- Tema hitam-emas sudah diganti di SEMUA halaman (`/`, `/create`, `/game`, `/play/*`). Token ada di `:root` `globals.css`; tidak ada lagi `.theme-halloween`, `.lore-bg`, `.lore-panel-bg`.
- Palet "Trick-or-Treat": `--hw-candy-apple` #C83E3E, `--hw-pumpkin` #F68928, `--hw-grape` #7443A8, `--hw-candy-corn` #F6C84E, `--hw-licorice` #222222. Token semantik lama dipertahankan agar tidak perlu mengubah ratusan pemakaian, tapi isinya baru: `--accent-gold` = Candy Corn Yellow (namanya basi), `--accent` = Bright Pumpkin.
- Kelas glass (resep dari referensi `~/Temporary/ascii-animals/page.css`): `lore-glass` (dasar), `lore-glass-composer` (kartu utama), `lore-glass-panel` (panel berisi teks/kontrol, tanpa refraksi), `lore-pill` (+ `-sm`, `-lg`, `-icon`, `-primary`, `-accent`, `-danger`), `lore-composer-input` (textarea di composer home; fokus ditandai glow kartu, bukan outline), `lore-tile`, `lore-well`, `lore-eyebrow`, `lore-hairline`, `lore-halo`.
- Radius mengikuti referensi, didaftarkan sebagai utilitas Tailwind: `rounded-pill` 999px (tombol), `rounded-card` 24px (kartu utama), `rounded-panel` 20px (panel), `rounded-tip` 12px (tile kecil di dalam panel).
- Pola halaman: halaman TIDAK mengecat latar sendiri. Konten ditaruh di panel `lore-glass lore-glass-panel rounded-card|panel`, tombol memakai `lore-pill`.
- Refraksi (Chromium saja): `app/layout.tsx` menaruh `<script>` inline di `<head>` yang menambah kelas `liquid` ke `<html>` sebelum paint (`suppressHydrationWarning` di `<html>`), dan `GlassFilter` merender filter SVG `#lore-liquid-glass`. `next/script` `beforeInteractive` TIDAK dipakai: di Next 16 ia baru jalan saat hydration.
- Latar ASCII: `src/lib/ascii-field/` adalah port engine ascii-animals (MIT, lihat `LICENSE` di folder itu), dengan spesies `pumpkins.ts`.
  - `PumpkinBackdrop` (`src/components/backdrop/`) dirender sekali oleh root layout. Layout tidak di-remount saat pindah halaman, jadi satu engine hidup selama tab terbuka dan tidak pernah restart. Tidak ada daftar route lagi: canvas selalu tampil.
  - Canvas `position: fixed`, `z-index: -1`, ukuran `100vw × 100lvh` (bukan `inset: 0`): ukuran itu tidak berubah saat scrollbar muncul atau address bar HP bergeser. Setiap perubahan ukuran mengosongkan canvas; inilah penyebab latar berkedip saat panel avatar dibuka (halaman jadi bisa di-scroll, lebar viewport berubah). Jangan kembalikan ke `inset: 0` / `100%`.
  - `AsciiRenderer.resize` tidak melakukan apa-apa kalau ukuran sama, dan resize yang nyata langsung menggambar ulang sebelum browser mem-paint (tanpa frame kosong).
  - Klik di "langit" mengagetkan labu: engine mendengarkan `pointerdown` di window dan memakai predikat `isSky` (target bukan `a, button, input, textarea, select, label, summary, [role=button], .lore-glass`). Halaman tidak perlu mengatur `pointer-events` atau z-index.
  - Biaya: di stage cerita (Remotion + panel glass + latar) headless tanpa GPU mengukur ~48 fps vs ~55 fps tanpa canvas latar; blur panel glass hampir tidak menambah beban main-thread, canvas latar yang menambah (~15 ms/frame di software rendering). Kalau stage terasa berat di mesin lemah, kurangi `detail`/`max` di `pumpkins.ts` atau jeda canvas di stage.
- Kanvas Remotion ikut palet baru (`GOLD`, `VOID`, ... di `compositions.tsx`, `TONE_COLORS` di `visual-layout.ts`); nama konstanta lama dipertahankan.
- Warna sukses hijau `#6fcf97` masih di-hardcode di beberapa komponen (bukan token).
- Layar overlay stage (ending + story complete) bisa lebih tinggi dari kanvas; karena `items-center` + `overflow-y-auto`, bagian atasnya terpotong dan tak bisa di-scroll (sudah ada sebelum rombak tema, belum diperbaiki).
- Hydration error di `/game` pada hard-load: `ChatBox` merender teks penuh di server tapi mulai dari 0 karakter di klien (pacing `animate`). Sudah ada sebelum rombak tema, belum diperbaiki.
