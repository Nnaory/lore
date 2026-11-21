---
inclusion: always
---

# Struktur repo

```
frontend/   Next.js 16 (App Router). src/app (route), src/components, src/lib (logika murni), src/data, tests/
backend/    FastAPI + SQLAlchemy + Alembic. app/ (main.py, db.py), alembic/, tests/
infra/      Terraform AWS (ap-southeast-3). bootstrap/ = IAM/OIDC sekali jalan (manual)
deploy/     compose + Caddyfile + skrip deploy di instance (web/, api/, common/)
scripts/    ci/ (guardrail biaya, tag, ssm-deploy) dan verify/ (cek AWS read-only)
docs/       DOCS.md, DESIGN.md (visi v2), infra/ (arsitektur yang sudah diimplementasikan), KIROWEEN.md
.github/    workflows: ci, infra, release-web, release-api, whoami
.kiro/      steering, specs, hooks, agents, skills, settings (konfigurasi Kiro)
```

## Di dalam `frontend/src`
- `app/` route dan route handler (`app/api/ai/*`, `app/api/health`).
- `components/` per area: `stage`, `story`, `campaign`, `setup`, `play`, `home`, `backdrop`.
- `lib/` logika murni per domain: `ai`, `game`, `story`, `campaign`, `generation`, `ingest`, `setup`, `state`, `types`, `validation`, `ascii-field`.
- Tipe di `lib/types`, schema Zod padanannya di `lib/ai/schemas`.

## Penamaan dan pola
- Satu domain per folder di `lib/`; hook React tipis (`use-*.ts`) di atas fungsi murni.
- Tes mengikuti domain: `src/lib/game/hp-manager.ts` ↔ `tests/game/hp-manager.test.ts`.
- Contoh rujukan pola: logika murni `lib/game/hp-manager.ts`, komponen dengan interaksi `tests/stage/stage-puzzle.test.tsx`, validasi Zod `tests/schemas/*.test.ts`.

## Jangan dimuat sebagai konteks (besar atau berisik)
`node_modules/`, `.next/`, `frontend/package-lock.json`, `infra/.terraform/`. Dokumen panjang (`docs/infra/*.md`, `docs/DESIGN.md`) dibaca hanya bila relevan.
