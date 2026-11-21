# 11 Migrasi endpoint AI ke backend

**Tujuan dokumen.** Urutan rilis, checklist, dan rollback setelah pipeline AI dipindah dari route handler Next.js ke FastAPI (`/api/v1/ai/*`).

Status (21 Nov 2026): di branch `dev`, frontend tidak lagi memuat kode server AI. Route Next.js `/api/ai/*`, `frontend/src/lib/ai/*`, `lib/validation/*`, flag `NEXT_PUBLIC_AI_BACKEND`, dan env `AI_*` web sudah dihapus. Satu-satunya route handler di frontend adalah `GET /api/health` (liveness). Smoke lokal dengan Gemini asli lolos (analyze, plan, story). Rilis production belum dilakukan. Kode Next.js lama tersimpan di branch `backup/dev-before-fe-ai-removal` (`8425bb0`).

## 1. Apa yang berubah

| Sisi | Sebelum | Sesudah |
|---|---|---|
| Browser | `POST /api/ai/{step}` (Next.js) | `POST /api/v1/ai/{step}` (Caddy ke FastAPI) |
| Gemini key | env container web | SSM SecureString `/lore/prod/api/env/GOOGLE_API_KEY`, env container api |
| Env web | `AI_PROVIDER`, `AI_MODEL`, `AI_TIMEOUT_MS`, `AI_DEADLINE_MS` | tidak ada (parameter SSM web dihapus Terraform) |
| Egress web 443 | GHCR, SSM, Let's Encrypt, Gemini | GHCR, SSM, Let's Encrypt (rule tetap, hanya deskripsi berubah) |
| Pembatasan | tidak ada | per IP, per owner, kuota harian per IP, dan batas request berjalan (bagian 4) |

Parsing file (PDF, DOCX, PPTX) tetap di browser. Backend hanya menerima teks hasil ekstraksi.

## 2. Urutan rilis

Web dan API harus dirilis bersama: web baru hanya memanggil `/api/v1/ai/*`, jadi generasi story baru berjalan setelah API baru aktif dan key terisi.

1. Merge PR `dev` ke `main`. CI menjalankan `terraform apply`: membuat parameter `GOOGLE_API_KEY` api (placeholder) dan menghapus parameter `AI_*` web.
2. Isi nilai asli key (runbook 3.2a). Jangan sebelum apply, karena akan tertimpa placeholder.
3. Rilis api (`release-api.yml`) lebih dulu, lalu cek dari instance api: `curl -fsS http://127.0.0.1:8000/health/ai` harus `{"configured":true}`.
4. Rilis web (`release-web.yml`).
5. Smoke: `python3 scripts/verify/ai-smoke.py https://<APP_URL>`. Exit code 0 berarti tiga langkah berhasil. Skrip ini memakai beberapa panggilan Gemini sungguhan.
6. Jalankan checklist bagian 3.

## 3. Checklist

- [x] Lokal: tiga langkah selesai dengan Gemini asli lewat `/api/v1/ai/*` (`ai-smoke.py`).
- [x] Lokal: tanpa key, `/health/ai` = `configured:false` dan endpoint 503 `PROVIDER_NOT_CONFIGURED`.
- [x] Lokal: melebihi batas per menit memberi 429 `RATE_LIMITED` dengan `Retry-After`.
- [x] Lokal: cookie `lore_device` terbit di `/api/v1/ai/*` dan tidak diganti bila sudah ada.
- [ ] Production: `/health/ai` = `configured:true` setelah key diisi.
- [ ] Production: `ai-smoke.py https://<APP_URL>` lolos.
- [ ] Production: satu story dibuat dari `/create` di browser sampai bisa dimainkan.
- [ ] Production: langkah terpanjang tidak putus (batas Caddy 330 detik).
- [ ] Production: log container api tidak memuat key maupun isi prompt.
- [ ] Production: container web tidak punya env `AI_*` atau key (`docker exec <web> env`).

## 4. Batas default (env backend, bisa diubah lewat SSM)

| Env | Default | Arti |
|---|---|---|
| `AI_RATE_PER_MINUTE_IP` | 12 | request per menit per IP (penjaga utama; cookie bisa dipalsukan) |
| `AI_RATE_PER_MINUTE_OWNER` | 12 | request per menit per cookie owner |
| `AI_DAILY_PER_IP` | 200 | plafon harian per IP (hari UTC), pembatas biaya Gemini |
| `AI_MAX_CONCURRENT_PER_IP` | 2 | request AI berjalan bersamaan per IP |
| `AI_MAX_CONCURRENT_GLOBAL` | 8 | request AI berjalan bersamaan di satu proses |

Satu campaign berisi sekitar 8 request per story. Angka ini perlu ditinjau setelah ada data pemakaian nyata. Limiter ada di memori proses, jadi hanya benar selama API berjalan sebagai satu proses (kondisi sekarang).

## 5. Rollback

Tidak ada lagi flag untuk kembali ke route Next.js. Pilihan:

1. **Masalah di API saja:** rilis ulang api dengan tag sebelumnya (runbook 3.3). Generasi story berhenti sampai API pulih, data pemain di IndexedDB tidak terpengaruh.
2. **Kembali ke pipeline Next.js:** `git revert` merge commit penghapusan di `dev`/`main` (atau buat branch dari `backup/dev-before-fe-ai-removal`), revert juga perubahan `infra/ssm.tf` web, lalu isi kembali key di env web. Ini butuh PR dan rilis ulang web.
