---
inclusion: manual
---

# Isu dan kode lama (panggil dengan #known-issues)

Sudah diverifikasi (per 19 Nov 2026):
- `requestCampaign()` dan `/api/ai/full-workflow` tidak dipakai UI (rencana migrasi di `docs/infra/06-app-changes.md` juga tidak memindahkannya). Masih ada karena `runFullWorkflow` dan route-nya dipakai banyak test (`gemini.test.ts`, `tests/fixtures/route-fetch.ts`); skema request-nya (`full-workflow-schema.ts`) tetap dipakai client.
- Ada kode yang hanya dipanggil test, bukan app: `validateStory` (`validation/story-validator.ts`, tipe `ValidationError`-nya dipakai di mana-mana), `isStoryFailed`/`clampHp` (`hp-manager.ts`), `getNextStoryEntry` (`campaign-manager.ts`), dan `dummyMaterial2/3`, `dummyPlannerOptions`, `dummyStoryState` di `src/data/dummy-campaign.ts`.
- Pembersihan 17 Nov 2026 menghapus: `PuzzleInteraction.tsx` (testnya pindah ke `tests/stage/stage-puzzle.test.tsx`), state submit di `create-form.ts`, test debug tanpa `expect`, aset bawaan create-next-app di `public/`, CSS layout lama (`.navbar*`, `.sidebar-*`, `.hide-on-*`, `.mobile-full`, `.lore-hairline`, registrasi `--color-*` di `@theme`), dan export tanpa referensi (alias `*FromSchema`, `SceneType`, `LessonVisualKind`, `StoryGenerationContext`, `parseMaterialAnalysisResponse`, dll.).
- Label tombol berubah menjadi "Confirm choice →" hanya untuk pilihan salah yang punya bad branch. Di puzzle demo semua pilihan salah punya bad branch, jadi label "Submit Answer" membocorkan jawaban benar.

**BELUM DICEK** (berasal dari laporan sub-agent; verifikasi dulu sebelum dipakai sebagai fakta):
- `StoryFailure.tsx` meng-hardcode HP 5, bukan memakai `MAX_HP`.
- `EndingDisplay.tsx` menggabungkan paragraf `\n\n` menjadi satu.
- `--color-success` (#6fcf97) dari DESIGN.md tidak ada di `globals.css`. Warnanya di-hardcode di beberapa komponen.
- Jawaban salah yang sama bisa disubmit ulang dan memotong HP lagi. Label "Submitting…" tidak pernah tampil.
- Komentar header `dummy-campaign.ts` sudah basi. Test id masih memakai prefix lama `sidebar-`.
- GenrePicker hanya menawarkan fantasy, modern ("Non-fiction") dan science_fiction, padahal tipe `Genre` punya 8 nilai.
