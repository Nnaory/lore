# Task 00 — Install the design kit (do this first)

**Goal:** the LORE frontend has the Black Cat Gold tokens, fonts, ASCII engine, contracts and i18n, and all kit tests pass.

**Read first:** `AGENTS.md`, `docs/DESIGN-SYSTEM.md` §0–§3, §8–§10.

**Steps**
1. Copy `frontend/src/**`, `frontend/tests/**`, `backend/app/schemas/*.py`, `docs/DESIGN-SYSTEM.md`, `docs/tasks/`, `reference/`, `scripts/` into the repo (keep existing files; `docs/DESIGN.md` gets one line: “Visual identity: see DESIGN-SYSTEM.md”).
2. `src/app/globals.css`: after `@import "tailwindcss";` add `@import "./lore-tokens.css";`.
3. `src/app/layout.tsx`: apply `spaceGrotesk.variable` and `jetbrainsMono.variable` from `src/app/fonts.ts` on `<html>`.
4. Make sure `tsconfig.json` has `"paths": { "@/*": ["./src/*"] }` and Vitest resolves the same alias with automatic JSX.
5. Install `zod` if missing (`npm i zod`).
6. Run `npm test` and `npm run lint`.

**Done when**
- [ ] `npm test` is green, including `ascii-golden` (character-for-character parity with the canvas), `contracts`, and `screens.smoke`.
- [ ] No existing screen changed visually (this task only installs).
