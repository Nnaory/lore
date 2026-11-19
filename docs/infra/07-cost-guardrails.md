# 07 Biaya dan guardrail

**Tujuan dokumen.** Menetapkan batas biaya AWS untuk lore: estimasi bulanan, daftar layanan yang boleh dan tidak boleh dipakai, lima lapis penegakan, dan kebiasaan pemantauan. AWS tidak punya batas pengeluaran keras, jadi dokumen ini berfokus pada tiga hal yang bisa dilakukan: mencegah resource mahal terbentuk, memberi peringatan dini, dan memasang satu aksi otomatis. Semua harga harus dihitung ulang dengan AWS Pricing Calculator saat implementasi.

Status: draft v1

## 1. Prinsip

- Tidak ada cara memasang batas keras pada tagihan AWS. Budget memberi peringatan dan aksi, tetapi data biaya terlambat sampai beberapa jam [belum diverifikasi: frekuensi evaluasi Budgets dan lag billing].
- Pertahanan berlapis: kode Terraform tidak memuat resource mahal, IAM menolaknya walau kode salah, Budgets memperingatkan, anomaly detection menangkap lonjakan, CI memeriksa plan.
- Utamakan layanan gratis. Setiap layanan berbayar harus ada di allowlist dengan alasan.
- Biaya yang terlihat kecil tetapi tetap berjalan (IPv4 publik, secret, snapshot) dicatat di watchlist.

## 2. Estimasi biaya bulanan

Basis harga us-east-2 dari ingatan, kecuali yang diberi label terverifikasi. Jakarta (`ap-southeast-3`) kemungkinan lebih mahal dan belum dihitung. 730 jam per bulan.

| Komponen | Perhitungan | Perkiraan | Label |
|---|---|---|---|
| 3 instance `t3.micro` (web, api, nat) | 0,0104 x 730 x 3 | sekitar US$23 | [belum diverifikasi] |
| RDS `db.t3.micro` PostgreSQL single-AZ | 0,018 x 730 | sekitar US$13 | [belum diverifikasi] |
| Storage RDS 20 GB gp3 | 20 x 0,115 | sekitar US$2,3 | [belum diverifikasi] |
| EBS gp3 root 32 GB (12 + 12 + 8) | 32 x 0,08 | sekitar US$2,6 | [belum diverifikasi] |
| 2 IPv4 publik (EIP web dan EIP nat) | 2 x 0,005 x 730 | US$7,3 | [terverifikasi: aws.amazon.com/vpc/pricing] |
| Secrets Manager, 1 secret (master RDS) | per secret per bulan | US$0,4 | [belum diverifikasi] |
| S3 state, SSM Parameter Store standard, Budgets, lain-lain | - | di bawah US$1 | Budgets: [terverifikasi: aws.amazon.com/aws-cost-management/aws-budgets/pricing] |
| **Total** | | **sekitar US$50** | |

Budget alert US$70 dipilih dengan margin sekitar 40% di atas estimasi us-east-2 untuk menutup selisih harga Jakarta dan biaya kecil yang tidak terduga. Angka final ditentukan setelah perhitungan dengan Pricing Calculator (Q8).

Data transfer keluar ke internet dan trafik NAT berbiaya per GB di luar kuota gratis. Trafik lore berupa teks JSON kecil, sehingga diperkirakan tidak signifikan, tetapi dipantau.

## 3. Biaya alternatif

| Alternatif | Selisih per bulan | Catatan |
|---|---|---|
| NAT Gateway menggantikan NAT instance | sekitar +US$25 bersih | NAT Gateway US$0,045 per jam (sekitar US$33) dan US$0,045 per GB [terverifikasi: aws.amazon.com/vpc/pricing, us-east-2], dikurangi NAT instance dan EBS-nya sekitar US$8. EIP tetap ada |
| NAT Gateway per AZ | Tambahan US$33 per AZ tambahan | Tidak relevan selama single-AZ |
| ALB di depan web | sekitar +US$20 | ALB sekitar US$16 per bulan ditambah LCU, dan 2 IPv4 publik, dikurangi satu EIP web [belum diverifikasi] |
| Multi-AZ RDS | sekitar dua kali biaya RDS (+US$15) | Non-goal HA |
| `db.t4g.micro` | sedikit lebih murah (sekitar US$1 sampai 2) | Q10. Verifikasi ketersediaan di Jakarta |
| NAT `t3.nano` | sekitar -US$4 | Menyimpang dari instruksi t3.micro (Q9) |
| ECR menggantikan GHCR | Berbiaya storage dan transfer | Keluar dari prinsip gratis |
| Staging kedua | sekitar +US$50 | Q13 |

## 4. Allowlist dan denylist

### 4.1 Allowlist

| Layanan | Batasan |
|---|---|
| VPC, subnet, IGW, route table, security group | Tanpa biaya |
| S3 gateway endpoint | Tanpa biaya jam atau data [terverifikasi: aws.amazon.com/vpc/pricing] |
| EC2 | Hanya `t3.micro`, `cpu_credits = "standard"` |
| EBS | gp3 kecil (maksimum 30 GB per volume), terenkripsi dengan kunci AWS-managed |
| Elastic IP | Hanya yang terpasang (EIP idle tetap ditagih, US$0,005 per jam [terverifikasi: aws.amazon.com/vpc/pricing]) |
| RDS | Hanya `db.t3.micro`, single-AZ, gp3, storage maksimum 50 GB |
| SSM | Parameter Store tier standard, Session Manager, Run Command |
| IAM | Role, policy, instance profile |
| S3 | Hanya bucket state |
| Secrets Manager | Satu secret (master RDS) |
| AWS Budgets, Cost Anomaly Detection | Gratis dalam batas yang ditetapkan |
| Resource Groups | Gratis |

### 4.2 Denylist

| Layanan atau fitur | Alasan |
|---|---|
| NAT Gateway | Biaya tetap besar. Hanya jika bootstrap diubah (`ALLOW_NAT_GATEWAY=true`) |
| ALB, NLB, GWLB | Biaya tetap |
| Interface VPC endpoint (PrivateLink) | Biaya per jam per AZ dan per GB |
| Multi-AZ RDS, io1/io2 atau provisioned IOPS | Biaya berlipat |
| RDS Proxy, Aurora, ElastiCache, OpenSearch | Biaya tetap besar |
| WAF, CloudFront | Tidak dibutuhkan saat ini |
| AWS Config, GuardDuty, Inspector, Macie | Berbiaya per resource atau per event |
| KMS CMK | US$1 per kunci per bulan. Pakai kunci AWS-managed [belum diverifikasi: harga] |
| CloudWatch Logs dan VPC Flow Logs | Biaya ingestion dan storage. Log lewat `docker logs` via SSM |
| Route 53 hosted zone | Biaya per zona. Pakai DNS di luar AWS |
| Secret Secrets Manager tambahan | US$0,4 per secret. Pakai SSM SecureString |
| Parameter SSM tier advanced | Berbiaya |
| EBS dan snapshot yatim, EIP idle | Biaya tersembunyi |

## 5. Lima lapis penegakan

| Lapis | Mekanisme | Siapa yang menjaga |
|---|---|---|
| 1. Kode | Validasi variabel Terraform (`contains(["t3.micro"], var.instance_type)`, `contains(["db.t3.micro"], var.db_instance_class)`, batas ukuran volume). Tidak ada resource denylist di kode | Reviewer PR dan CI |
| 2. IAM | Policy `lore-guardrail-deny` pada role `lore-gh-apply` (Deny bersyarat). Detail di [02-iam-and-oidc.md](./02-iam-and-oidc.md) | AWS menolak request walau Terraform salah |
| 3. Budgets | `lore-prod-monthly` dan `lore-prod-guardrail` (bagian 6) | AWS Budgets |
| 4. Anomaly | Cost Anomaly Detection per service dengan email | AWS |
| 5. CI | `scripts/ci/check-cost` pada `plan.json` (tipe instance, resource terlarang, ukuran volume) dan `check-cost-static` pada file `.tf` | `ci.yml` dan `infra.yml` |

Lapis 2 diuji dengan `aws iam simulate-principal-policy` sebelum dipakai: coba `ec2:RunInstances` bertipe `t3.small` dan `rds:CreateDBInstance` kelas `db.t3.small`, dan pastikan ditolak. Kunci kondisi IAM diverifikasi di Service Authorization Reference [belum diverifikasi].

Contoh pemeriksa biaya pada plan (ilustrasi):

```bash
# Gagalkan jika ada instance selain t3.micro
jq -e '[.resource_changes[]
        | select(.type=="aws_instance")
        | select(.change.after != null)
        | select(.change.after.instance_type != "t3.micro")] | length == 0' plan.json

# Gagalkan jika ada resource denylist
jq -e '[.resource_changes[]
        | select(.type | IN("aws_nat_gateway","aws_lb","aws_vpc_endpoint","aws_elasticache_cluster",
                            "aws_wafv2_web_acl","aws_cloudfront_distribution","aws_kms_key",
                            "aws_route53_zone","aws_cloudwatch_log_group"))
        | select(.change.actions != ["no-op"])] | length == 0' plan.json
```

Pengecualian resmi (misalnya `aws_nat_gateway` saat `nat_mode = "gateway"`) membutuhkan perubahan di bootstrap dan di script pemeriksa, lewat PR terpisah.

## 6. AWS Budgets

Dibuat oleh bootstrap (tugas R1), bukan Terraform, agar pipeline tidak bisa mengubahnya.

| Budget | Jenis | Nilai | Notifikasi atau aksi |
|---|---|---|---|
| `lore-prod-monthly` | Cost, bulanan | US$70 | Email `<EMAIL_ALERT>` di 50%, 80%, 100% ACTUAL dan 100% FORECAST |
| `lore-prod-guardrail` | Cost, bulanan, dengan action | US$70 | Pada 100% ACTUAL: aksi `APPLY_IAM_POLICY` menempelkan `lore-deny-new-spend` ke role `lore-gh-apply` |

Catatan:

- Monitoring budget gratis. Dua budget pertama yang punya action gratis, berikutnya US$0,10 per hari per budget [terverifikasi: aws.amazon.com/aws-cost-management/aws-budgets/pricing]. Jangan membuat lebih dari dua budget ber-action.
- Aksi menempelkan policy memerlukan role eksekusi `lore-budgets-action` dengan trust `budgets.amazonaws.com` [belum diverifikasi: trust dan izin minimal].
- Aksi opsional (default OFF): menghentikan instance EC2 dan RDS pada 120% ACTUAL. Itu menyebabkan outage. RDS yang di-stop menyala lagi otomatis setelah 7 hari [belum diverifikasi]. Aktifkan hanya dengan keputusan sadar (Q8).
- Tag cost allocation baru muncul di data biaya sekitar 24 jam setelah diaktifkan [belum diverifikasi]. Budget berbasis total akun tidak bergantung pada tag.
- Preferensi billing (menerima alert billing dan free tier) diatur manual di console Billing, bukan lewat script.

## 7. Cost Anomaly Detection

Monitor tipe "AWS services" dan subscription email ke `<EMAIL_ALERT>` dengan ambang kecil. Gratis. Dibuat oleh bootstrap.

## 8. Watchlist biaya tersembunyi

| Item | Risiko | Pencegahan |
|---|---|---|
| T3 unlimited | Surplus CPU credit ditagih | `cpu_credits = "standard"`. Mode RDS dicek manual (04-database) |
| NAT Gateway | Biaya tetap besar | Deny IAM dan denylist |
| EIP idle | US$0,005 per jam per IP | Hanya EIP yang terpasang. Teardown memeriksa EIP |
| EBS dan snapshot yatim | Tagihan tanpa resource aktif | Teardown memeriksa volume dan snapshot. Tag memudahkan pencarian |
| Autoscaling storage RDS | Storage tumbuh tanpa disadari | `max_allocated_storage` tidak diset |
| Data transfer keluar | Per GB di atas kuota gratis | Trafik kecil. Pantau di Cost Explorer |
| CloudWatch Logs | Ingestion dan storage | Tidak dipakai. Rotasi log Docker lokal |
| Jumlah secret | US$0,4 per secret | Satu secret saja |
| Hosted zone, KMS CMK | Biaya bulanan tetap | Denylist |
| Snapshot final RDS | Biaya kecil selama tersimpan | Hapus saat teardown |
| Nilai secret di tfstate | Role plan bisa membaca state, dan state tersimpan di S3 | Secret tidak dikelola Terraform. Dibuat manual lewat `aws ssm put-parameter` ([03-compute.md](./03-compute.md) bagian 4). Audit di R11 |
| Instance RDS restore drill | Biaya per jam | Hapus segera setelah drill |

## 9. Batas gratis sisi GitHub

| Batas | Nilai | Sumber |
|---|---|---|
| Runner standar repo publik | Gratis | [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-actions] |
| Compute repo privat, plan Free | US$12 per bulan termasuk | [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-actions] |
| Cache Actions | 10 GB per repo | [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-actions] |
| Artifact dan Packages (dibagi) | 500 MB di plan Free | [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-packages] |
| Paket publik | Gratis. Container registry saat ini gratis | [terverifikasi: docs.github.com/en/billing/concepts/product-billing/github-packages] |

Risiko jika repo menjadi privat: kuota compute dan storage mulai berlaku, Environments butuh plan berbayar, dan pull GHCR dari instance butuh kredensial serta menghitung transfer paket privat (Q12).

## 10. Ritual pemantauan

Mingguan (sekitar 10 menit):

1. Cost Explorer, filter tag `Component` (setelah aktivasi), bandingkan dengan estimasi.
2. Halaman Billing dan Free Tier, cek peringatan.
3. Daftar anomali di Cost Anomaly Detection.
4. `aws ec2 describe-addresses` untuk EIP tanpa asosiasi, dan `describe-volumes` untuk volume `available`.
5. Metrik `CPUSurplusCreditsCharged` RDS selama bulan pertama.

Bulanan: tinjau hasil dengan estimasi, perbarui angka Budget bila perlu.

## 11. Teardown dan biaya setelahnya

Langkah teardown ada di [09-runbook.md](./09-runbook.md). Setelah teardown, biaya yang mungkin tersisa:

- Bucket state S3 (sen per bulan).
- Snapshot RDS yang belum dihapus.
- Secret Secrets Manager yang dijadwalkan hapus (masa tunggu).
- Budget dan anomaly monitor (gratis).

Verifikasi dengan Cost Explorer sehari setelah teardown dan periksa tidak ada NAT, EIP, volume, snapshot, atau ENI yang tersisa.

## 12. Laporan audit & baseline biaya R12 (19 Nov 2026)

Status pengecekan pada penutupan fase infra (R1–R12, tanpa menjalankan teardown destruktif agar `lore-prod-db` tetap berjalan):

- **Status akun (`aws freetier get-account-plan-state`):** `accountPlanType: FREE`, `ACTIVE`, sisa kredit promo **`$159.47 USD`** (berlaku s/d `2027-04-24`).
- **Baseline Cost Explorer (14 hari terakhir sebelum 19 Nov 2026):**
  - Net charge setelah kredit/offset: **`$0.00`**.
  - Gross tercatat awal: `Component=nat` (`$0.1149`), `Component=bootstrap` (`$0.00005`), `EC2 - Other` (`$0.000036`) seluruhnya tertutup kredit/Free Plan offset. (Komponen RDS & EC2 `web`/`api` terbaru baru tercermin penuh setelah ~24–48 jam uptime / evaluasi 7 hari.)
- **Penyesuaian guardrail `gp3` (R10):** `DenyRdsPiops` pada `lore-guardrail-deny.json` disesuaikan ke `rds:Piops > 3000` dan `scripts/ci/check-cost` mengizinkan `iops <= 3000` pada `storage_type = "gp3"` karena `gp3` RDS di `ap-southeast-3` memiliki baseline gratis `3.000` IOPS (`io1`/`io2` dan `> 3000` IOPS tetap ditolak).
- **Audit secret & hardening (R11):** Scan `s3://lore-tfstate-<ACCOUNT_ID>/lore/prod/terraform.tfstate`, 10 run GitHub Actions terbaru, dan `/var/log/cloud-init-output.log` EC2 `web` & `api` menunjukkan **0 secret leak**; `/opt/lore/.env` berizin `600 root:root`.
