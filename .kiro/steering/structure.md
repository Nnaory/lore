---
inclusion: always
---

# Struktur repo

```
frontend/   Next.js 16 (App Router). src/app (route), src/components, src/lib (logika murni), src/data, tests/,
            sandbox-runtime/ (runtime iframe animasi), scripts/ (pembangun sandbox)
backend/    FastAPI + SQLAlchemy + Alembic. app/ (main.py, db.py, projects, ai/ = pipeline AI, ai/animation/ = fitur animasi), alembic/, tests/
animation-verifier/  Paket Node 22 (Lambda container image) yang memverifikasi kode animasi tulisan AI
infra/      Terraform AWS (ap-southeast-3). bootstrap/ = IAM/OIDC sekali jalan (manual). animation.tf = resource fitur animasi
deploy/     compose + Caddyfile + skrip deploy di instance (web/, api/, common/)
scripts/    ci/ (guardrail biaya, tag, ssm-deploy, rilis verifier, paritas versi), verify/ (cek AWS read-only, ai-smoke.py, animation-smoke.py), sync-animation-contract.py
docs/       DOCS.md, DESIGN.md (visi v2), infra/ (arsitektur yang sudah diimplementasikan, 12-remotion-animation.md untuk R14), KIROWEEN.md
.github/    workflows: ci, infra, release-web, release-api, release-verifier, whoami
.kiro/      steering, specs, hooks, agents, skills, settings (konfigurasi Kiro)
```

## Di dalam `frontend/src`
- `app/` route halaman dan satu route handler, `app/api/health` (liveness). Tidak ada kode server lain di frontend.
- `components/` per area: `ascii`, `ui`, `stage`, `story`, `campaign`, `setup`, `play`, `home`, `animation`, `backdrop` (hanya `PumpkinBackdrop`).
- `lib/` logika murni per domain: `ascii`, `cast`, `stage`, `dialogue`, `prep`, `home`, `schemas`, `contracts`, `game`, `story`, `campaign`, `generation`, `ingest`, `setup`, `state`, `types`, `ascii-field`, `animation`.
- Tipe di `lib/types`, schema Zod padanannya di `lib/contracts/schemas`.
- `lib/animation/` (fitur animasi, mati secara default): `flags.ts` (`NEXT_PUBLIC_ANIMATIONS`), `contract.ts` + `animation-contract.json` (salinan), `sandbox-policy.json` (CSP, atribut sandbox, src; satu sumber), `targets.ts` (pilih target, bangun request, `attachAnimation`, `animationForStep`), `animation-client.ts` + `sse-parser.ts` (klien SSE), `loader.ts` + `lru.ts` + `sha256.ts` (muat dan cek bundle), `protocol.ts`, `sandbox-controller.ts`, `sandbox-player-ref.ts`, `scene-status.ts`, `session.ts`. Pendukung di domain lain: `lib/contracts/animation-{requests,events}.ts`, `lib/contracts/schemas/animation.schema.ts`, `lib/types/animation.ts`, `lib/generation/{animating,animation-progress}.ts`, `lib/stage/{player-like,canvas-timeline,use-on-reveal}.ts`.
- `components/animation/`: `AnimationScene`, `SandboxFrame`, `AnimationProgress`.

## Di luar `frontend/src`
- `frontend/sandbox-runtime/` (`main.tsx`, `controller.ts`, `evaluate.ts`, `player-port.ts`, `shim.ts`, `page.ts`): kode yang berjalan di dalam iframe bersandbox. Satu-satunya tempat selain `StageCanvas.tsx` yang boleh mengimpor nilai `@remotion/player`, dan satu-satunya tempat `eval`/`new Function` boleh ada. `frontend/scripts/{build-sandbox.mjs,sandbox-page.mjs}` membangunnya (dijalankan `predev` dan `prebuild`) ke `frontend/public/sandbox/` (output, gitignored, jangan diedit).
- `animation-verifier/`: `contract/animation-contract.json` (sumber kebenaran kontrak), `src/` (`handler.ts`, `verify.ts`, `contract.ts`, `diagnostics.ts`, `tokens.ts`, `steps/{size,policy,lint,typecheck,bundle,render,fidelity}.ts`, `steps/registry.ts` = `DEFAULT_STEPS`, `policy/`, `host/`), `eslint-plugin-lore/`, `fixtures/{good,bad,warn}` (korpus beserta pendamping `.json`), `tests/`, `Dockerfile`. Tidak memakai alias `@/`. `animation-verifier/node_modules` adalah symlink ke `../frontend/node_modules` di mesin tertentu: jangan `npm install` di situ tanpa memeriksanya.
- `backend/app/ai/animation/`: lihat steering `backend`. Tes di `backend/tests/test_animation_*.py`, fixture bersama di `backend/tests/fixtures/animation/`.
- Tiga salinan kontrak animasi harus byte-identik: `animation-verifier/contract/` (sumber), `backend/app/ai/animation/`, dan `frontend/src/lib/animation/`. Ubah sumbernya, lalu `python3 scripts/sync-animation-contract.py`.

## Penamaan dan pola
- Satu domain per folder di `lib/`; hook React tipis (`use-*.ts`) di atas fungsi murni.
- Tes mengikuti domain: `src/lib/game/hp-manager.ts` ↔ `tests/game/hp-manager.test.ts`. Tes animasi dikelompokkan di `frontend/tests/animation/` (serta `tests/generation/animating*.test.ts` dan `tests/stage/*animation*.test.tsx`) dan di `animation-verifier/tests/`.
- Contoh rujukan pola: logika murni `lib/game/hp-manager.ts`, komponen dengan interaksi `tests/stage/stage-puzzle.test.tsx`, validasi Zod `tests/schemas/*.test.ts`.

## Jangan dimuat sebagai konteks (besar atau berisik)
`node_modules/`, `.next/`, `frontend/package-lock.json`, `animation-verifier/package-lock.json`, `frontend/public/sandbox/`, `animation-verifier/dist/`, `animation-verifier/.corpus-results.json`, `infra/.terraform/`. Dokumen panjang (`docs/infra/*.md`, `docs/DESIGN.md`) dibaca hanya bila relevan.
