---
inclusion: fileMatch
fileMatchPattern: ["infra/**", "deploy/**", ".github/**", "scripts/**", "docs/infra/**"]
---

# Infra dan CI/CD

- Infrastruktur AWS (`ap-southeast-3`) dikelola via `infra/` + `.github/workflows/{ci.yml,infra.yml,release-web.yml,release-api.yml}`: VPC `10.20.0.0/16`, NAT instance `t3.micro`, `web` (`t3.micro`, Caddy + Next.js), `api` (`t3.micro`, FastAPI private subnet), dan RDS PostgreSQL 16 (`db.t3.micro`, 20 GB `gp3`, `backup_retention_period = 1`).
- Deploy aplikasi memakai OIDC + AWS SSM (`scripts/ci/ssm-deploy.sh`, `/opt/lore/{render-env.sh,deploy.sh,compose.yml}`), GHCR publik (`ghcr.io/nnaory/lore-{web,api}:sha-*`). Dependabot sengaja tidak digunakan.
- Dokumentasi arsitektur yang sudah diimplementasikan (R1–R12): `docs/infra/`.
- Ada guardrail biaya (`scripts/ci/test-checkers.py`, `check-cost-static`). Jangan menaikkan ukuran instance, IOPS, atau retensi backup tanpa persetujuan pengguna, karena memakai free plan.
- **`terraform apply` dijalankan otomatis oleh CI** (`infra.yml`, environment `production`) saat push ke `main` bila ada perubahan, dengan guard: plan yang menghapus `aws_db_instance`, `aws_eip`, atau `aws_s3_bucket` diblokir kecuali `workflow_dispatch` dengan `allow_destroy`. Karena itu perubahan `infra/**` harus lewat PR dan check CI.
- Agent TIDAK boleh menjalankan `terraform apply/destroy` atau perintah AWS yang mengubah resource dari mesin lokal (hook `guard-shell` memblokirnya). Verifikasi lokal yang aman: `terraform -chdir=infra fmt -check -recursive`, `init -backend=false`, `validate`, `python3 -B scripts/ci/check-cost-static infra`, `python3 -B scripts/ci/test-checkers.py -v`, `shellcheck`.
- Ada dua compose terpisah: `deploy/web/compose.yml` (Caddy + Next.js) dan `deploy/api/compose.yml` (FastAPI, profil `migrate`). Caddy dikonfigurasi di `deploy/web/Caddyfile`.
- `infra/backend.tf` memuat nama bucket tfstate yang berisi ID akun AWS. Jangan menyalinnya ke steering, hook, atau dokumen publik.
- Gaya bash: `set -euo pipefail` dan helper `fail()` (contoh: `scripts/ci/ssm-deploy.sh`, `scripts/verify/network.sh`).
- Pola mengubah infra dengan guardrail biaya: `infra/*.tf` → `scripts/ci/policy_rules.py` (allowlist/denylist) → `scripts/ci/check-cost` dan `check-tags` → fixture di `scripts/ci/fixtures/` → `scripts/ci/test-checkers.py`.
