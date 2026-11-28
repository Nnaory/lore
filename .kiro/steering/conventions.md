---
inclusion: always
---

# Konvensi

- Logika murni ada di `src/lib/*` (reducer dan fungsi), dengan hook React tipis di atasnya. Komponen tidak menghitung HP atau benar-salah sendiri.
- Hasil berupa union `{ ok: true, ... } | { ok: false, ... }`. Tidak ada throw di batas modul.
- Zod dipakai di setiap batas kepercayaan: request route, respons di client, dan data dari IndexedDB/localStorage.
- Styling memakai kelas Tailwind token Kit (`bg-ink`, `text-cream`, `border-smoke`, `text-gold`, `bg-ember`, `font-mono`, `font-display`, `text-muted`, `bg-candle`). Tidak ada hex di komponen. Aturan lengkap: `AGENTS.md` dan `docs/DESIGN-SYSTEM.md`.
- `data-testid` dipasang di hampir semua elemen interaktif.
- Tiap file punya komentar header yang menjelaskan tujuan dan alasannya.
- Commit memakai Conventional Commits dengan scope (`feat(stage): …`, `fix(visual): …`, `test(ai): …`, `feat(infra): …`). Kode dan test masuk di commit terpisah.
- Branch utama: `main` (dilindungi ruleset `protection-main`: wajib PR dan check `ci/web`, `ci/api`, `ci/docker`, `ci/terraform`). Check `ci/verifier` dan `ci/contracts` sudah didefinisikan di `ci.yml` (fitur animasi R14) tetapi **belum menjadi required check `protection-main`: menunggu persetujuan pengguna**. Jangan menambahkannya ke ruleset dan jangan menganggapnya sudah diwajibkan; keduanya juga merah sampai `animation-verifier/package-lock.json` ada. Development infra berjalan di `infra/setup`.
- Jangan commit atau push tanpa diminta pengguna.
- Tes frontend ada di `frontend/tests/<domain>/*.test.ts(x)` dengan fixture di `frontend/tests/fixtures/`; tes backend berupa fungsi `test_*` di `backend/tests/`; tes verifier di `animation-verifier/tests/` (Vitest); skrip CI memakai `unittest`.
- File yang tidak boleh diedit manual: `frontend/package-lock.json`, `animation-verifier/package-lock.json`, `infra/.terraform.lock.hcl`, migrasi Alembic yang sudah ada, `node_modules/`, `.next/`, `frontend/public/sandbox/` (output build), serta `.env*`, `*.tfvars`, `*.tfstate*`. Salinan kontrak animasi di `backend/app/ai/animation/animation-contract.json` dan `frontend/src/lib/animation/animation-contract.json` juga bukan untuk disunting tangan: ubah `animation-verifier/contract/animation-contract.json` lalu jalankan `python3 scripts/sync-animation-contract.py`.
- Dependensi baru dipin ke versi persis (`==` di `backend/requirements.txt`; tanpa `^`, `~`, `>=`, `*`, `latest` di `package.json`). Kode tulisan AI hanya boleh dieksekusi di Verifier_Lambda dan di iframe `frontend/sandbox-runtime/`; teks materi dan cerita di prompt diperlakukan sebagai data. Log animasi tidak boleh memuat kode sumber, prompt, token, key, materi, cerita, cookie, atau URL presigned.
- Dokumen dan steering tidak memuat id akun AWS (tulis `<ACCOUNT_ID>`), URL presigned (parameter tanda tangannya), atau kunci akses AWS. Pola yang dilarang dan dijaga tes ada di `backend/tests/test_animation_docs.py`; jangan menuliskan pola itu secara harfiah di steering karena tes yang sama memindai berkas ini. Harga atau perilaku AWS yang belum terbukti ditandai `[belum diverifikasi]`; verifikasi yang tidak bisa dijalankan tidak boleh dipalsukan atau dilonggarkan.
