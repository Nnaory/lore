---
inclusion: always
---

# Konvensi

- Logika murni ada di `src/lib/*` (reducer dan fungsi), dengan hook React tipis di atasnya. Komponen tidak menghitung HP atau benar-salah sendiri.
- Hasil berupa union `{ ok: true, ... } | { ok: false, ... }`. Tidak ada throw di batas modul.
- Zod dipakai di setiap batas kepercayaan: request route, respons di client, dan data dari IndexedDB/localStorage.
- Styling memakai CSS variable semantik (`--background-panel`, `--accent-gold`, `--foreground-muted`, dan seterusnya) lewat `style` inline.
- `data-testid` dipasang di hampir semua elemen interaktif.
- Tiap file punya komentar header yang menjelaskan tujuan dan alasannya.
- Commit memakai Conventional Commits dengan scope (`feat(stage): …`, `fix(visual): …`, `test(ai): …`, `feat(infra): …`). Kode dan test masuk di commit terpisah.
- Branch utama: `main` (dilindungi ruleset `protection-main`: wajib PR dan check `ci/web`, `ci/api`, `ci/docker`, `ci/terraform`). Development infra berjalan di `infra/setup`.
- Jangan commit atau push tanpa diminta pengguna.
- Tes frontend ada di `frontend/tests/<domain>/*.test.ts(x)` dengan fixture di `frontend/tests/fixtures/`; tes backend berupa fungsi `test_*` di `backend/tests/`; skrip CI memakai `unittest`.
- File yang tidak boleh diedit manual: `frontend/package-lock.json`, `infra/.terraform.lock.hcl`, migrasi Alembic yang sudah ada, `node_modules/`, `.next/`, serta `.env*`, `*.tfvars`, `*.tfstate*`.
