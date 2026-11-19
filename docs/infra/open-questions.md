# Open questions

**Tujuan dokumen.** Mengumpulkan semua keputusan yang masih dibutuhkan dari pemilik proyek sebelum atau selama implementasi. Setiap entri memuat konteks, opsi dengan trade-off, default yang dipakai semua dokumen lain, dan dampak jika keputusannya berbeda. Dokumen lain sudah ditulis dengan nilai default, jadi proyek bisa berjalan tanpa jawaban kecuali pada tugas yang ditandai terblokir.

Status: draft v1

Cara memakai: tulis keputusan pada kolom "Keputusan" di tabel ringkasan. Jika keputusan berbeda dari default, perbarui dokumen yang disebut pada bagian "Dampak". Label `[terverifikasi: ...]` dan `[belum diverifikasi]` mengikuti konvensi di [00-overview.md](./00-overview.md).

## Tabel ringkasan

| ID | Topik | Default yang dipakai dokumen | Tugas roadmap yang terblokir | Keputusan |
|---|---|---|---|---|
| Q1 | Bentuk backend | Python FastAPI (sesuai README) | R6, R9, R13 | FastAPI di `backend/` |
| Q2 | Frontend di GitHub Pages | Tidak. Next.js di EC2 | R8 | Next.js (`frontend/`) + Caddy di EC2 `web` |
| Q3 | Domain dan TLS | Tanpa domain, HTTP lewat EIP | R8 | HTTP lewat EIP `web` (TLS via Caddy saat domain diset) |
| Q4 | Identitas pemilik data | Belum diputuskan, `owner_id` nullable | R13 | Menunggu desain R13 |
| Q5 | Fitur yang pindah ke backend | Project, campaign state, pipeline AI | R13 | Menunggu desain R13 |
| Q6 | Akun AWS dan Free Tier | Akun yang sama dengan `zero-to-prod` | R1 | AWS Free Account Plan (`FREE`) |
| Q7 | Region | `ap-southeast-3` | R1, R3 | `ap-southeast-3` (Jakarta) |
| Q8 | Budget dan aksi | US$70, alert email, aksi deny policy | R1 | US$70/bln + `lore-deny-new-spend` di 100% ACTUAL |
| Q9 | NAT | NAT instance `t3.micro` | R4 | NAT instance `t3.micro` (`nat_mode = "instance"`) |
| Q10 | RDS | `db.t3.micro`, Postgres 16, master user, password RDS-managed | R10 | `backup_retention_period = 1` (batas AWS Free Account Plan) |
| Q11 | Timeout AI | Deadline sama dengan timeout (300000) | R11 | Default `300000` / `300000` (tanpa `thinkingConfig`, R11 selesai) |
| Q12 | Visibilitas repo dan paket | Repo dan paket GHCR publik | R2, R7 | Repo & paket GHCR publik |
| Q13 | Staging | Tidak ada, satu environment `prod` | - | Satu environment `prod` |
| Q14 | Observability minimal | Tidak ada | - | Tidak ada |
| Q15 | Versi runtime | Node mengikuti dev, Python 3.12 | R5, R6 | Node `26` (`frontend/.nvmrc`), Python `3.12` |
| Q16 | Provider Terraform | `~> 5.80` | R2 | `aws ~> 5.80` (`5.100.0` di lockfile) |
| Q17 | Tag tambahan dan tag policy | Tidak ada | R2 | Tag standar + Resource Group |
| Q18 | Zero-downtime dan HA | Tidak ada, downtime saat replace | R8, R9 | Single-instance, replace saat `deploy/**` berubah |
| Q19 | Backup tambahan | Hanya backup otomatis RDS | R10 | Automated backup 1 hari (Free Plan) |
| Q20 | Keamanan tambahan | Dependabot dan secret scanning | R2 | Dependabot tidak dipakai (manual PR) |
| Q21 | Prefix API | `/api/v1` | R6, R8 | `/api/v1` |
| Q22 | Gerbang deploy | Apply infra butuh approval, release otomatis | R1, R2 | `production` (approval), `production-release` (otomatis) |
| Q23 | Identitas admin manusia | IAM user ber-MFA | R1 | IAM admin ber-MFA |
| Q24 | Logging Session Manager | Mati | R1 | Mati |
| Q25 | Role Budgets action dan notifikasi anomaly | Dibuat bootstrap | R1 | Dibuat via `bootstrap.sh` |

## Q1 Bentuk backend

- **Konteks.** `README.md` dan `docs/DOCS.md` merencanakan backend Python (FastAPI, LangChain, LangGraph, Pydantic v2) dengan SSE. Folder `backend/` belum ada. Permintaan memisahkan frontend dan backend ke instance berbeda konsisten dengan rencana itu.
- **Opsi.**
  - FastAPI dengan LangGraph (sesuai README).
  - Tetap route handler Next.js, tetapi dijalankan di instance terpisah. Lebih sedikit kode baru, tetapi tidak sesuai arah v2.
  - Runtime lain.
- **Default.** FastAPI. Dokumen mengasumsikan container port 8000 dengan prefix `/api/v1`.
- **Dampak jika berbeda.** [03-compute.md](./03-compute.md) (compose api, healthcheck), [06-app-changes.md](./06-app-changes.md) bagian 2, [05-cicd.md](./05-cicd.md) (job `api`), R6 dan R9.

## Q2 Frontend di GitHub Pages

- **Konteks.** Pages gratis (runner untuk Pages gratis [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-actions]). Jika semua route handler Next pindah ke backend dan frontend bisa di-export statis, instance `web`, EIP-nya (sekitar US$11 per bulan untuk instance, EBS, dan IPv4) tidak dibutuhkan.
- **Opsi.**
  - Next.js di EC2 (permintaan saat ini: frontend dan backend di instance terpisah).
  - Static export ke Pages. Butuh API publik ber-HTTPS dengan CORS, dan perlu dipastikan apakah `cacheComponents` dan route dinamis `/play/[projectId]` bisa di-export [belum diverifikasi].
- **Default.** Next.js di EC2.
- **Dampak jika berbeda.** Instance web, Caddy, `deploy/web/`, `release-web.yml`, dan SG web berubah. API harus publik dengan TLS (domain wajib, Q3).

## Q3 Domain dan TLS

- **Konteks.** Caddy mengurus Let's Encrypt hanya jika ada domain. Tanpa HTTPS jangan simpan data sensitif atau fitur login.
- **Opsi.**
  - Tanpa domain: HTTP lewat `http://<EIP_WEB>` (default).
  - Domain milik sendiri atau subdomain gratis dari layanan DNS (verifikasi layanan sebelum dipakai). A record ke `<EIP_WEB>`.
  - Hindari Route 53 hosted zone (biaya per zona).
  - Hindari proxy Cloudflare: menutup request sekitar 100 detik pada plan non-Enterprise [belum diverifikasi], bertentangan dengan timeout AI 5 menit. Pakai DNS-only.
- **Default.** Tanpa domain.
- **Dampak jika berbeda.** Parameter `SITE_ADDRESS` ([03-compute.md](./03-compute.md) bagian 4 dan 11), `APP_URL`, [09-runbook.md](./09-runbook.md) bagian 3.9. Rate limit Let's Encrypt saat instance sering diganti (Q18).

## Q4 Identitas pemilik data persisten

- **Konteks.** Lore tidak punya akun. Data persisten di server butuh pemilik: siapa yang boleh membaca, mengubah, dan menghapus project.
- **Opsi.**
  - Token perangkat anonim (cookie). Sederhana, tetapi data hilang jika token hilang dan tidak lintas perangkat.
  - Akun (OAuth GitHub atau Google, atau email). Lintas perangkat, butuh layanan auth dan kebijakan privasi.
  - Single-user (satu pemilik). Paling sederhana, tetapi tidak untuk publik.
- **Default.** Belum diputuskan. Kolom `owner_id` dibuat nullable.
- **Dampak jika berbeda.** Schema dan tabel identitas ([04-database.md](./04-database.md) bagian 7), auth di backend, kebijakan penghapusan data, dan hampir seluruh R13.

## Q5 Fitur yang pindah ke backend

- **Konteks.** "Beberapa fitur" belum ditentukan.
- **Opsi.** Project dan campaign state, pipeline AI, chat "type something" (belum ada di kode), avatar dan pacing (sekarang localStorage).
- **Default.** Project (`projects`, `project_stories`, `project_state`), campaign state, dan pipeline AI pindah. Avatar dan pacing tetap lokal. Import data IndexedDB yang ada. Chat in-character belakangan.
- **Dampak jika berbeda.** Endpoint dan tabel ([06-app-changes.md](./06-app-changes.md) bagian 4, [04-database.md](./04-database.md) bagian 7), cakupan R13.

## Q6 Akun AWS dan Free Tier

- **Konteks.** `zero-to-prod` memakai akun AWS yang kemungkinan sama. OIDC provider mungkin sudah ada dan STS `v2Token` mungkin sudah diatur. Status Free Tier atau kredit akun memengaruhi estimasi (model kredit untuk akun baru [belum diverifikasi]).
- **Opsi.** Akun yang sama dengan bucket state baru (default), atau akun terpisah (isolasi lebih baik, lebih banyak pengelolaan).
- **Default.** Akun yang sama. Bootstrap melewati OIDC provider jika sudah ada.
- **Dampak jika berbeda.** [02-iam-and-oidc.md](./02-iam-and-oidc.md) bagian 2 (jangan menghapus OIDC provider yang dipakai proyek lain), estimasi di [07-cost-guardrails.md](./07-cost-guardrails.md).

## Q7 Region

- **Konteks.** `zero-to-prod` memakai `ap-southeast-3` (Jakarta). Itu region opt-in yang butuh STS `v2Token`, dan harga biasanya lebih tinggi dari region lain.
- **Opsi.** `ap-southeast-3` (default, latensi terbaik untuk pengguna Indonesia). `ap-southeast-1` (Singapura): bukan opt-in dan umumnya lebih murah, latensi sedikit lebih besar.
- **Default.** `ap-southeast-3`. Cek ketersediaan `t3.micro`, `db.t3.micro`, dan Postgres 16 di region terpilih [belum diverifikasi].
- **Dampak jika berbeda.** Nama AZ, CIDR tetap, nilai `AWS_REGION`, ARN di semua dokumen, estimasi biaya, dan langkah `v2Token`.

## Q8 Budget dan aksi otomatis

- **Konteks.** AWS tidak punya batas pengeluaran keras. Budget dipakai sebagai peringatan dan aksi.
- **Opsi.** Nilai bulanan selain US$70. Alamat email `<EMAIL_ALERT>`. Aksi menempelkan policy deny pada 100% (default). Aksi menghentikan EC2 dan RDS pada 120% (menyebabkan outage, RDS yang di-stop menyala lagi setelah 7 hari [belum diverifikasi]).
- **Default.** US$70 per bulan. Email di 50%, 80%, 100% ACTUAL dan 100% FORECAST. Aksi deny policy. Aksi stop instance mati. Dua budget (satu ber-action) agar tetap dalam batas gratis [terverifikasi: aws.amazon.com/aws-cost-management/aws-budgets/pricing].
- **Dampak jika berbeda.** [07-cost-guardrails.md](./07-cost-guardrails.md) bagian 6 dan bootstrap. Menambah budget ber-action ketiga berbiaya US$0,10 per hari per budget.

## Q9 NAT

- **Konteks.** Subnet private butuh egress. NAT Gateway US$0,045 per jam dan US$0,045 per GB [terverifikasi: aws.amazon.com/vpc/pricing, us-east-2].
- **Opsi.**
  - NAT instance `t3.micro` (default). Sekitar US$8 per bulan, single point of failure.
  - NAT Gateway. Sekitar +US$25 per bulan bersih, lebih andal, perlu melonggarkan guardrail di bootstrap.
  - fck-nat (AMI komunitas). Bisa HA lewat Auto Scaling Group, bergantung pada AMI pihak ketiga.
  - NAT `t3.nano`. Hemat sekitar US$4 tetapi menyimpang dari instruksi t3.micro.
  - Api di public subnet tanpa NAT. Hemat sekitar US$13, tetapi melanggar permintaan private subnet.
  - NAT dirangkap di instance web. Tidak disarankan: kopling kegagalan dan RAM 1 GiB.
- **Default.** NAT instance `t3.micro`.
- **Dampak jika berbeda.** [01-network.md](./01-network.md) bagian 2 dan 4, `lore-guardrail-deny` ([02-iam-and-oidc.md](./02-iam-and-oidc.md) bagian 5), biaya ([07-cost-guardrails.md](./07-cost-guardrails.md) bagian 3), R4.

## Q10 RDS

- **Konteks.** Instruksi "t3 micro" dipakai sebagai `db.t3.micro`. Banyak keputusan kecil lain ada di sini.
- **Opsi.**
  - Kelas: `db.t3.micro` (default) atau `db.t4g.micro` (umumnya sedikit lebih murah, verifikasi ketersediaan di region).
  - Versi: PostgreSQL 16 (default) atau 17.
  - User aplikasi: master `lore_admin` di versi 1 (default) atau `lore_app` dengan hak terbatas sejak awal ([04-database.md](./04-database.md) bagian 5).
  - Password: RDS-managed lewat Secrets Manager, sekitar US$0,40 per bulan (default), atau `random_password` dengan SSM SecureString (gratis tetapi password masuk tfstate).
  - TLS: `PGSSLMODE=require` (default) atau `verify-full` dengan bundle CA RDS di image.
  - Retensi backup: 7 hari (default).
- **Default.** `db.t3.micro`, PostgreSQL 16, master user di versi 1, password RDS-managed, `require`, retensi 7 hari.
- **Dampak jika berbeda.** [04-database.md](./04-database.md), role api di [02-iam-and-oidc.md](./02-iam-and-oidc.md), guardrail kelas DB, `render-env.sh`, R10.

## Q11 Timeout AI

- **Konteks.** Timeout dinaikkan menjadi 5 menit. Dengan `AI_DEADLINE_MS` sama dengan `AI_TIMEOUT_MS`, model pertama yang kehabisan waktu menghabiskan seluruh budget sehingga tidak ada failover ([06-app-changes.md](./06-app-changes.md) bagian 3.2).
- **Opsi.**
  - Deadline sama dengan timeout, 300000 (default).
  - Deadline 600000 agar ada satu failover setelah timeout. Maksimum tunggu 10 menit per langkah.
  - Timeout 295000 untuk menghindari race dengan timeout undici 300 detik [belum diverifikasi].
  - SSE dengan heartbeat atau job lalu polling, menggantikan satu request panjang.
  - Menambahkan `thinkingConfig` (anggaran reasoning) pada request Gemini, dan interaksinya dengan `maxOutputTokens` [belum diverifikasi].
- **Default.** Keduanya 300000, tanpa `thinkingConfig`, satu request panjang selama route masih di Next.
- **Dampak jika berbeda.** `gemini-client.ts`, `.env.example`, parameter SSM, `Caddyfile` (`response_header_timeout`), R11.

## Q12 Visibilitas repo dan paket

- **Konteks.** Repo `Nnaory/lore` publik: halaman terbuka tanpa login [terverifikasi: github.com/Nnaory/lore]. README menulis "License: Private. All rights reserved". Repo publik membuat Actions gratis dan Environments tersedia [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-actions, docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments]. Image GHCR publik memuat bundle aplikasi.
- **Pertanyaan.** Apakah kode dan image publik memang diinginkan, mengingat klaim lisensi "Private"?
- **Hal yang terlihat publik di repo publik.** Log Actions, komentar PR (plan Terraform dengan ARN dan ID akun), artifact (`tfplan`, retensi 1 hari), dan isi `infra/backend.tf` (nama bucket memuat ID akun). ID akun AWS bukan secret, tetapi memudahkan pengintaian. Mitigasi di [05-cicd.md](./05-cicd.md) bagian 6: masking ID akun di log, redaksi pada komentar. Opsi lebih ketat: komentar PR hanya berisi ringkasan aksi per resource, nama bucket tanpa ID akun (sufiks acak).
- **Opsi.**
  - Repo dan paket publik (default).
  - Repo publik, paket privat. Pull butuh kredensial: PAT classic `read:packages` di SSM, `GITHUB_TOKEN` saat deploy, atau ECR ([03-compute.md](./03-compute.md) bagian 9).
  - Repo privat. Konsekuensi: compute Actions plan Free hanya US$12 per bulan, artifact dan Packages dibagi 500 MB, paket privat 500 MB storage dan 1 GB transfer [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-packages], Environments butuh Pro atau Team (konfigurasi yang ada diabaikan saat repo menjadi privat), branch protection di repo privat plan Free [belum diverifikasi].
- **Default.** Repo dan paket publik.
- **Dampak jika berbeda.** [03-compute.md](./03-compute.md) bagian 9, [05-cicd.md](./05-cicd.md) bagian 3 dan 12, [07-cost-guardrails.md](./07-cost-guardrails.md) bagian 9, R2 dan R7.

## Q13 Staging

- **Konteks.** Branch `staging` ada di repo.
- **Opsi.** Satu environment `prod` (default). Staging permanen kedua (sekitar +US$50 per bulan). Staging ephemeral (apply sesuai kebutuhan lalu destroy). Staging lokal dengan docker compose.
- **Default.** Satu environment. CI berjalan untuk PR ke `main`.
- **Dampak jika berbeda.** State key kedua, tfvars per env, `default_tags.Environment`, role dan Environment GitHub tambahan, budget.

## Q14 Observability minimal

- **Konteks.** Stack observability tidak dipakai. Tanpa CloudWatch Logs dan alarm, log dibaca lewat SSM.
- **Opsi.** Tidak ada (default). Workflow cron GitHub yang `curl` `APP_URL` dan membuka issue bila gagal (gratis di repo publik). Alarm CloudWatch dasar (ada kuota gratis terbatas [belum diverifikasi]).
- **Default.** Tidak ada.
- **Dampak jika berbeda.** [05-cicd.md](./05-cicd.md) bagian 8 dan denylist ([07-cost-guardrails.md](./07-cost-guardrails.md)).

## Q15 Versi runtime

- **Konteks.** `@types/node` di `package.json` adalah `^20`, sementara setup test menyebut perbaikan untuk Node 25. Versi Node yang dipakai pengembangan harus dicek, jangan ditebak.
- **Opsi.** Node sama dengan versi dev (default), atau LTS (24 atau 22) untuk image. Python 3.12 sesuai README. Versi Caddy dan plugin Compose dipin saat implementasi.
- **Default.** `.nvmrc` sama dengan versi dev setelah dicek. Python 3.12.
- **Dampak jika berbeda.** `Dockerfile`, `ci.yml`, `backend/Dockerfile`.

## Q16 Provider Terraform

- **Konteks.** `zero-to-prod` memakai provider AWS `~> 5.80` dan Terraform `>= 1.10`.
- **Opsi.** `~> 5.80` (default) atau 6.x. Lock file di-commit untuk platform yang dipakai CI dan laptop.
- **Default.** `~> 5.80`.
- **Dampak jika berbeda.** `infra/backend.tf`, `.terraform.lock.hcl`, perilaku beberapa atribut resource.

## Q17 Tag tambahan dan tag policy

- **Konteks.** Skema tag di [08-tagging.md](./08-tagging.md) tidak punya `Owner` atau `CostCenter`.
- **Opsi.** Tambah `Owner` (nama atau email). AWS Organizations tag policy (butuh Organizations).
- **Default.** Tidak ada tag tambahan dan tidak ada tag policy. Penegakan lewat pemeriksa CI.
- **Dampak jika berbeda.** `default_tags`, pemeriksa tag, dan dokumen tagging.

## Q18 Zero-downtime dan HA

- **Konteks.** Perubahan `deploy/**` mengganti instance (downtime beberapa menit). State Caddy hilang saat replace sehingga sertifikat diterbitkan ulang (rate limit [belum diverifikasi]).
- **Opsi.** Tidak ada (default). Volume data EBS kecil untuk data Caddy (sekitar US$0,2 per bulan [belum diverifikasi]). Auto Scaling Group atau instance kedua (biaya berlipat).
- **Default.** Tidak ada.
- **Dampak jika berbeda.** [03-compute.md](./03-compute.md) bagian 3, [01-network.md](./01-network.md) (subnet kedua), biaya.

## Q19 Backup tambahan

- **Konteks.** Backup otomatis RDS 7 hari dengan PITR.
- **Opsi.** Hanya otomatis (default). Dump logis mingguan ke S3 lewat workflow terjadwal (biaya sen, perlu izin dan bucket tambahan).
- **Default.** Hanya otomatis.
- **Dampak jika berbeda.** [04-database.md](./04-database.md) bagian 9, bucket tambahan, role.

## Q20 Keamanan tambahan

- **Konteks.** Default: Dependabot dan secret scanning dengan push protection (gratis di repo publik [belum diverifikasi]).
- **Opsi.** CodeQL, scan image dengan Trivy di CI, `tflint`, branch protection tambahan.
- **Default.** Hanya yang disebut di konteks.
- **Dampak jika berbeda.** [05-cicd.md](./05-cicd.md) (job tambahan), menit Actions bila repo privat.

## Q21 Prefix API

- **Konteks.** Caddy meneruskan prefix tertentu ke api.
- **Opsi.** `/api/v1` (default) atau `/backend`. Route lama Next `/api/ai/*` tetap hidup berdampingan sampai pindah.
- **Default.** `/api/v1`.
- **Dampak jika berbeda.** `Caddyfile`, FastAPI router, smoke test, [06-app-changes.md](./06-app-changes.md).

## Q22 Gerbang deploy

- **Konteks.** Satu Environment hanya punya satu konfigurasi proteksi, jadi dipakai dua: `production` (apply infra) dan `production-release` (deploy aplikasi).
- **Opsi.** Apply butuh approval, release otomatis (default). Release juga butuh approval. Tanpa approval sama sekali (tidak disarankan untuk infra).
- **Default.** `production` dengan reviewer, `production-release` tanpa reviewer.
- **Dampak jika berbeda.** Trust policy `sub` di [02-iam-and-oidc.md](./02-iam-and-oidc.md) bagian 3, [05-cicd.md](./05-cicd.md) bagian 3 dan 7.

## Q23 Identitas admin manusia

- **Konteks.** Bootstrap, teardown, dan akses Session Manager dilakukan admin.
- **Opsi.** IAM user ber-MFA (default). IAM Identity Center (butuh Organizations).
- **Default.** IAM user ber-MFA dengan `ssm:StartSession` ke instance ber-tag `Project=lore`.
- **Dampak jika berbeda.** [02-iam-and-oidc.md](./02-iam-and-oidc.md) bagian 7 dan [09-runbook.md](./09-runbook.md).

## Q24 Logging Session Manager

- **Konteks.** Log sesi ke S3 atau CloudWatch menambah biaya dan komponen.
- **Opsi.** Mati (default). Aktifkan ke S3 dengan lifecycle pendek.
- **Default.** Mati.
- **Dampak jika berbeda.** Bucket tambahan, izin role instance, denylist ([07-cost-guardrails.md](./07-cost-guardrails.md)).

## Q25 Role Budgets action dan notifikasi anomaly

- **Konteks.** Aksi budget memakai role eksekusi dengan trust `budgets.amazonaws.com`. Subscription anomaly butuh penerima.
- **Opsi.** Dibuat oleh bootstrap (default) dengan izin minimal, atau dibuat manual.
- **Default.** Dibuat bootstrap. Trust dan izin minimal diverifikasi saat implementasi [belum diverifikasi]. Penerima notifikasi adalah `<EMAIL_ALERT>`.
- **Dampak jika berbeda.** [02-iam-and-oidc.md](./02-iam-and-oidc.md) bagian 5.2, [07-cost-guardrails.md](./07-cost-guardrails.md) bagian 6 dan 7.
