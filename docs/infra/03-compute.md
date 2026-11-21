# 03 Compute: EC2, Caddy, parameter SSM, deploy, GHCR

**Tujuan dokumen.** Spesifikasi tiga instance EC2 (web, api, nat), cara file deploy sampai ke instance, parameter SSM untuk config dan secret, alur deploy lengkap dengan rollback, serta penggunaan GHCR. Potongan kode adalah ilustrasi untuk implementasi nanti: verifikasi saat implementasi. Jaringan dibahas di [01-network.md](./01-network.md), izin di [02-iam-and-oidc.md](./02-iam-and-oidc.md).

Status: draft v1

## 1. Ringkasan komponen

| Instance | Subnet | IP | Isi | Port | Role |
|---|---|---|---|---|---|
| `lore-prod-web` | `lore-prod-public-a` | EIP `<EIP_WEB>` | Container `caddy` dan `web` (Next.js) | 80, 443 (publik). 3000 hanya di jaringan docker | `lore-prod-web-instance` |
| `lore-prod-api` | `lore-prod-app-a` | `10.20.10.10`, tanpa IP publik | Container `api` (FastAPI), opsional `migrate` | 8000 (hanya dari SG web) | `lore-prod-api-instance` |
| `lore-prod-nat` | `lore-prod-public-a` | EIP `<EIP_NAT>` | Forwarding NAT (lihat dokumen jaringan) | - | `lore-prod-nat-instance` |

Tidak ada SSH dan tidak ada key pair. Akses lewat SSM Session Manager.

## 2. Spesifikasi EC2 bersama

| Atribut | Nilai |
|---|---|
| AMI | AL2023 x86_64 dari parameter SSM publik `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` (sama seperti `zero-to-prod`) |
| Penggantian AMI | `lifecycle { ignore_changes = [ami] }`. AMI baru dipakai hanya lewat `-replace` setelah ditinjau (lihat [09-runbook.md](./09-runbook.md)). Tanpa ini, rilis AMI baru dari AWS membuat plan berikutnya menggantikan instance |
| Tipe | `t3.micro` (divalidasi variabel dan guardrail IAM) |
| Kredit CPU | `credit_specification { cpu_credits = "standard" }`. Default T3 adalah unlimited dan bisa menagih surplus credit |
| Metadata | `metadata_options { http_tokens = "required", http_put_response_hop_limit = 1 }` |
| Root volume | gp3 terenkripsi (kunci AWS-managed). web 12 GB, api 12 GB, nat 8 GB |
| Monitoring | `monitoring = false` (detailed monitoring berbayar) |
| `user_data_replace_on_change` | `true` |
| Swap | File swap 1 GiB dibuat di `user_data` karena RAM hanya 1 GiB |
| Paket | `docker` dan `jq` lewat `dnf`. Plugin Compose versi dipin dengan verifikasi sha256 (nilai diisi saat implementasi) |
| Log Docker | `/etc/docker/daemon.json` dengan `log-driver json-file`, `max-size 10m`, `max-file 3` (mencegah disk penuh, tanpa CloudWatch) |
| Container | Non-root (uid 10001), `restart: unless-stopped` |
| Tag | `Name`, `Component`, plus tag wajib dari provider. Lihat [08-tagging.md](./08-tagging.md) |

Disk, swap, dan memori: dengan 1 GiB RAM, Next.js standalone, Caddy, Docker, dan agen SSM berjalan bersama. Swap mencegah OOM saat lonjakan. Pantau lewat `free -m` via SSM bila ada gejala.

## 3. `user_data` dan penanaman file deploy

File di `deploy/**` ditanam ke `user_data` lewat Terraform (`templatefile` dan `filebase64`). Instance tidak melakukan `git clone`. Dengan begitu mekanisme ini tetap bekerja jika repo menjadi privat.

Template yang dibutuhkan (di `infra/`): `user_data_web.sh.tftpl`, `user_data_api.sh.tftpl`, `user_data_nat.sh.tftpl`.

Ilustrasi `compute.tf` (potongan):

```hcl
resource "aws_instance" "web" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public_a.id
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.web.name

  credit_specification { cpu_credits = "standard" }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size = 12
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data_web.sh.tftpl", {
    compose_b64    = filebase64("${path.module}/../deploy/web/compose.yml")
    caddyfile_b64  = filebase64("${path.module}/../deploy/web/Caddyfile")
    render_env_b64 = filebase64("${path.module}/../deploy/common/render-env.sh")
    deploy_b64     = filebase64("${path.module}/../deploy/common/deploy.sh")
  })
  user_data_replace_on_change = true

  lifecycle { ignore_changes = [ami] }
  tags = { Name = "lore-prod-web", Component = "web" }
}
```

Ilustrasi `user_data_web.sh.tftpl`:

```bash
#!/bin/bash
set -euxo pipefail
export AWS_DEFAULT_REGION=ap-southeast-3

# 1. Tunggu egress siap (NAT bisa lebih lambat menyala daripada instance ini)
for i in $(seq 1 60); do
  curl -fsS --max-time 5 https://github.com >/dev/null && break
  sleep 5
done

# 2. Swap 1 GiB
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 3. Docker, jq, plugin compose (versi dan sha256 dipin)
dnf install -y docker jq
mkdir -p /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl enable --now docker
COMPOSE_VERSION="<VERSI_DIPIN>"
COMPOSE_SHA256="<SHA256_DIPIN>"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v$${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
echo "$${COMPOSE_SHA256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# 4. File deploy
mkdir -p /opt/lore
echo '${compose_b64}'    | base64 -d > /opt/lore/compose.yml
echo '${caddyfile_b64}'  | base64 -d > /opt/lore/Caddyfile
echo '${render_env_b64}' | base64 -d > /opt/lore/render-env.sh
echo '${deploy_b64}'     | base64 -d > /opt/lore/deploy.sh
chmod 700 /opt/lore/render-env.sh /opt/lore/deploy.sh

# 5. Render env dan jalankan (melewati `up` bila belum ada rilis)
/opt/lore/deploy.sh web
```

Jebakan dan batas:

- Karena file diproses `templatefile`, ekspresi `${nama}` diisi oleh Terraform. Variabel shell berkurung kurawal harus ditulis `$${NAMA}`. Variabel tanpa kurung (`$i`) dan substitusi `$(...)` aman.
- AWS membatasi `user_data` sampai 16 KB (sebelum base64). Jika file deploy membuatnya melewati batas, kompres dengan `base64gzip` dan `gunzip` di instance [belum diverifikasi: batas 16 KB].
- Perubahan apa pun di `deploy/**` mengubah `user_data` dan, karena `user_data_replace_on_change = true`, instance diganti. Dampaknya:
  - Downtime beberapa menit pada komponen yang berubah.
  - Pada web, volume Caddy ikut hilang dan sertifikat Let's Encrypt diterbitkan ulang. Perhatikan rate limit penerbitan sertifikat [belum diverifikasi].
  - Hardening opsional (default mati): volume data EBS kecil untuk data Caddy (Q18).
- Karena itu perubahan `deploy/**` lewat `infra.yml` dengan komentar plan dan persetujuan, bukan lewat `release-*.yml`.

## 4. Parameter SSM

| Path | Tipe | Dikelola oleh | Contoh |
|---|---|---|---|
| `/lore/prod/web/env/API_UPSTREAM` | String | Terraform | `http://10.20.10.10:8000` |
| `/lore/prod/web/env/SITE_ADDRESS` | String | Terraform, hanya dibuat jika `site_address` tidak kosong | `<DOMAIN>` |
| `/lore/prod/api/env/AI_PROVIDER`, `AI_MODEL`, `AI_TIMEOUT_MS`, `AI_DEADLINE_MS` | String | Terraform | `google`, daftar model dipisah koma, `300000`, `300000` |
| `/lore/prod/api/env/GOOGLE_API_KEY` | SecureString | Terraform membuat placeholder `__SET_ME__`, nilai diisi manual (runbook 3.2a) | Key Gemini dari Google AI Studio |
| `/lore/prod/api/env/PGHOST` | String | Terraform | `aws_db_instance.db.address` |
| `/lore/prod/api/env/PGPORT` | String | Terraform | `5432` |
| `/lore/prod/api/env/PGDATABASE` | String | Terraform | `lore` |
| `/lore/prod/api/env/PGSSLMODE` | String | Terraform | `require` |
| `/lore/prod/api/env/AI_*` | String | Terraform | Nilai sama dengan web setelah AI pindah |
| `/lore/prod/api/env/GOOGLE_API_KEY` | SecureString | Manual | Kunci Gemini untuk api |
| `/lore/prod/api/config/db_secret_arn` | String | Terraform | ARN secret master RDS (non-secret) |
| `/lore/prod/web/release/image_tag` | String | Job deploy | `sha-1a2b3c4` |
| `/lore/prod/api/release/image_tag` | String | Job deploy | `sha-1a2b3c4` |

Aturan:

- Nama variabel lingkungan adalah segmen terakhir path. Menambah env var baru berarti menambah satu parameter.
- **Secret tidak boleh dikelola oleh Terraform.** Jangan memakai resource `aws_ssm_parameter` atau `data "aws_ssm_parameter"` untuk nilai secret. Nilai itu ikut tersimpan di tfstate saat refresh walau `ignore_changes` dipasang. Secret dibuat manual:

```bash
# Pembuatan pertama (boleh dengan --tags)
aws ssm put-parameter --name /lore/prod/web/env/GOOGLE_API_KEY \
  --type SecureString --value '<GOOGLE_API_KEY>' \
  --tags Key=Project,Value=lore Key=Environment,Value=prod Key=Component,Value=web \
         Key=ManagedBy,Value=manual Key=Repo,Value=Nnaory/lore

# Penggantian nilai (tanpa --tags, karena --tags tidak boleh bersama --overwrite)
aws ssm put-parameter --name /lore/prod/web/env/GOOGLE_API_KEY \
  --type SecureString --value '<GOOGLE_API_KEY>' --overwrite
```

- Parameter `image_tag` tidak dikelola Terraform. Job deploy yang membuat dan menimpanya. Tag pada parameter itu dipasang sekali dengan `aws ssm add-tags-to-resource` (nilai `ManagedBy=github-actions`) [belum diverifikasi: larangan `--tags` bersama `--overwrite`].
- Tier standard saja (gratis). Parameter advanced berbayar dan masuk denylist.
- SecureString memakai kunci AWS-managed `aws/ssm` (tanpa CMK, karena CMK berbiaya).

## 5. `render-env.sh` dan `deploy.sh` (spesifikasi)

File: `deploy/common/render-env.sh` dan `deploy/common/deploy.sh`. Keduanya belum dibuat. Tambahkan pemeriksaan `shellcheck` di CI.

`render-env.sh COMPONENT` (COMPONENT adalah `web` atau `api`):

1. Panggil `aws ssm get-parameters-by-path --path /lore/prod/<COMPONENT>/env/ --with-decryption --recursive` dan ubah hasilnya (JSON, lewat `jq`) menjadi baris `NAMA=NILAI`, dengan NAMA adalah segmen terakhir path. Nilai ditulis dengan kutip tunggal agar `$` tidak diinterpolasi Compose (verifikasi perilaku parser `env_file` pada versi Compose yang dipin). Tolak nilai yang mengandung newline.
2. Untuk api: baca `/lore/prod/api/config/db_secret_arn`, panggil `aws secretsmanager get-secret-value` dan tambahkan `PGUSER` dan `PGPASSWORD`.
3. Baca `/lore/prod/<COMPONENT>/release/image_tag`. Jika ada, tulis `APP_IMAGE=ghcr.io/nnaory/lore-<COMPONENT>:<tag>`. Jika belum ada (first boot sebelum rilis pertama), tulis env lain dan keluar dengan kode 10.
4. Tulis ke file sementara, `chmod 600`, lalu `mv` ke `/opt/lore/.env` (atomik).
5. Tidak pernah mencetak nilai ke stdout atau log.

`deploy.sh COMPONENT`:

1. Jalankan `render-env.sh`. Jika kode keluar 10, cetak "belum ada rilis" dan keluar 0 tanpa `up`.
2. `docker compose pull`.
3. Jika compose dengan profile `migrate` mendefinisikan service `migrate` (api), jalankan `docker compose --profile migrate run --rm migrate`.
4. `docker compose up -d --remove-orphans --wait --wait-timeout 90`.
5. Untuk api, cek `curl -fsS http://127.0.0.1:8000/health/db` dengan retry (verifikasi koneksi DB tanpa membuka endpoint itu ke publik).
6. `docker image prune -f` (menjaga disk 12 GB).
7. Keluar non-nol pada kegagalan apa pun (`set -euo pipefail`).

## 6. Compose dan Caddy

Ilustrasi `deploy/web/compose.yml`:

```yaml
services:
  caddy:
    image: caddy:<VERSI_DIPIN>
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:-:80}
      API_UPSTREAM: ${API_UPSTREAM}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [web]
  web:
    image: ${APP_IMAGE}
    restart: unless-stopped
    env_file: .env
    environment:
      PORT: "3000"
      HOSTNAME: 0.0.0.0
    expose: ["3000"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
volumes:
  caddy-data:
  caddy-config:
```

`HOSTNAME: 0.0.0.0` wajib karena Docker mengisi `HOSTNAME` dengan ID container, sehingga server standalone Next.js tidak bisa dijangkau Caddy jika tidak diganti [belum diverifikasi: perilaku bind server standalone].

Ilustrasi `deploy/web/Caddyfile`:

```
{$SITE_ADDRESS::80} {
	encode zstd gzip

	handle /api/v1/* {
		reverse_proxy {$API_UPSTREAM} {
			flush_interval -1
			transport http {
				response_header_timeout 330s
			}
		}
	}

	handle {
		reverse_proxy web:3000 {
			transport http {
				keepalive off
				response_header_timeout 330s
			}
		}
	}
}
```

Alasan:

- `API_UPSTREAM=http://10.20.10.10:8000`, disimpan sebagai parameter non-secret Terraform.
- Prefix `/api/v1/*` ke api. Selain itu ke Next.js. Route lama Next `/api/ai/*` ikut ke Next sampai dipindah.
- `flush_interval -1` agar respons streaming (SSE) tidak tertahan.
- `response_header_timeout 330s` lebih besar dari timeout AI 300 detik agar Caddy tidak memutus lebih dulu. Detail timeout di [06-app-changes.md](./06-app-changes.md).
- `keepalive off` ke Next.js karena Next memakai keep-alive 5 detik secara default. Koneksi upstream yang dipakai ulang bisa sudah ditutup, dan hasilnya error acak. Koneksi localhost murah, jadi mematikan keep-alive aman.
- Verifikasi bahwa `encode` tidak menahan respons `text/event-stream`. Jika perlu, batasi dengan matcher.
- Tanpa domain, `SITE_ADDRESS` tidak diset dan Caddy melayani HTTP di port 80. Dengan domain, Caddy mengurus HTTPS otomatis.

Ilustrasi `deploy/api/compose.yml`:

```yaml
services:
  api:
    image: ${APP_IMAGE}
    restart: unless-stopped
    env_file: .env
    ports: ["8000:8000"]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"]
      interval: 30s
      timeout: 5s
  migrate:
    image: ${APP_IMAGE}
    profiles: ["migrate"]
    env_file: .env
    command: ["alembic", "upgrade", "head"]
```

## 7. Alur deploy aplikasi

Berlaku untuk `release-web.yml` dan `release-api.yml` (job `deploy`, Environment `production-release`, role `lore-gh-deploy`). Workflow lengkap ada di [05-cicd.md](./05-cicd.md).

1. Job `build` membangun image dan mendorong `ghcr.io/nnaory/lore-<komponen>:sha-<7 char>` memakai `GITHUB_TOKEN`.
2. Job `deploy` mengambil tag sebelumnya: `aws ssm get-parameter --name /lore/prod/<komponen>/release/image_tag` (kosong pada rilis pertama).
3. Menimpa tag: `aws ssm put-parameter --name ... --value sha-xxxxxxx --type String --overwrite`.
4. Menjalankan script di instance:

```bash
aws ssm send-command \
  --document-name AWS-RunShellScript \
  --targets "Key=tag:Project,Values=lore" "Key=tag:Environment,Values=prod" "Key=tag:Component,Values=<web|api>" \
  --comment "deploy <komponen> sha-xxxxxxx" \
  --parameters 'commands=["/opt/lore/deploy.sh <web|api>"]' \
  --query Command.CommandId --output text
```

   Semantik AND untuk beberapa target `tag:` diverifikasi saat implementasi [belum diverifikasi]. Cadangan: target `Key=tag:Name,Values=lore-prod-<komponen>`.
5. Polling `aws ssm get-command-invocation` setiap beberapa detik (batas total sekitar 10 menit) sampai status `Success`, atau gagal pada `Failed`, `Cancelled`, `TimedOut`. Waiter bawaan `aws ssm wait command-executed` punya batas lebih pendek, jadi dipakai loop sendiri.
6. Cetak output command ke log job (tidak memuat nilai secret karena script tidak mencetaknya).
7. Smoke test dari runner: `curl --fail --silent --show-error --retry 10 --retry-delay 6 --retry-connrefused "$APP_URL/"` untuk web, dan `"$APP_URL/api/v1/health"` untuk api.
8. Jika smoke test atau command gagal: tulis kembali tag sebelumnya ke parameter, jalankan script deploy lagi, tandai job gagal.

Rollback manual: jalankan `release-<komponen>.yml` lewat `workflow_dispatch` dengan input `tag` (melewati build). Alternatif ada di [09-runbook.md](./09-runbook.md).

Aturan urutan: jika kontrak API berubah, rilis api lebih dulu (harus backward-compatible), baru web. Perubahan yang tidak kompatibel memakai pola expand dan contract.

## 8. Urutan first boot

1. `infra.yml` apply membuat instance dan parameter Terraform. Instance menyala, memasang Docker, menanam file deploy, lalu `deploy.sh` keluar karena belum ada tag rilis (kode 10). Layanan belum berjalan.
2. Isi secret manual (`GOOGLE_API_KEY`) sebelum rilis pertama.
3. Rilis pertama (`release-api.yml` dan `release-web.yml`) membuat parameter `image_tag` dan menjalankan container.
4. Instance yang diganti nanti naik langsung di tag terakhir karena membaca parameter `image_tag`. Ini menyelesaikan kelemahan `zero-to-prod` yang selalu mulai dari `latest`.

## 9. GHCR

- Build dan push memakai `GITHUB_TOKEN` dengan izin `packages: write`. Tidak ada kredensial AWS di job build.
- Nama image huruf kecil: `ghcr.io/nnaory/lore-web` dan `ghcr.io/nnaory/lore-api`.
- Tag hanya `sha-<7 char>`, tanpa `latest`. Tidak ada tag yang ditimpa, jadi rilis bisa dilacak ke commit.
- Label OCI `org.opencontainers.image.source=https://github.com/Nnaory/lore` menghubungkan paket ke repo.
- Paket baru dibuat privat. Ubah ke Public sekali lewat UI GitHub setelah publish pertama, lalu uji `docker pull` anonim dari laptop setelah `docker logout ghcr.io` (pola yang sama dengan `zero-to-prod`). Verifikasi saat publish pertama apakah visibilitas mewarisi repo lewat label source.
- Paket publik gratis. Container registry saat ini gratis untuk storage dan bandwidth, dengan pemberitahuan minimal sebulan sebelum berubah [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-packages].
- Image tidak memuat secret. Semua config masuk saat runtime lewat `.env` hasil `render-env.sh`.

Jika paket harus privat:

| Opsi | Cara | Catatan |
|---|---|---|
| A | PAT classic `read:packages` disimpan sebagai SSM SecureString, instance menjalankan `docker login ghcr.io` | Perlu rotasi PAT. Pull dengan PAT dihitung terhadap kuota transfer paket privat |
| B | `GITHUB_TOKEN` dikirim saat deploy lewat command SSM | Token berumur pendek, tetapi tercatat di riwayat SSM command. Instance yang dibangun ulang tidak bisa pull sendiri |
| C | ECR | Berbiaya, keluar dari prinsip gratis |

Pull dengan `GITHUB_TOKEN` dari dalam Actions gratis, tetapi pull dari EC2 tidak termasuk itu [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-packages]. Kuota paket privat di plan Free: 500 MB storage dan 1 GB transfer per bulan.

## 10. Route AI di backend

- Pipeline AI berjalan di api (`/api/v1/ai/*`, `backend/app/ai/`). Web tidak memanggil Gemini dan tidak punya env `AI_*` atau key; egress 443 web tetap dibutuhkan untuk GHCR, SSM, dan Let's Encrypt.
- `GOOGLE_API_KEY` hanya ada di path `/lore/prod/api/env/`. Bila dulu pernah dibuat manual `/lore/prod/web/env/GOOGLE_API_KEY`, parameter itu tidak dikelola Terraform dan harus dihapus manual (`aws ssm delete-parameter --name /lore/prod/web/env/GOOGLE_API_KEY`), karena `render-env.sh` merender semua parameter di path web.
- Urutan rilis dan checklist ada di [11-ai-backend-migration.md](./11-ai-backend-migration.md).

## 11. Domain dan TLS

- Default: tanpa domain, HTTP lewat `http://<EIP_WEB>`. Cukup selama belum ada akun atau data sensitif.
- Dengan domain: buat A record ke `<EIP_WEB>`, set `site_address` di Terraform. Caddy mengurus sertifikat Let's Encrypt otomatis dan butuh port 80 dan 443 terbuka (sudah di SG).
- Cloudflare proxy menutup request di atas sekitar 100 detik pada plan non-Enterprise [belum diverifikasi]. Itu bertentangan dengan timeout AI 5 menit. Jika memakai Cloudflare, pakai mode DNS-only.
- Caddy memakai image dari Docker Hub. Pull anonim dibatasi sekitar 100 per 6 jam per IP [belum diverifikasi]. Jumlah pull kecil, jadi aman. Pin versi image.
- Route 53 hosted zone berbiaya dan masuk denylist. Pakai DNS di luar AWS.

## 12. Risiko

| Risiko | Mitigasi |
|---|---|
| Instance diganti pada perubahan `deploy/**` | Perubahan lewat PR dengan plan. Opsi volume data untuk Caddy (Q18) |
| Web kehabisan memori | Swap 1 GiB, rotasi log Docker, pantau lewat SSM |
| Egress api mati saat NAT mati | Lihat [01-network.md](./01-network.md) bagian 7 |
| Smoke test lolos tetapi DB bermasalah | `deploy.sh` api memeriksa `/health/db` secara internal |
| `.env` terbaca proses lain di instance | File berizin 600 milik root, container non-root, IMDS hop limit 1 |
