# 08 Tagging resource AWS

**Tujuan dokumen.** Menetapkan skema tag untuk semua resource AWS lore agar mudah dicari, dikelompokkan, dihitung biayanya, dan dipakai sebagai target izin serta deploy. Mencakup konvensi nama, cara menerapkan tag lewat Terraform dan bootstrap, aktivasi cost allocation tag, Resource Group, dan pemeriksa otomatis di CI. HCL dan script adalah ilustrasi: verifikasi saat implementasi.

Status: draft v1

## 1. Skema tag

| Key | Nilai | Wajib | Sumber | Dipakai untuk |
|---|---|---|---|---|
| `Project` | `lore` | Ya | `default_tags` provider | Filter biaya, Resource Group, kondisi IAM dan SSM |
| `Environment` | `prod` | Ya | `default_tags` | Filter biaya, kondisi IAM dan SSM |
| `ManagedBy` | `terraform`, `bootstrap`, `manual`, atau `github-actions` | Ya | `default_tags` (terraform). Bootstrap dan manual lewat `--tags` | Menemukan resource yang tidak dikelola Terraform |
| `Repo` | `Nnaory/lore` | Ya | `default_tags` | Menelusuri ke sumber kode |
| `Component` | `network`, `web`, `api`, `nat`, `db`, `iam`, `budget`, `bootstrap`, `animation` | Ya | `tags` per resource | Target deploy SSM, filter biaya, kondisi IAM |
| `Name` | `lore-prod-<component>[-detail]` | Ya untuk tipe yang tampil di console | `tags` per resource | Nama yang terlihat di console |

Nilai `ManagedBy`:

| Nilai | Dipakai oleh |
|---|---|
| `terraform` | Resource yang dibuat `infra/` |
| `bootstrap` | Bucket state, OIDC provider, role GitHub, policy guardrail, budget, anomaly monitor |
| `manual` | Parameter SSM secret yang dibuat manual |
| `github-actions` | Parameter `image_tag` yang dibuat job deploy, termasuk `/lore/prod/verifier/release/image_tag` yang dibuat `scripts/ci/verifier-release.sh` |

**Component `animation` (R14).** Semua resource fitur animasi yang dibuat `infra/animation.tf` (bucket S3, repositori ECR, fungsi Lambda, log group, security group, dan role eksekusi) memakai `Component = "animation"` dan `Name = "lore-prod-animation-<detail>"`. Pengecualian yang disengaja: parameter SSM env fitur ini (`ANIMATION_*` dan `AWS_REGION` di `/lore/prod/api/env/`) memakai `Component = "api"` dan `Name = "lore-prod-api-env-<nama huruf kecil>"`, karena dibaca container api dan dirender ke `.env` oleh `render-env.sh` seperti parameter api lain. Target deploy SSM `Key=tag:Component,Values=api` tidak berubah karena tidak ada instance baru. Nilai `animation` ditambahkan ke `ALLOWED_COMPONENTS` di `scripts/ci/policy_rules.py` supaya pemeriksa tag menerimanya.

Tidak ada tag `Owner` atau `CostCenter` secara default (Q17). Menambah key baru berarti mengubah dokumen ini, `default_tags`, dan pemeriksa CI sekaligus.

## 2. Konvensi nama

Format `lore-<env>-<component>[-detail]`, huruf kecil, dipisah tanda hubung. Contoh:

| Resource | Nama |
|---|---|
| VPC | `lore-prod-vpc` |
| Subnet | `lore-prod-public-a`, `lore-prod-app-a`, `lore-prod-data-a`, `lore-prod-data-b` |
| Route table | `lore-prod-public-rt`, `lore-prod-app-rt`, `lore-prod-data-rt` |
| Instance | `lore-prod-web`, `lore-prod-api`, `lore-prod-nat` |
| EIP | `lore-prod-web-eip`, `lore-prod-nat-eip` |
| Volume root | `lore-prod-web-root`, `lore-prod-api-root`, `lore-prod-nat-root` |
| Security group | `lore-prod-web`, `lore-prod-api`, `lore-prod-nat`, `lore-prod-rds` |
| RDS | `lore-prod-db` |
| Role instance | `lore-prod-web-instance`, `lore-prod-api-instance`, `lore-prod-nat-instance` |
| Role GitHub | `lore-gh-plan`, `lore-gh-apply`, `lore-gh-deploy` |
| Bucket state | `lore-tfstate-<ACCOUNT_ID>` |
| Budget | `lore-prod-monthly`, `lore-prod-guardrail` |
| Bucket animasi (R14) | `lore-prod-animations-<ACCOUNT_ID>`, tag `Name=lore-prod-animation-bucket` |
| ECR dan fungsi Lambda verifier (R14) | Repositori dan fungsi `lore-prod-animation-verifier`. Tag `Name=lore-prod-animation-ecr` dan `Name=lore-prod-animation-verifier` |
| Log group, security group, role eksekusi verifier (R14) | `/aws/lambda/lore-prod-animation-verifier` (tag `Name=lore-prod-animation-logs`), `lore-prod-animation-verifier` (tag `Name=lore-prod-animation-verifier-sg`), `lore-prod-animation-verifier-exec` |
| Parameter SSM env animasi (R14) | `/lore/prod/api/env/ANIMATION_*` dan `AWS_REGION`, tag `Name=lore-prod-api-env-<nama huruf kecil>`, `Component=api` |

## 3. Penerapan di Terraform

`default_tags` memberi tag ke semua resource yang mendukungnya. `Component` dan `Name` ditulis per resource.

```hcl
provider "aws" {
  region = var.region
  default_tags {
    tags = local.common_tags
  }
}

locals {
  name_prefix = "lore-${var.environment}"
  common_tags = {
    Project     = "lore"
    Environment = var.environment
    ManagedBy   = "terraform"
    Repo        = "Nnaory/lore"
  }
}

resource "aws_instance" "web" {
  # ...
  tags = {
    Name      = "${local.name_prefix}-web"
    Component = "web"
  }
  volume_tags = merge(local.common_tags, {
    Name      = "${local.name_prefix}-web-root"
    Component = "web"
  })
}
```

Catatan:

- `default_tags` tidak otomatis mengalir ke `volume_tags` pada `aws_instance` [belum diverifikasi]. Karena itu `volume_tags` ditulis eksplisit dengan `merge(local.common_tags, ...)`.
- ENI, EIP, snapshot, dan volume turunan dicek setelah apply pertama untuk memastikan tag ada. Tag yang tidak mengalir ditambahkan eksplisit.
- Resource tanpa dukungan tag (misalnya asosiasi route table) tidak perlu tag. Pemeriksa CI hanya memeriksa resource yang punya `tags_all`.
- Parameter SSM yang dikelola Terraform mendapat tag dari `default_tags`.

## 4. Penerapan di bootstrap dan resource manual

- Script bootstrap memakai `--tags` pada setiap pembuatan resource: `ManagedBy=bootstrap`, `Project=lore`, `Environment=prod`, `Repo=Nnaory/lore`, dan `Component` sesuai jenis (`bootstrap` untuk bucket dan OIDC provider, `iam` untuk role dan policy, `budget` untuk budget).
- Parameter SSM secret dibuat dengan tag `ManagedBy=manual` saat pembuatan pertama (contoh perintah di [03-compute.md](./03-compute.md)).
- Parameter `image_tag` diberi tag `ManagedBy=github-actions` sekali lewat `aws ssm add-tags-to-resource` karena `--tags` tidak boleh dipakai bersama `--overwrite` [belum diverifikasi]. Untuk `/lore/prod/verifier/release/image_tag` (dibuat `verifier-release.sh`) tag `Component` bernilai `animation`.

## 5. Aktivasi cost allocation tag

Tag baru bisa dipakai di Cost Explorer setelah diaktifkan sebagai cost allocation tag di Billing.

1. Tunggu sampai tag muncul pada resource nyata (setelah R3 dan R4). Kunci tag baru terdaftar di Billing setelah sekitar 24 jam [belum diverifikasi].
2. Aktifkan `Project`, `Environment`, dan `Component`:

```bash
aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status TagKey=Project,Status=Active TagKey=Environment,Status=Active TagKey=Component,Status=Active
```

3. Alternatif: resource Terraform `aws_ce_cost_allocation_tag` (verifikasi ketersediaan di provider yang dipin). Default: lewat CLI di runbook, karena aksi ini butuh izin `ce:*` yang tidak dimiliki role apply.
4. Data biaya per tag hanya berlaku untuk biaya setelah aktivasi dan baru muncul setelah sekitar 24 jam [belum diverifikasi].

## 6. Resource Group

Resource Group berbasis tag gratis dan memberi satu tampilan semua resource lore.

```hcl
resource "aws_resourcegroups_group" "lore" {
  name = "lore-prod"
  resource_query {
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters = [
        { Key = "Project", Values = ["lore"] },
        { Key = "Environment", Values = ["prod"] }
      ]
    })
  }
}
```

Perintah pencarian cepat:

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=lore \
  --query 'ResourceTagMappingList[].ResourceARN'
```

## 7. Tag di IAM dan deploy

- Role deploy hanya boleh mengirim command ke instance dengan `Project=lore` dan `Environment=prod` (kunci kondisi `ssm:resourceTag/Project` dan `ssm:resourceTag/Environment`, verifikasi saat implementasi). Lihat [02-iam-and-oidc.md](./02-iam-and-oidc.md).
- Target deploy memakai `Key=tag:Component,Values=web` atau `api` ([03-compute.md](./03-compute.md) bagian 7). Perubahan nilai `Component` pada instance berarti mengubah target deploy, jadi harus lewat PR.
- Akses Session Manager untuk admin dibatasi ke instance ber-tag `Project=lore`.

## 8. Pemeriksa tag di CI

Script `scripts/ci/check-tags` (Python atau shell dengan `jq`) dijalankan di job `plan` pada `infra.yml` terhadap `plan.json` (hasil `terraform show -json tfplan`).

Aturan:

1. Untuk setiap entri `resource_changes[]` yang aksinya bukan `delete` saja dan `change.after` memuat `tags_all`, kunci `Project`, `Environment`, `ManagedBy`, dan `Repo` harus ada. Nilai `Project` harus `lore`.
2. Kunci `Component` wajib untuk semua resource bertag, kecuali daftar pengecualian tipe pendukung (misalnya `aws_vpc_security_group_ingress_rule`, `aws_vpc_security_group_egress_rule`, `aws_db_parameter_group`).
3. Kunci `Name` wajib untuk tipe: `aws_vpc`, `aws_subnet`, `aws_route_table`, `aws_internet_gateway`, `aws_security_group`, `aws_instance`, `aws_eip`, `aws_db_instance`, `aws_vpc_endpoint`, dan sejak R14 `aws_lambda_function`, `aws_ecr_repository`, `aws_s3_bucket`.
4. Nilai `Component` harus salah satu dari daftar di bagian 1.
5. Job gagal dan mencetak daftar resource yang melanggar.

Nilai `tags_all` pada saat plan harus sudah diketahui untuk resource baru. Jika tidak, pemeriksa membaca `tags` dan `default_tags` dari konfigurasi provider [belum diverifikasi: ketersediaan `tags_all` pada plan JSON].

Ilustrasi pemeriksa dengan `jq` (potongan):

```bash
required='["Project","Environment","ManagedBy","Repo"]'
jq -r --argjson req "$required" '
  .resource_changes[]
  | select(.change.after != null and (.change.after | has("tags_all")))
  | select(.change.actions != ["delete"])
  | . as $r
  | ($req - ($r.change.after.tags_all | keys)) as $missing
  | select(($missing | length) > 0)
  | "\($r.address): kurang tag \($missing | join(","))"
' plan.json
```

## 9. Pencarian resource yatim

- Gunakan Resource Group dan `resourcegroupstaggingapi` untuk menemukan resource ber-tag lore yang tidak dikenal Terraform (`ManagedBy` selain `terraform`).
- Gunakan Tag Editor di console untuk resource tanpa tag `Project`.
- AWS Config tidak dipakai karena berbiaya ([07-cost-guardrails.md](./07-cost-guardrails.md)).

## 10. Tag policy (opsional)

AWS Organizations tag policy dapat memaksa key dan nilai tag, tetapi membutuhkan Organizations. Tidak dipakai secara default (Q17). Penegakan memakai pemeriksa CI di bagian 8.

## 11. Tag di sisi GitHub

- Label OCI pada image: `org.opencontainers.image.source`, `revision`, `created`.
- Tag image `sha-<7 char>` melacak commit. Tidak ada tag `latest`.
- Prefix commit dan branch mengikuti [05-cicd.md](./05-cicd.md) bagian 11.
