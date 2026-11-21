---
inclusion: fileMatch
fileMatchPattern: ["frontend/src/lib/state/**", "frontend/src/components/home/**", "frontend/src/components/play/**", "backend/app/**", "backend/alembic/**"]
---

# Persistensi

Spesifikasi lengkap: `.kiro/specs/r13-persistence-migration/`. Ringkasan arsitektur: `docs/infra/06-app-changes.md` bagian 4, schema: `docs/infra/04-database.md` bagian 7-8.

## Frontend (`frontend/src/lib/state/`)
- `project-store.ts` adalah API publik (`listProjects`, `loadProject`, `createProject`, `saveCampaignState`, `deleteProject`, `projectStories`, `setupSaveErrorHandler`). Komponen hanya meng-import dari sini; signature-nya jangan diubah.
- Repository dipilih saat modul dimuat dari flag build `NEXT_PUBLIC_PROJECT_STORE` (dibaca literal agar di-inline Next): `idb` (default, juga untuk nilai lain) atau `http`. **Production saat ini `idb`.** Mode `http` aktif hanya setelah `release-web.yml` mem-build dengan build arg itu (task D5).
- `project-model.ts`: tipe, schema Zod, `readProject` (membuang `campaign_state` tidak valid, story tetap), `summarize`, `newId`, `buildProject`.
- `indexed-db-repository.ts`: IndexedDB `lore` v1 (`idb.ts`, store `projects` + `summaries` dalam satu transaksi), migrasi sekali jalan dari localStorage lama (`lore:projects`, `lore:project:*`). Status siap/migrasi bersifat global per halaman.
- `http-repository.ts`: tulis ke IndexedDB dulu, lalu server. Simpan state di-debounce 1,5 detik, dikirim satu per satu per project, retry 5 s sampai 60 s, `Retry-After` untuk 429. Error server dilaporkan lewat `onSaveError`, bukan return value. `null` dari API dibuang sebelum validasi Zod.
- `sync.ts`: sekali per page load di mode `http`; import project lokal yang belum ada di server (batch ≤ 4 MB), `PUT` state yang lebih baru; berhenti saat 429. Tidak pernah menghapus data lokal.
- Semua fungsi async, aman untuk SSR (konstruksi tidak menyentuh IndexedDB atau `fetch`), dan tidak throw (`{ ok: false, message }`, `null`, atau `[]`).
- localStorage hanya untuk `lore:pacing`.

## Backend (`backend/app/`)
- Tabel `projects`, `project_stories`, `project_state` (revisi Alembic `7c1d9e4a52b8`; id `text`, timestamp `bigint` milidetik, `owner_id` uuid nullable). Isi blueprint, story, state, dan material disimpan sebagai jsonb opaque; validasi penuh tetap di klien.
- Pemilik = cookie `lore_device` (`owner.py`, middleware). Akses ke project orang lain selalu `404`, kepemilikan dicek sebelum menulis.
- `projects.py`: router `/api/v1/projects`, upsert dengan `ON CONFLICT ... WHERE` (hanya salinan lebih baru yang mengganti), `stories_completed` selalu diturunkan dari state tersimpan, `projects.updated_at` hanya maju. Batas body dan storage cap di `Limits`, rate limit di `ratelimit.py` (memori proses).
