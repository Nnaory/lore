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

## Animasi (R14)
Spesifikasi: `.kiro/specs/ai-remotion-animation/`. Operasi: `docs/infra/12-remotion-animation.md`.
- **Yang disimpan di project hanyalah referensi.** Story membawa `animation` opsional (`AnimationReference`: `animation_id`, `source_sha256`, `bundle_sha256`, ukuran kanvas, `duration_in_frames`, `pause_at_frame?`, `contract_version`) pada `learning_info` dan `puzzle`. Referensi ini ikut story ke IndexedDB dan ke jsonb `project_stories` yang opaque, jadi `/api/v1/projects` tidak berubah (round trip tetap). `readProject` dan skema Zod membaca `animation` secara lenient: nilai tidak valid dibuang, story tetap valid, story lama tanpa `animation` tidak berubah. `project-store.ts` dan signature-nya tidak diubah. Klien menempelkan referensi ke story sesudah animasi jadi (`attachAnimation`), sebelum project disimpan.
- **Tabel `animations`** (revisi Alembic `725515cc1581`, expand-only, ditulis tangan): `id` text (UUID huruf kecil), `owner_id` uuid, `request_hash`, `source_sha256`, `bundle_sha256`, `s3_prefix`, `kind` (`lesson` atau `puzzle`), `meta` jsonb, `attempts` (1 sampai 4), `model`, `verifier_version`, `contract_version`, `runtime_version` jsonb, `source_bytes`, `bundle_bytes`, `created_at` bigint milidetik. Unik `(owner_id, request_hash)` (`uq_animations_owner_request`), indeks `(owner_id, created_at DESC)`, banyak `CHECK` (heksadesimal, prefix S3 sama dengan `animations/v1/<2 hex>/<source_sha256>/`). **Tanpa kunci asing ke `projects`**: referensi dari story bersifat longgar, 404 berarti Fallback_Scene. `downgrade()` menjalankan `DROP TABLE` dan hanya untuk dev; rollback rilis tidak menjalankan downgrade.
- **Registry** (`backend/app/ai/animation/registry.py`): `find`, `count`, `get`, `register`. `register` satu transaksi dengan `pg_advisory_xact_lock` per Owner: cari `(owner, hash)` dulu (baris yang ada dikembalikan tanpa cek kuota), hitung baris Owner (200 atau lebih ditolak), lalu `INSERT ... ON CONFLICT DO NOTHING`. Dua request identik serentak berakhir dengan `animation_id` yang sama.
- **Pemilik** = cookie `lore_device`, sama seperti project (`owner.py`, `PROTECTED_PREFIXES` kini juga `/api/v1/animations`). Kuota 200 per Owner seumur cookie, tidak ada penghapusan animasi. Cookie hilang berarti semua referensi lama menjadi 404 dan story memakai Fallback_Scene (risiko yang diterima).
- **Isi bundle tidak ada di database atau browser storage.** `main.ts`, `main.js`, dan `manifest.json` ada di S3 privat `animations/v1/<2 hex>/<source_sha256>/` (immutable, tidak pernah dihapus atau ditimpa aplikasi). Browser mengambilnya lewat URL presigned dari Reader `GET /api/v1/animations/{animation_id}` dan mencocokkan SHA-256 sebelum menjalankannya. Cache bundle di browser hanya LRU 16 entri di memori halaman (`lib/animation/lru.ts`), bukan IndexedDB atau localStorage.
- Tes DB: `tests/test_animation_migration.py` (30 dari 32 tes butuh Postgres) dan `tests/test_animation_registry.py`. Migrasi belum pernah dijalankan di Postgres asli selama implementasi; `ci/api` menjalankannya dengan service container.
