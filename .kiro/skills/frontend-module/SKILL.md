---
name: frontend-module
description: Add or change a pure logic module or a React component in the LORE frontend (frontend/src) together with its Vitest test. Use when asked to add a feature, helper, hook or component under frontend/, so it follows the repo's pure-logic-plus-thin-hook pattern, result unions, Zod at trust boundaries and test layout.
---

# Add a frontend module with its test

Work from `frontend/`. If `frontend/node_modules` is missing, run `npm ci` first.

## 1. Read a reference before writing
- Pure logic: `src/lib/game/hp-manager.ts` and its test `tests/game/hp-manager.test.ts`.
- Component with interaction: `src/components/stage/StagePuzzle.tsx` and `tests/stage/stage-puzzle.test.tsx`.
- Zod schemas: `src/lib/ai/schemas/*` and `tests/schemas/*.test.ts`.
- Tests that need the DOM use the docblock `@vitest-environment jsdom`; the default environment is `node`. `tests/setup.ts` already loads jest-dom and fake-indexeddb.

## 2. Write the module
1. Put logic in `src/lib/<domain>/` as pure functions. Put React state in a thin hook (`use-*.ts`) on top. Components never compute game rules (HP, correct/incorrect) themselves.
2. Start every file with a header comment that says what it is for and why it exists.
3. Return `{ ok: true, ... } | { ok: false, ... }` at module boundaries. Do not throw across a boundary.
4. Validate every trust boundary with Zod: route requests, responses on the client, and data read from IndexedDB or localStorage. Types live in `src/lib/types`, schemas in `src/lib/ai/schemas`.
5. Style with the semantic CSS variables and `lore-*` glass classes (see the theme steering). Add `data-testid` to interactive elements.
6. This is Next 16: read `node_modules/next/dist/docs/` before using a Next API you are not sure about.

## 3. Write the test
- Mirror the source path: `src/lib/game/x.ts` -> `tests/game/x.test.ts`.
- Cover the `ok:false` paths, not only the happy path.
- Shared fixtures go in `tests/fixtures/`.

## 4. Verify (from `frontend/`)
```
npm run lint
npx tsc --noEmit
npx vitest run <path-to-new-test>
```
Run the whole suite (`npx vitest run --testTimeout=60000`) before calling the work done.

## 5. Commits
Conventional Commits with a scope. Code and tests go in separate commits (`feat(stage): ...`, then `test(stage): ...`). Do not commit or push unless the user asks.
