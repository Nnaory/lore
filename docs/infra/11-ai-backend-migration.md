# 11 Migrasi endpoint AI ke backend

**Tujuan dokumen.** Urutan rilis, checklist perbandingan, dan rollback untuk memindahkan pipeline AI dari route handler Next.js (`frontend/src/app/api/ai/*`) ke FastAPI (`/api/v1/ai/*`). Dokumen ini berlaku sampai Tahap 4 (penghapusan kode lama) selesai.

Status (21 Nov 2026): kode backend, flag frontend, dan tes kontrak sudah ada di branch `feat/ai-backend`. Rilis production dan perbandingan di bawah belum dilakukan. Route Next.js `/api/ai/*` masih ada sebagai jalan mundur.

## 1. Apa yang berubah

| Sisi | Sebelum | Sesudah |
|---|---|---|
| Browser | `POST /api/ai/{step}` | `POST /api/v1/ai/{step}` bila build memakai `NEXT_PUBLIC_AI_BACKEND=api` |
| Gemini key | env container web | SSM SecureString `/lore/prod/api/env/GOOGLE_API_KEY`, env container api |
| Pembatasan | tidak ada | per IP, per owner, kuota harian per IP, dan batas request berjalan (lihat bagian 4) |
| Langkah | `analyze-material`, `plan-campaign`, `generate-story` | sama, dengan envelope dan kode galat yang sama |

Parsing file (PDF, DOCX, PPTX) tetap di browser. Backend hanya menerima teks hasil ekstraksi.

## 2. Urutan rilis

1. Merge PR infra. CI menjalankan `terraform apply` dan membuat parameter `GOOGLE_API_KEY` dengan nilai placeholder.
2. Isi nilai asli key (runbook 3.2a) dan rilis api (`release-api.yml`).
3. Cek dari instance api: `curl -fsS http://127.0.0.1:8000/health/ai` harus mengembalikan `{"configured":true}`.
4. Dari mesin yang punya akses: `python3 scripts/verify/ai-smoke.py https://<APP_URL>` setelah web siap (langkah 5), atau terhadap API lokal sebelum itu. Exit code 0 berarti tiga langkah berhasil. Skrip ini memakai beberapa panggilan Gemini sungguhan.
5. Set variabel repo `NEXT_PUBLIC_AI_BACKEND=api` (`gh variable set NEXT_PUBLIC_AI_BACKEND --body api`), lalu jalankan `release-web.yml`. Variabel kosong berarti `next`.
6. Bandingkan (bagian 3). Selama tahap ini jangan mengubah prompt di `frontend/src/lib/ai/*`, supaya dua implementasi tetap sama.

## 3. Checklist perbandingan

Pakai materi yang sama (satu file kecil dan satu file sedang) pada build `next` dan build `api`. Catat untuk masing-masing:

- [ ] Ketiga langkah selesai tanpa galat.
- [ ] Jumlah konsep, jumlah story, dan jumlah scene sebanding (angka persis boleh beda karena model non-deterministik).
- [ ] Hasil lolos validasi klien (tidak ada pesan "unexpected" di UI).
- [ ] Latensi tiap langkah, dan tidak ada putus koneksi pada langkah terpanjang (batas Caddy 330 detik).
- [x] Tanpa key (parameter masih placeholder): UI menampilkan peringatan "AI belum diatur", bukan galat umum. *Lokal 21 Nov 2026: `/health/ai` = `configured:false` dan endpoint menjawab 503 `PROVIDER_NOT_CONFIGURED`; pemetaan ke pesan UI dicakup tes kontrak. Tampilan UI di production belum dicek.*
- [x] Rate limit: kirim lebih dari batas per menit. Respons 429 membawa `Retry-After`, dan UI menampilkan pesan "sibuk". *Lokal (batas diset 3/menit): request ke-4 dst 429 `RATE_LIMITED` dengan `Retry-After: 60`; pesan UI dicakup tes kontrak.*
- [x] Cookie `lore_device` diterbitkan pada `/api/v1/ai/*` dan tidak mengganti owner project yang sudah ada. *Lokal: terbit tanpa cookie, tidak ada `Set-Cookie` bila cookie sudah ada. Interaksi dengan owner project di DB belum dicek (butuh Postgres).*
- [ ] Log Caddy tidak lagi menerima `/api/ai/*` dari browser setelah rilis web.
- [ ] Log container api tidak memuat key maupun isi prompt.

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

Set variabel kembali ke `next` (`gh variable set NEXT_PUBLIC_AI_BACKEND --body next`) lalu jalankan ulang `release-web.yml`. `deploy.sh` selalu menjalankan `docker compose pull`, jadi image yang dibangun ulang dengan tag yang sama tetap terambil. Route Next.js dan key web harus masih ada pada saat itu, karena itu Tahap 4 hanya dikerjakan setelah bagian 3 lolos.

## 6. Syarat memulai Tahap 4 (penghapusan)

- Checklist bagian 3 lolos pada build `api` di production.
- Build `api` dipakai tanpa masalah selama periode yang Anda tentukan.
- Anda memberi persetujuan, karena setelah itu rollback lewat flag tidak ada lagi.

Tahap 4 menghapus `frontend/src/app/api/ai/*`, `frontend/src/lib/ai/*` yang tersisa, `lib/validation/*` yang hanya dipakai server, helper dummy provider, flag `NEXT_PUBLIC_AI_BACKEND`, parameter `AI_*` dan key di env web, dan kata "transitional Gemini" pada deskripsi egress web di `infra/security.tf`. Rule egress 443 tetap karena GHCR, SSM, dan Let's Encrypt memakainya.
