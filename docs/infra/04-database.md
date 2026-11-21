# 04 Database: RDS PostgreSQL

**Tujuan dokumen.** Spesifikasi RDS PostgreSQL untuk data persisten lore: parameter instance, akses admin tanpa bastion, backup dan restore, strategi migrasi schema, sketsa tabel, dan cara teardown. Cukup rinci untuk menulis `infra/database.tf` dan migrasi awal. HCL dan SQL adalah ilustrasi: verifikasi saat implementasi.

Status: terimplementasi (R10)

## 1. Spesifikasi instance

| Atribut | Nilai | Catatan |
|---|---|---|
| Identifier | `lore-prod-db` | Tag `Component=db`, `Name=lore-prod-db` |
| Engine | PostgreSQL 16 (`engine_version = "16"`, `16.13` terpasang) | Mengisi hanya major menghindari drift saat minor di-upgrade otomatis |
| Minor upgrade | `auto_minor_version_upgrade = true` | |
| Kelas | `db.t3.micro` | Mengikuti instruksi "t3 micro". Alternatif `db.t4g.micro` di Q10 |
| Storage | gp3, 20 GB (baseline gratis 3.000 IOPS) | `max_allocated_storage` tidak diset, jadi storage autoscaling mati dan ukuran tidak tumbuh diam-diam |
| Enkripsi | `storage_encrypted = true`, kunci `aws/rds` | Tanpa CMK (berbiaya) |
| Multi-AZ | `multi_az = false` | Biaya sekitar dua kali lipat jika true. Non-goal HA |
| Akses | `publicly_accessible = false` | |
| Subnet group | `lore-prod-db-subnets` berisi `lore-prod-data-a` dan `lore-prod-data-b` | |
| Security group | `lore-prod-rds` (5432 dari `lore-prod-api`) | |
| Database | `db_name = "lore"` | |
| Master user | `username = "lore_admin"` | |
| Password | `manage_master_user_password = true` | Secret di Secrets Manager dikelola RDS. Tidak ada password di tfvars atau tfstate |
| Backup | `backup_retention_period = 1` | Backup otomatis harian + PITR 1 hari (diturunkan dari 7 ke 1 karena batas `FreeTierRestrictionError` pada AWS Free Account Plan) |
| Jendela backup | 18:30 sampai 19:30 UTC (01:30 sampai 02:30 WIB) | Di luar jam ramai |
| Jendela maintenance | `sun:20:00-sun:21:00` UTC (Senin 03:00 sampai 04:00 WIB) | Tidak tumpang tindih dengan backup |
| Snapshot | `copy_tags_to_snapshot = true`, `skip_final_snapshot = false`, `final_snapshot_identifier` diisi | Snapshot final kecil biayanya, hapus saat teardown |
| Proteksi | `deletion_protection = var.protect_data` (default `true`) | Lihat teardown (bagian 9) |
| Observability | `performance_insights_enabled = false`, `monitoring_interval = 0` | Tanpa biaya tambahan |
| Perubahan | `apply_immediately = false` | Perubahan menunggu jendela maintenance. Terapkan segera hanya dengan keputusan sadar |
| Parameter group | `lore-prod-pg16` (family `postgres16`) dengan `rds.force_ssl = 1` | Terverifikasi `ApplyType = dynamic` di `ap-southeast-3` (`describe-db-parameters`) |

Ilustrasi `database.tf` (potongan):

```hcl
resource "aws_db_instance" "db" {
  identifier        = "lore-prod-db"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.db_instance_class # divalidasi: "db.t3.micro"
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name                     = "lore"
  username                    = "lore_admin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.pg16.name
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period = 1
  backup_window           = "18:30-19:30"
  maintenance_window      = "sun:20:00-sun:21:00"
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade = true
  apply_immediately          = false
  deletion_protection        = var.protect_data
  skip_final_snapshot        = false
  final_snapshot_identifier  = "lore-prod-db-final"

  performance_insights_enabled = false
  monitoring_interval          = 0

  tags = { Name = "lore-prod-db", Component = "db" }
}
```

## 2. Catatan biaya

- Estimasi: sekitar US$15 sampai 16 per bulan (instance dan 20 GB gp3), basis us-east-2 [belum diverifikasi]. Lihat [07-cost-guardrails.md](./07-cost-guardrails.md).
- Mode kredit CPU RDS T3 mungkin unlimited secara default dan belum jelas apakah bisa diubah [belum diverifikasi]. Pantau metrik `CPUSurplusCreditsCharged` di console secara manual setiap minggu selama bulan pertama.
- Guardrail IAM menolak kelas selain `db.t3.micro`, Multi-AZ, provisioned IOPS, dan storage di atas batas ([02-iam-and-oidc.md](./02-iam-and-oidc.md)).
- Ketersediaan `db.t3.micro` dan Postgres 16 di `ap-southeast-3` dicek saat implementasi (`aws rds describe-orderable-db-instance-options`) [belum diverifikasi].

## 3. Koneksi dari aplikasi

Variabel lingkungan api:

| Variabel | Sumber |
|---|---|
| `PGHOST`, `PGPORT=5432`, `PGDATABASE=lore`, `PGSSLMODE=require` | Parameter SSM non-secret yang dikelola Terraform |
| `PGUSER`, `PGPASSWORD` | Dirender oleh `render-env.sh` dari secret master RDS ([03-compute.md](./03-compute.md)) |

Catatan:

- Memakai variabel `PG*` terpisah, bukan `DATABASE_URL`, menghindari masalah URL-encoding pada password.
- `PGSSLMODE=require` mengenkripsi koneksi tetapi tidak memverifikasi sertifikat server. Peningkatan ke `verify-full` butuh bundle CA RDS di image (Q10).
- Batas koneksi default `db.t3.micro` (1 GiB RAM) sekitar 80 sampai 100 [belum diverifikasi]. Pool aplikasi dijaga kecil (maksimum 10 koneksi per proses) dan jumlah worker uvicorn dibatasi.

## 4. Akses admin tanpa bastion

Port-forward lewat instance api memakai SSM Session Manager. Butuh `session-manager-plugin` di laptop dan izin `ssm:StartSession` untuk admin.

```bash
aws ssm start-session \
  --target <API_INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host=<RDS_ENDPOINT>,portNumber=5432,localPortNumber=5432
# Terminal lain:
psql "host=127.0.0.1 port=5432 dbname=lore user=lore_admin sslmode=require"
```

Password diambil dari Secrets Manager oleh admin, bukan disalin ke file. Perintah lengkap ada di [09-runbook.md](./09-runbook.md).

## 5. User aplikasi dengan hak terbatas (hardening)

- Versi 1 memakai master user `lore_admin` (default Q10).
- Hardening: buat role `lore_app` dengan hak `SELECT`, `INSERT`, `UPDATE`, `DELETE` pada schema aplikasi, tanpa hak DDL. Password disimpan manual di SSM SecureString `/lore/prod/api/env/PGPASSWORD_APP`, dan migrasi memakai master user.
- Dampaknya ke `render-env.sh`: untuk `lore_app`, `PGUSER`/`PGPASSWORD` berasal dari parameter, bukan Secrets Manager. Itu dicatat sebagai keputusan di Q10.

## 6. Migrasi schema

- Default: Alembic dengan SQLAlchemy (backend Python).
- Dijalankan sebagai one-shot container `migrate` oleh `deploy.sh` sebelum `docker compose up -d`.
- Migrasi harus backward-compatible (expand dulu, contract kemudian). Rollback image tidak me-rollback schema, jadi versi aplikasi sebelumnya harus tetap bekerja dengan schema baru.
- Snapshot manual sebelum migrasi berisiko: `aws rds create-db-snapshot --db-instance-identifier lore-prod-db --db-snapshot-identifier lore-prod-db-premigrate-<TANGGAL>`.
- Test migrasi di CI memakai service container Postgres (lihat [05-cicd.md](./05-cicd.md)).

## 7. Schema persistensi (R13)

Diimplementasikan di revisi Alembic `7c1d9e4a52b8` (`backend/alembic/versions/7c1d9e4a52b8_r13_persistence.py`, setelah `4ee36ac0a0f8`). Spesifikasi lengkap: `.kiro/specs/r13-persistence-migration/` (`requirements.md`, `design.md`). Migrasinya hanya menambah tabel (expand-only), jadi image api sebelumnya tetap jalan setelah `alembic upgrade head`. Status rilis ada di [10-implementation-roadmap.md](./10-implementation-roadmap.md) R13.

```sql
CREATE TABLE projects (
  id                text PRIMARY KEY,     -- id dari klien; bisa bukan UUID (p_<waktu>_<acak>)
  owner_id          uuid NULL,            -- token perangkat (Q4); API selalu mengisinya
  created_at        bigint NOT NULL,      -- milidetik sejak epoch, sama dengan klien
  updated_at        bigint NOT NULL,
  source            jsonb NOT NULL,       -- { file_name, file_type }
  campaign          jsonb NOT NULL,       -- CampaignBlueprint (opaque)
  materials         jsonb NULL,           -- MaterialBlueprint[] (opaque)
  title             text NOT NULL,        -- denormalisasi untuk daftar
  genre             text NOT NULL,
  source_name       text NOT NULL,
  stories_total     integer NOT NULL,     -- jsonb_array_length(campaign->'story_sequence')
  stories_completed integer NOT NULL DEFAULT 0,  -- selalu dihitung dari project_state
  schema_version    integer NOT NULL DEFAULT 1
);

CREATE TABLE project_stories (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_id   text NOT NULL,
  blueprint  jsonb NOT NULL,              -- StoryBlueprint (opaque)
  PRIMARY KEY (project_id, story_id)
);

CREATE TABLE project_state (
  project_id     text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  campaign_state jsonb NOT NULL,          -- CampaignState (opaque)
  updated_at     bigint NOT NULL          -- untuk deteksi konflik
);

CREATE INDEX idx_projects_owner_updated ON projects (owner_id, updated_at DESC);
```

Perbedaan dari sketsa awal dan alasannya:

- `id` bertipe `text`, bukan `uuid`: `newId()` di klien jatuh ke format `p_<waktu>_<acak>` bila `crypto.randomUUID` tidak ada, dan project lama di IndexedDB memakai id itu.
- Timestamp bertipe `bigint` (milidetik): tipe `Project` di klien memakai `number`, jadi tidak ada konversi `timestamptz` di kedua sisi.
- `owner_id` nullable demi keamanan migrasi, tetapi setiap baris yang ditulis lewat API punya pemilik. Baris tanpa pemilik tidak terlihat oleh siapa pun.
- `campaign_state` juga ditulis saat create dan import, sehingga progres pemain ikut pindah. `stories_completed` selalu diturunkan dari state yang tersimpan, dan `projects.updated_at` hanya bisa maju.
- Tidak ada tabel identitas: token perangkat stateless (lihat Q4).

Alasan pemisahan tabel tetap sama:

- `campaign_state` disimpan setiap perubahan, sedangkan blueprint besar jarang berubah. Memisahkannya mencegah menulis ulang blueprint tiap kali pemain maju.
- Kolom denormalisasi menggantikan store `summaries` untuk daftar di beranda; query daftar tidak menyentuh kolom jsonb.
- `schema_version` memudahkan migrasi bentuk JSON di masa depan.

Ukuran terukur (T0, 20 Nov 2026, Gemini): satu project 25 sampai 42 KB, `campaign_state` di bawah 2 KB. Batas body dan storage cap ada di [06-app-changes.md](./06-app-changes.md) bagian 4.

## 8. Validasi, import, dan penghapusan

- Validasi di server hanya untuk envelope (model Pydantic di `backend/app/models.py`): field level atas dan field yang mengisi kolom NOT NULL (`campaign.title`, `campaign.genre`, `campaign.story_sequence`, `campaign_state.completed_stories`). Nilai yang salah menghasilkan `422`, bukan `500`. Isi `campaign`, `stories`, `campaign_state`, dan `materials` disimpan apa adanya; validasi penuh tetap di klien dengan Zod, termasuk membuang `campaign_state` yang tidak valid tanpa menghapus story.
- Import dari IndexedDB (`POST /api/v1/projects/import`) idempotent per `id`: hanya salinan dengan `updated_at` yang lebih baru yang mengganti; salinan sama atau lebih lama dihitung `skipped`. Item divalidasi satu per satu; item yang tidak valid atau melewati storage cap masuk daftar `rejected` tanpa menggagalkan item lain. Id milik pemilik lain dilewati.
- Penghapusan per pemilik lewat `DELETE /api/v1/projects/{id}` (cascade ke story dan state). Belum ada penghapusan massal per pemilik; token yang hilang membuat datanya yatim (tidak terlihat siapa pun).

## 9. Backup, restore, dan teardown

Backup dan restore:

- Backup otomatis harian dengan retensi 7 hari dan point-in-time recovery.
- Drill restore sebelum dianggap siap: restore snapshot atau PITR ke instance sementara `lore-prod-db-restore` (kelas yang sama, tanpa Multi-AZ), cek data lewat port-forward, lalu hapus instance sementara. Catat biaya drill (beberapa jam instance).
- Backup tambahan hanya jika diputuskan (Q19).

Teardown:

1. Ubah `protect_data = false` lewat PR dan apply.
2. `terraform destroy` dari laptop dengan profil admin (bukan pipeline). Lihat [09-runbook.md](./09-runbook.md).
3. Hapus snapshot final dan snapshot manual yang tidak dibutuhkan. Snapshot berbiaya kecil selama tersimpan.
4. RDS yang di-stop otomatis menyala lagi setelah 7 hari [belum diverifikasi], jadi menghentikan RDS bukan cara menghemat biaya jangka panjang.
