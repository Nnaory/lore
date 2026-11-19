# 02 IAM dan OIDC GitHub

**Tujuan dokumen.** Menjelaskan bagaimana GitHub Actions mendapat akses ke AWS tanpa access key statis, apa saja yang dibuat sekali dari laptop (bootstrap), izin tiap role, guardrail biaya di level IAM, dan role untuk instance. Semua JSON adalah ilustrasi untuk membantu implementasi, bukan file yang sudah dibuat. Nama action dan kunci kondisi diverifikasi saat implementasi.

Status: draft v1

## 1. Prinsip

- Tidak ada access key statis di GitHub. Pipeline memakai token OIDC berumur pendek.
- Satu role per tujuan: plan (baca saja), apply (ubah infra), deploy (rilis aplikasi).
- Izin dibatasi per service dan per prefix nama (`lore-prod-*`, `/lore/*`), bukan `FullAccess`.
- Explicit Deny dipakai untuk guardrail biaya dan untuk melindungi role, policy, budget, dan OIDC provider dari perubahan oleh pipeline.
- Pipeline tidak boleh mengubah izinnya sendiri. Role GitHub dan guardrail dibuat oleh bootstrap dari laptop dengan profil admin, bukan oleh Terraform.
- Secret runtime tidak pernah lewat GitHub atau Terraform. Lihat [03-compute.md](./03-compute.md).

## 2. Bootstrap (sekali, dari laptop)

Bootstrap dikerjakan oleh `infra/bootstrap/bootstrap.sh` (idempotent: setiap langkah mengecek dulu apakah resource sudah ada) dengan file `infra/bootstrap/policies/*.json`. Keduanya belum dibuat. Ini tugas R1 di [10-implementation-roadmap.md](./10-implementation-roadmap.md).

Parameter script (ilustrasi): `AWS_PROFILE` (profil admin), `AWS_REGION=ap-southeast-3`, `GITHUB_REPO=Nnaory/lore`, `ALERT_EMAIL=<EMAIL_ALERT>`, `BUDGET_USD=70`, `ALLOW_NAT_GATEWAY=false`.

Urutan langkah:

| # | Langkah | Catatan |
|---|---|---|
| 1 | Cek identitas (`aws sts get-caller-identity`) dan tampilkan akun serta region | Berhenti jika bukan akun yang dimaksud |
| 2 | Budget `lore-prod-monthly` dan `lore-prod-guardrail`, subscription email | Dibuat paling awal sebelum resource berbayar. Lihat [07-cost-guardrails.md](./07-cost-guardrails.md) |
| 3 | Cost Anomaly Detection (monitor per service dan subscription email) | Gratis |
| 4 | Bucket state `lore-tfstate-<ACCOUNT_ID>`: versioning, SSE-S3, block public access, lifecycle noncurrent version 90 hari, tag | `use_lockfile` menyimpan file `.tflock` di bucket yang sama, jadi DynamoDB tidak dibutuhkan |
| 5 | OIDC provider `token.actions.githubusercontent.com` (client id `sts.amazonaws.com`) | Lewati jika sudah ada. Akun yang sama dengan `zero-to-prod` kemungkinan sudah punya, dan `EntityAlreadyExists` itu normal [terverifikasi: zero-to-prod/explanation.md] |
| 6 | Cek atau atur STS `v2Token` | Region opt-in `ap-southeast-3` menolak token v1. Perintah: `aws iam set-security-token-service-preferences --global-endpoint-token-version v2Token` [terverifikasi: zero-to-prod/explanation.md] |
| 7 | Managed policy `lore-guardrail-deny` dan `lore-deny-new-spend` | Isi di bagian 5 |
| 8 | Tiga role GitHub dengan trust policy dan policy izin masing-masing | Bagian 3 dan 4 |
| 9 | Role `lore-budgets-action` (trust `budgets.amazonaws.com`) untuk action budget | Verifikasi saat implementasi |
| 10 | Cetak ARN tiga role dan perintah `gh variable set` yang perlu dijalankan | ARN dimasukkan ke `vars` GitHub |

Semua resource bootstrap diberi tag `ManagedBy=bootstrap` dan `Component` sesuai jenisnya (`bootstrap`, `iam`, `budget`). Role apply tidak boleh mengubah satu pun dari resource ini (bagian 5).

Aktivasi cost allocation tag tidak termasuk bootstrap. Kunci tag baru bisa diaktifkan setelah muncul di resource, jadi langkah itu ada di runbook setelah R3 dan R4 ([08-tagging.md](./08-tagging.md)).

## 3. Trust policy

Semua role GitHub memakai provider yang sama dan `aud = sts.amazonaws.com`. Klaim `sub` dicocokkan persis dengan `StringEquals`, bukan wildcard.

| Role | Nilai `sub` yang diizinkan | Dipakai oleh |
|---|---|---|
| `lore-gh-plan` | `repo:Nnaory/lore:pull_request` dan `repo:Nnaory/lore:ref:refs/heads/main` | Job `plan` di `infra.yml` (PR dan push ke main) |
| `lore-gh-apply` | `repo:Nnaory/lore:environment:production` | Job `apply` di `infra.yml` |
| `lore-gh-deploy` | `repo:Nnaory/lore:environment:production-release` | Job `deploy` di `release-web.yml` dan `release-api.yml` |

Catatan Environment: satu Environment hanya punya satu konfigurasi proteksi. Karena apply infra harus butuh persetujuan sedangkan rilis aplikasi berjalan otomatis (Q22), dipakai dua Environment: `production` (reviewer wajib, hanya branch `main`) dan `production-release` (tanpa reviewer, hanya branch `main`).

Ilustrasi trust policy untuk `lore-gh-apply`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:Nnaory/lore:environment:production"
        }
      }
    }
  ]
}
```

Untuk `lore-gh-plan`, nilai `sub` berupa array dua elemen. Pencocokan `sub` sensitif huruf besar dan kecil: gunakan `Nnaory/lore` persis seperti di GitHub. `zero-to-prod` pernah bermasalah dengan ini dan memakai pola wildcard dengan variasi huruf [terverifikasi: zero-to-prod/explanation.md, bagian troubleshooting]. Di lore, job "whoami" pada R1 mencetak klaim `sub` yang sebenarnya supaya nilainya bisa dicocokkan.

## 4. Izin per role

### 4.1 `lore-gh-plan` (baca saja)

| Izin | Rincian |
|---|---|
| Managed policy `ReadOnlyAccess` | Untuk refresh state dan plan |
| S3 state | `s3:ListBucket` pada bucket. `s3:GetObject` pada `lore/prod/*`. `s3:PutObject` dan `s3:DeleteObject` hanya pada objek `*.tflock` (file kunci `use_lockfile`) |
| Explicit Deny | `secretsmanager:GetSecretValue` dan `kms:Decrypt` |

Catatan penting: `ReadOnlyAccess` mengizinkan `ssm:GetParameter*`. Deny pada `ssm:GetParameter*` untuk path `/lore/*/env/*` sengaja tidak dipakai, karena Terraform harus membaca parameter non-secret di path itu saat refresh. Nilai secret (SecureString) tetap tidak terbaca karena `kms:Decrypt` di-deny. Rule di bagian 8 juga menyatakan bahwa tfstate tidak boleh berisi secret, sebab role plan bisa membaca state.

### 4.2 `lore-gh-apply`

Allow per service (ilustrasi, verifikasi nama action saat implementasi):

| Service | Izin | Pembatas |
|---|---|---|
| EC2 dan VPC | `ec2:*` (instance, VPC, subnet, SG, EIP, route, endpoint, volume, tag) | `aws:RequestedRegion = ap-southeast-3`. Dibatasi lagi oleh guardrail di bagian 5 |
| RDS | `rds:*` | Region yang sama. Dibatasi guardrail |
| SSM Parameter Store | `ssm:PutParameter`, `GetParameter`, `GetParameters`, `DeleteParameter`, `AddTagsToResource`, `ListTagsForResource` | Resource `arn:aws:ssm:ap-southeast-3:<ACCOUNT_ID>:parameter/lore/*`. `ssm:DescribeParameters` pada `*` |
| Secrets Manager | `DescribeSecret`, `TagResource`, `GetResourcePolicy`, aksi yang dibutuhkan RDS untuk membuat secret master | Tanpa `GetSecretValue`. Daftar aksi untuk `manage_master_user_password` diverifikasi saat implementasi |
| KMS | Aksi yang dibutuhkan EBS dan RDS untuk kunci AWS-managed (`DescribeKey`, `CreateGrant`, dan sejenisnya) | Dibatasi `kms:ViaService` untuk `ec2` dan `rds`. Tanpa `kms:CreateKey` dan tanpa `kms:Decrypt` langsung |
| S3 state | `s3:ListBucket` pada bucket. `Get`, `Put`, `DeleteObject` pada `lore/prod/*` | Hanya bucket state |
| Resource Groups | `resource-groups:*` | Group `lore-prod` |
| IAM | `CreateRole`, `DeleteRole`, `GetRole`, `UpdateAssumeRolePolicy`, `TagRole`, `Put/DeleteRolePolicy`, `Attach/DetachRolePolicy`, `ListRolePolicies`, `ListAttachedRolePolicies`, `CreateInstanceProfile`, `DeleteInstanceProfile`, `AddRoleToInstanceProfile`, `RemoveRoleFromInstanceProfile`, `GetInstanceProfile`, `TagInstanceProfile` | Resource `role/lore-prod-*`, `instance-profile/lore-prod-*`, `policy/lore-prod-*` |
| IAM PassRole | `iam:PassRole` | Hanya ke `role/lore-prod-*` dengan `iam:PassedToService = ec2.amazonaws.com` |
| IAM service-linked role | `iam:CreateServiceLinkedRole` | Hanya `rds.amazonaws.com` (jika belum ada) |

Ilustrasi pembatas IAM (potongan):

```json
{
  "Sid": "IamOnlyLoreProdNames",
  "Effect": "Allow",
  "Action": ["iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole",
             "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy",
             "iam:DetachRolePolicy", "iam:UpdateAssumeRolePolicy"],
  "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/lore-prod-*"
},
{
  "Sid": "PassOnlyToEc2",
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/lore-prod-*",
  "Condition": {"StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}}
}
```

Izin ini tidak mencakup `budgets:*`, `ce:*`, `organizations:*`, perubahan OIDC provider, maupun role `lore-gh-*`. Izin akan diperketat dengan data CloudTrail dan IAM Access Analyzer setelah beberapa kali apply (bagian 9).

### 4.3 `lore-gh-deploy`

| Izin | Rincian |
|---|---|
| `ssm:SendCommand` pada dokumen | `arn:aws:ssm:ap-southeast-3::document/AWS-RunShellScript` |
| `ssm:SendCommand` pada instance | `arn:aws:ec2:ap-southeast-3:<ACCOUNT_ID>:instance/*` dengan kondisi tag `ssm:resourceTag/Project = lore` dan `ssm:resourceTag/Environment = prod` (verifikasi kunci kondisi) |
| Hasil command | `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations`, `ssm:ListCommands` pada `*` |
| Tag rilis | `ssm:PutParameter` dan `ssm:GetParameter` pada `arn:aws:ssm:ap-southeast-3:<ACCOUNT_ID>:parameter/lore/prod/*/release/image_tag` |
| Status instance | `ec2:DescribeInstances`, `ssm:DescribeInstanceInformation` |
| Dilarang | Semua izin infra, IAM, RDS, S3, KMS |

### 4.4 Ringkasan guardrail untuk plan dan deploy

Role plan dan deploy tidak punya izin membuat resource. Hanya role apply yang bisa, dan role itulah yang dikunci oleh guardrail.

## 5. Guardrail IAM

Dua managed policy dibuat oleh bootstrap, bukan Terraform.

### 5.1 `lore-guardrail-deny`

Selalu menempel pada `lore-gh-apply`. Berisi Deny bersyarat. Ringkasan statement:

| Sid | Aksi yang ditolak | Kondisi |
|---|---|---|
| `DenyNonMicroInstances` | `ec2:RunInstances` | Tipe instance bukan `t3.micro` (`ec2:InstanceType`) |
| `DenyBigVolumes` | `ec2:RunInstances`, `ec2:CreateVolume` | `ec2:VolumeSize` lebih dari 30 |
| `DenyRdsOtherClasses`, `DenyRdsModifyOtherClass`, `DenyRdsMultiAz`, `DenyRdsBigStorage`, `DenyRdsPiops` | `rds:CreateDBInstance`, `rds:ModifyDBInstance`, `rds:RestoreDBInstance*` | Kelas bukan `db.t3.micro` (`rds:DatabaseClass`), `rds:MultiAz` true, `rds:StorageSize` lebih dari 50, atau `rds:Piops` lebih dari 3000 (mengizinkan baseline gratis `gp3` 3.000 IOPS sambil memblokir PIOPS berbayar; `io1`/`io2` Postgres juga tertolak oleh batas storage > 50 GB karena minimum 100 GB) |
| `DenyNatGateway` | `ec2:CreateNatGateway` | Selalu, kecuali bootstrap dijalankan dengan `ALLOW_NAT_GATEWAY=true` |
| `DenyLoadBalancers` | `elasticloadbalancing:CreateLoadBalancer` | Selalu |
| `DenyNonS3VpcEndpoints` | `ec2:CreateVpcEndpoint` | `ec2:VpceServiceName` selain `com.amazonaws.<AWS_REGION>.s3` (kunci kondisi terverifikasi di AWS Service Authorization Reference; memblokir VPC Interface Endpoint berbayar) |
| `DenyExpensiveServices` | `elasticache:*`, `es:*`, `wafv2:*`, `cloudfront:*`, `config:*`, `guardduty:*`, `inspector2:*`, `macie2:*`, `kms:CreateKey`, `route53:CreateHostedZone`, `rds:CreateDBCluster`, `rds:CreateDBProxy` | Selalu |
| `ProtectGovernance` | `iam:*` pada `role/lore-gh-*`, `policy/lore-guardrail*`, `policy/lore-deny-new-spend`, OIDC provider. `budgets:*`. `ce:*` | Selalu |
| `NoIamUsersOrKeys` | `iam:CreateUser`, `iam:CreateAccessKey`, `iam:AttachUserPolicy`, `iam:PutUserPolicy` | Selalu |

Ilustrasi tiga statement pertama:

```json
{
  "Sid": "DenyNonMicroInstances",
  "Effect": "Deny",
  "Action": "ec2:RunInstances",
  "Resource": "arn:aws:ec2:*:*:instance/*",
  "Condition": {"StringNotEquals": {"ec2:InstanceType": "t3.micro"}}
},
{
  "Sid": "DenyBigVolumes",
  "Effect": "Deny",
  "Action": ["ec2:RunInstances", "ec2:CreateVolume"],
  "Resource": "arn:aws:ec2:*:*:volume/*",
  "Condition": {"NumericGreaterThan": {"ec2:VolumeSize": "30"}}
},
{
  "Sid": "DenyRdsOtherClasses",
  "Effect": "Deny",
  "Action": ["rds:CreateDBInstance", "rds:RestoreDBInstanceFromDBSnapshot"],
  "Resource": "*",
  "Condition": {"StringNotEquals": {"rds:DatabaseClass": "db.t3.micro"}}
}
```

Peringatan implementasi:

- Kunci kondisi `ec2:InstanceType`, `rds:DatabaseClass`, `rds:MultiAz`, `rds:StorageSize`, `ec2:VolumeSize`, dan `ec2:VpcEndpointType` [belum diverifikasi]. Verifikasi di dokumentasi "Service Authorization Reference" saat menulis policy.
- Operator negatif seperti `StringNotEquals` bernilai true jika kunci tidak ada di request. Untuk `ModifyDBInstance` yang tidak menyertakan kelas, Deny akan menolak semua modifikasi. Tambahkan guard `Null` (`"Null": {"rds:DatabaseClass": "false"}`) agar Deny hanya berlaku jika kunci ada, lalu uji dengan `aws iam simulate-principal-policy` [belum diverifikasi].
- Uji guardrail dengan simulasi sebelum dipakai: coba `RunInstances` bertipe `t3.small` dan pastikan ditolak.

### 5.2 `lore-deny-new-spend`

Tidak menempel secara default. Budget action `lore-prod-guardrail` menempelkannya ke `lore-gh-apply` saat pengeluaran aktual mencapai 100% budget. Isinya Deny untuk `ec2:RunInstances`, `ec2:CreateVolume`, `ec2:AllocateAddress`, `ec2:CreateNatGateway`, dan `rds:Create*`. Pelepasan dilakukan manual oleh admin. Role eksekusi action adalah `lore-budgets-action`, dengan trust `budgets.amazonaws.com` dan izin `iam:AttachRolePolicy` serta `iam:DetachRolePolicy` terbatas pada role `lore-gh-apply` dan policy `lore-deny-new-spend` [belum diverifikasi, termasuk trust dan izin minimalnya].

## 6. Role instance

Setiap instance punya role dan instance profile sendiri dengan nama yang sama.

| Role | Izin |
|---|---|
| `lore-prod-web-instance` | `AmazonSSMManagedInstanceCore`. `ssm:GetParameter`, `GetParameters`, `GetParametersByPath` pada `arn:aws:ssm:ap-southeast-3:<ACCOUNT_ID>:parameter/lore/prod/web/*` |
| `lore-prod-api-instance` | `AmazonSSMManagedInstanceCore`. Akses parameter yang sama untuk `parameter/lore/prod/api/*`. `secretsmanager:GetSecretValue` hanya pada ARN secret master RDS. Kunci KMS AWS-managed biasanya tidak butuh izin KMS eksplisit di role (verifikasi) |
| `lore-prod-nat-instance` | `AmazonSSMManagedInstanceCore` saja |

Catatan:

- Role web tidak bisa membaca parameter api, dan sebaliknya. Kunci Gemini hanya ada di path komponen yang memakainya.
- Role api tidak punya izin membaca secret lain di Secrets Manager.
- IMDSv2 wajib dan `http_put_response_hop_limit = 1`, sehingga container Docker (satu hop tambahan) tidak bisa mengambil kredensial instance.

## 7. Siapa boleh apa

| Pelaku | Membaca state dan resource | Mengubah infra | Rilis aplikasi | Membaca secret runtime | Akses instance |
|---|---|---|---|---|---|
| `lore-gh-plan` | Ya | Tidak | Tidak | Tidak | Tidak |
| `lore-gh-apply` | Ya | Ya, dibatasi guardrail | Tidak | Tidak | Tidak |
| `lore-gh-deploy` | Terbatas (status instance) | Tidak | Ya (SSM Run Command, tag rilis) | Tidak | Hanya menjalankan script deploy |
| `lore-prod-web-instance` | Parameter web | Tidak | Tidak | Parameter web | Dirinya sendiri |
| `lore-prod-api-instance` | Parameter api | Tidak | Tidak | Parameter api dan secret RDS | Dirinya sendiri |
| `lore-prod-nat-instance` | Tidak | Tidak | Tidak | Tidak | Dirinya sendiri |
| Admin manusia (IAM user ber-MFA) | Ya | Ya (bootstrap dan teardown) | Ya | Ya | `ssm:StartSession` ke instance ber-tag `Project=lore` |
| Budget action `lore-budgets-action` | Tidak | Hanya menempel dan melepas `lore-deny-new-spend` | Tidak | Tidak | Tidak |

## 8. Keamanan repo publik

Repo `Nnaory/lore` publik. Aturan berikut berlaku untuk semua workflow.

- Jangan pernah memakai trigger `pull_request_target` yang menjalankan kode dari PR.
- PR dari fork tidak mendapat token OIDC. Job plan tetap diberi `if: github.event.pull_request.head.repo.full_name == github.repository` sebagai lapis kedua.
- Aktifkan persetujuan workflow untuk kontributor baru (Settings, Actions, "Require approval for first-time contributors").
- Tidak ada secret di GitHub untuk infra. Hanya `vars` yang berisi ARN role dan region.
- Role plan bisa membaca tfstate. Karena itu tfstate tidak boleh memuat secret (lihat [03-compute.md](./03-compute.md) soal parameter SSM).
- Log Actions, komentar PR, dan artifact di repo publik bisa dilihat publik. Plan Terraform memuat ARN dengan ID akun. Mitigasi ada di [05-cicd.md](./05-cicd.md) dan Q12.
- IMDSv2 dengan hop limit 1 mencegah container membaca kredensial role instance.

## 9. Pencegahan eskalasi dan pemeliharaan

- Pipeline tidak punya izin mengubah role GitHub, guardrail, OIDC provider, atau budget (`ProtectGovernance`).
- Pipeline tidak boleh membuat IAM user atau access key (`NoIamUsersOrKeys`).
- Opsi hardening: permission boundary pada semua role `lore-prod-*` yang dibuat apply, dengan syarat `iam:PermissionsBoundary` pada `CreateRole`. Dicatat sebagai opsi, bukan default.
- Setelah beberapa apply, tinjau CloudTrail dan IAM Access Analyzer untuk menyempitkan izin apply (Access Analyzer dasar gratis [belum diverifikasi]).
- Prosedur bootstrap dan verifikasi ada di [09-runbook.md](./09-runbook.md).
