# 09 Runbook operasi

**Tujuan dokumen.** Panduan operasional untuk menyalakan, menjalankan, memulihkan, dan membongkar infrastruktur lore. Berisi urutan first-run end to end, operasi harian, teardown lengkap, dan tabel insiden. Semua perintah adalah ilustrasi untuk implementasi nanti dan memakai placeholder (`<ACCOUNT_ID>`, `<EIP_WEB>`, `<EMAIL_ALERT>`, dan sejenisnya). Verifikasi sintaks saat dipakai pertama kali.

Status: draft v1

## 1. Prasyarat alat

`git`, `gh`, `terraform` 1.10 atau lebih baru, `awscli` v2, `session-manager-plugin`, `docker`, `jq`, dan `shellcheck`. Profil AWS admin (IAM user ber-MFA) untuk bootstrap dan teardown. Akun GitHub pemilik repo `Nnaory/lore`.

## 2. First-run end to end

Urutan di bawah mengikuti roadmap ([10-implementation-roadmap.md](./10-implementation-roadmap.md)). Kode dan workflow dibuat lewat PR di tiap tugas. Langkah di sini adalah tindakan manual yang menyertainya.

| # | Langkah | Perintah atau tindakan | Tugas |
|---|---|---|---|
| 1 | Login GitHub sebagai pemilik repo | `gh auth login`, lalu `gh auth status` | R1 |
| 2 | Cek identitas AWS | `aws sts get-caller-identity --profile <ADMIN_PROFILE>`. Pastikan akun dan region benar | R1 |
| 3 | Jalankan bootstrap | `AWS_PROFILE=<ADMIN_PROFILE> AWS_REGION=ap-southeast-3 ALERT_EMAIL=<EMAIL_ALERT> ./infra/bootstrap/bootstrap.sh`. Catat tiga ARN role yang dicetak. Cek kotak masuk untuk email konfirmasi Budgets dan anomaly | R1 |
| 4 | Isi `vars` GitHub | `gh variable set AWS_REGION --body ap-southeast-3`, `gh variable set AWS_ROLE_PLAN_ARN --body <ARN>`, `AWS_ROLE_APPLY_ARN`, `AWS_ROLE_DEPLOY_ARN`. `APP_URL` diisi setelah EIP web ada | R1 |
| 5 | Buat Environment | Settings, Environments: `production` (reviewer: akun sendiri, deployment branch `main`) dan `production-release` (tanpa reviewer, deployment branch `main`) | R1 |
| 6 | Atur branch protection `main` | PR wajib, force push dan delete dilarang, status check `ci / web`, `ci / api`, `ci / docker`, `ci / terraform` | R5 |
| 7 | Jalankan job "whoami" | Workflow dispatch yang men-assume tiap role dan mencetak klaim `sub`. Cocokkan dengan trust policy | R1 |
| 8 | PR infra bertahap | Network (R3), NAT dan IAM instance (R4), instance dan lainnya (R8 sampai R10). Setiap PR menampilkan komentar plan. Setujui apply di Environment `production` | R2 sampai R10 |
| 9 | Aktifkan cost allocation tag | Setelah tag muncul di resource (sekitar 24 jam setelah R3 dan R4): `aws ce update-cost-allocation-tags-status ...` ([08-tagging.md](./08-tagging.md)) | R4 |
| 10 | Isi secret runtime | Lihat bagian 3.5. Wajib sebelum rilis pertama | R8 |
| 11 | Publish image pertama | Merge perubahan yang memicu `release-web.yml` dan `release-api.yml`. Job `deploy` boleh gagal di rilis pertama jika instance belum ada. Itu normal | R7 |
| 12 | Ubah paket GHCR menjadi Public | UI GitHub: Packages, `lore-web` dan `lore-api`, Package settings, Change visibility. Uji dengan `docker logout ghcr.io` lalu `docker pull ghcr.io/nnaory/lore-web:sha-<7 char>` | R7 |
| 13 | Isi `APP_URL` | `gh variable set APP_URL --body http://<EIP_WEB>` (atau domain) | R8 |
| 14 | Rilis dan smoke test | Rilis api dulu, lalu web. Cek `curl -fsS "$APP_URL/"` dan `curl -fsS "$APP_URL/api/v1/health"` | R8 dan R9 |
| 15 | Drill restore RDS | Lihat bagian 3.8 | R10 |

Catatan urutan: jika kontrak API berubah, rilis api lebih dulu. Instance baru tidak menjalankan container sampai ada tag rilis ([03-compute.md](./03-compute.md) bagian 8).

## 3. Operasi harian

### 3.1 Cari instance dan akses lewat Session Manager

```bash
aws ec2 describe-instances \
  --filters Name=tag:Project,Values=lore Name=tag:Component,Values=api Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text

aws ssm start-session --target <INSTANCE_ID>
```

### 3.2 Deploy

Merge ke `main`. `release-web.yml` atau `release-api.yml` membangun image, mengirim ke GHCR, dan men-deploy lewat SSM, lalu menjalankan smoke test dan rollback otomatis bila gagal.

### 3.3 Rollback

Tiga cara, dari yang paling disarankan:

1. Workflow dispatch dengan tag sebelumnya (melewati build):

```bash
gh workflow run release-web.yml -f tag=sha-<7 char sebelumnya>
```

2. Atur parameter tag lalu jalankan script deploy lewat SSM:

```bash
aws ssm put-parameter --name /lore/prod/web/release/image_tag \
  --type String --value sha-<7 char sebelumnya> --overwrite

aws ssm send-command --document-name AWS-RunShellScript \
  --targets "Key=tag:Project,Values=lore" "Key=tag:Component,Values=web" \
  --parameters 'commands=["/opt/lore/deploy.sh web"]' \
  --query Command.CommandId --output text
```

3. Manual lewat Session Manager: `cd /opt/lore`, ubah `APP_IMAGE` di `.env`, `docker compose up -d`. Parameter `image_tag` harus disamakan setelahnya.

Rollback image tidak me-rollback schema database ([04-database.md](./04-database.md) bagian 6).

### 3.4 Log, status, dan restart

```bash
CMD_ID=$(aws ssm send-command --document-name AWS-RunShellScript \
  --targets "Key=tag:Project,Values=lore" "Key=tag:Component,Values=api" \
  --parameters 'commands=["cd /opt/lore && docker compose ps && docker compose logs --tail 200"]' \
  --query Command.CommandId --output text)

aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id <INSTANCE_ID> \
  --query '[Status,StandardOutputContent,StandardErrorContent]'
```

Restart satu komponen: ganti perintah dengan `cd /opt/lore && docker compose restart`. Memori: `free -m`. Disk: `df -h /` dan `docker system df`.

### 3.5 Secret runtime

```bash
# Pembuatan pertama
aws ssm put-parameter --name /lore/prod/web/env/GOOGLE_API_KEY \
  --type SecureString --value '<GOOGLE_API_KEY>' \
  --tags Key=Project,Value=lore Key=Environment,Value=prod Key=Component,Value=web \
         Key=ManagedBy,Value=manual Key=Repo,Value=Nnaory/lore

# Rotasi
aws ssm put-parameter --name /lore/prod/web/env/GOOGLE_API_KEY \
  --type SecureString --value '<GOOGLE_API_KEY_BARU>' --overwrite

# Terapkan: render ulang env dan restart container
aws ssm send-command --document-name AWS-RunShellScript \
  --targets "Key=tag:Project,Values=lore" "Key=tag:Component,Values=web" \
  --parameters 'commands=["/opt/lore/deploy.sh web"]'
```

Jangan menempelkan nilai secret ke riwayat shell bersama dan jangan memasukkannya ke Terraform, workflow, atau chat. Untuk api, gunakan path `/lore/prod/api/env/GOOGLE_API_KEY` dengan `Component=api`.

### 3.6 Akses database

```bash
aws ssm start-session --target <API_INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host=<RDS_ENDPOINT>,portNumber=5432,localPortNumber=5432

# Terminal lain
PGPASSWORD="$(aws secretsmanager get-secret-value --secret-id <DB_SECRET_ARN> \
  --query SecretString --output text | jq -r .password)" \
  psql "host=127.0.0.1 port=5432 dbname=lore user=lore_admin sslmode=require"
```

### 3.7 Refresh AMI (ganti instance)

AMI tidak berubah otomatis (`ignore_changes = [ami]`). Untuk memakai AMI baru atau memaksa penggantian instance:

```bash
gh workflow run infra.yml -f replace=aws_instance.web
```

Workflow menjalankan plan dengan `-replace`, lalu menunggu persetujuan Environment `production`. Perkirakan downtime beberapa menit pada komponen itu. Pada web, sertifikat TLS diterbitkan ulang. Pulihkan NAT dengan cara yang sama (`replace='aws_instance.nat[0]'`).

### 3.8 Drill restore RDS

1. `aws rds create-db-snapshot --db-instance-identifier lore-prod-db --db-snapshot-identifier lore-prod-db-drill-<TANGGAL>`.
2. Restore ke instance sementara `lore-prod-db-restore` (kelas `db.t3.micro`, single-AZ, subnet group yang sama, SG `lore-prod-rds`).
3. Cek data lewat port-forward ke endpoint instance sementara.
4. Hapus instance sementara dan snapshot drill. Catat biaya drill.

Guardrail IAM berlaku untuk pipeline, bukan untuk admin, jadi drill dijalankan oleh admin dari laptop.

### 3.9 Domain dan `SITE_ADDRESS`

1. Buat A record dari domain ke `<EIP_WEB>` di penyedia DNS (bukan Route 53, lihat denylist).
2. Ubah variabel `site_address` di `infra/` lewat PR. Apply membuat parameter `/lore/prod/web/env/SITE_ADDRESS`. Ini tidak mengubah `user_data`, jadi instance tidak diganti.
3. Jalankan `/opt/lore/deploy.sh web` lewat SSM untuk merender ulang env. Caddy memperoleh sertifikat Let's Encrypt.
4. Ubah `APP_URL` menjadi `https://<DOMAIN>`.
5. Jangan menaruh domain di belakang proxy Cloudflare (batas sekitar 100 detik [belum diverifikasi] bertentangan dengan timeout AI 5 menit).

### 3.10 Mengubah ukuran instance

Guardrail menolak selain `t3.micro`. Untuk menaikkan: ubah guardrail di bootstrap lewat PR terpisah dan jalankan ulang bootstrap dari laptop, baru ubah variabel di `infra/`. Hitung dampak biaya dulu ([07-cost-guardrails.md](./07-cost-guardrails.md)).

### 3.11 Pemeriksaan biaya mingguan

Ikuti ritual di [07-cost-guardrails.md](./07-cost-guardrails.md) bagian 10.

## 4. Teardown lengkap

Dijalankan dari laptop dengan profil admin, bukan lewat pipeline. Guardrail IAM sengaja menutup kemungkinan pipeline menghapus data.

1. Ubah `protect_data = false` lewat PR, setujui apply. Ini mematikan `deletion_protection` RDS.
2. Dari laptop: `cd infra`, `terraform init`, lalu `terraform destroy` dengan nilai variabel yang sama dengan pipeline.
3. Hapus snapshot RDS yang tidak dibutuhkan (`aws rds describe-db-snapshots`, lalu `aws rds delete-db-snapshot`), termasuk snapshot final.
4. Hapus parameter SSM manual: secret `GOOGLE_API_KEY`, `image_tag`.
5. Opsional, hapus bootstrap:
   - Budget `lore-prod-monthly` dan `lore-prod-guardrail`, anomaly monitor dan subscription.
   - Tiga role GitHub dan policy guardrail.
   - Bucket state (kosongkan semua versi lebih dulu).
   - OIDC provider hanya jika tidak dipakai proyek lain. Akun yang sama dengan `zero-to-prod` memakai provider yang sama, jadi jangan dihapus.
6. Verifikasi tidak ada sisa:

```bash
aws ec2 describe-nat-gateways --filter Name=state,Values=available
aws ec2 describe-addresses
aws ec2 describe-volumes --filters Name=tag:Project,Values=lore
aws ec2 describe-snapshots --owner-ids self --filters Name=tag:Project,Values=lore
aws ec2 describe-network-interfaces --filters Name=tag:Project,Values=lore
aws rds describe-db-instances
aws secretsmanager list-secrets
```

7. Cek Cost Explorer sehari kemudian ([07-cost-guardrails.md](./07-cost-guardrails.md) bagian 11).

Biaya sisa yang wajar: bucket state (sen) dan snapshot yang sengaja dipertahankan.

## 5. Tabel insiden

| Gejala | Yang dicek | Tindakan |
|---|---|---|
| `http://<EIP_WEB>` tidak terbuka | Status instance web, SG `lore-prod-web` (80 dan 443), `docker compose ps` via SSM | Jalankan `/opt/lore/deploy.sh web`. Jika instance rusak, `infra.yml` dengan `replace=aws_instance.web` |
| Halaman memberi 502 dari Caddy | `docker compose logs` pada web. Container `web` sehat? `API_UPSTREAM` benar? | Restart container. Untuk path `/api/v1/*`, cek instance api. Untuk path lain, cek container Next.js |
| `/api/v1/health` gagal | Status instance api, SG (8000 dari web), `docker compose ps` pada api | Jalankan `/opt/lore/deploy.sh api`. Cek `/health` lokal via SSM |
| Error koneksi DB | `/health/db` via SSM, SG `lore-prod-rds`, status RDS, secret master | Cek `PGHOST` di `.env`. Pastikan RDS tersedia. Rotasi password jika secret berubah lalu `deploy.sh api` |
| Command deploy gagal | Output `get-command-invocation`. Parameter `image_tag`. Pull image | Jika `denied`, paket GHCR masih privat. Jika timeout, cek NAT. Rollback ke tag sebelumnya |
| Instance api atau nat Offline di SSM | Status instance nat, route table `lore-prod-app-rt`, `source_dest_check` | Pulihkan NAT dengan `replace='aws_instance.nat[0]'`. Api kehilangan SSM sampai NAT kembali |
| ACME (sertifikat) gagal | DNS A record, port 80 dan 443 terbuka, log Caddy | Perbaiki DNS. Hindari restart berulang karena rate limit penerbitan sertifikat [belum diverifikasi] |
| Email budget menyala | Cost Explorer per `Component` dan per service | Cari penyebab dulu (EIP idle, NAT Gateway, volume, snapshot, data transfer). Jika aksi guardrail menempel `lore-deny-new-spend`, lepas manual setelah masalah teratasi |
| Tagihan naik mendadak | Anomaly Detection, Cost Explorer harian, watchlist ([07-cost-guardrails.md](./07-cost-guardrails.md) bagian 8) | Hapus resource yang tidak seharusnya ada. Jangan menaikkan Budget untuk menutupi masalah |
| Plan di PR gagal karena guardrail | Pesan `check-cost` atau `AccessDenied` explicit deny | Perbaiki konfigurasi agar sesuai allowlist. Perubahan batas harus lewat bootstrap |
| Waktu AI habis (`TIMEOUT`) | Lapisan timeout di [06-app-changes.md](./06-app-changes.md) bagian 3.3 | Cek apakah ada proxy lain (Cloudflare) dan nilai `AI_TIMEOUT_MS` dan `AI_DEADLINE_MS` di parameter |
