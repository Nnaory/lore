# AGENTS.md — rules for AI coding agents working on LORE's UI

You are implementing a design that must match the design canvas **exactly**. Do not improvise.

## Sources of truth (in this order)
1. `docs/DESIGN-SYSTEM.md` — tokens, rules, every screen's px boxes.
2. `reference/canvas/*.dc.html` — the original canvas frames. Inline `style` attributes are the exact spec; read them when DESIGN-SYSTEM.md is silent.
3. `frontend/src/app/lore-tokens.css` — the only colours, fonts and base styles.
4. `frontend/src/lib/ascii/*` + `tests/fixtures/ascii-golden.json` — the only way to draw characters, scenes, pumpkins and the wordmark.
5. `frontend/src/components/{ascii,story,home,answer,brew,ending,layout}/*` — reuse these components; extend, don't fork.
6. `docs/tasks/*.md` — one brief per screen (00 setup → 01 home → 02 answer layer → 03 building world → 04 ending). Do them in order, one per session/PR.

## Hard rules
- Use Tailwind token classes (`bg-ink`, `text-cream`, `border-smoke`, `text-gold`, `bg-ember`, `font-mono`, `font-display`, `text-muted`, `bg-candle`). **No other hex values** in components.
- No `rounded-*`, `shadow-*` (except the dialogue ring in `.lore-dialog`), `blur`, `backdrop-*`, gradients, emoji, or card containers.
- All ASCII goes through `renderCharacter`, `renderBust`, `renderScene`, `pumpkin`, `jackMouth`, `wordmark` + `<AsciiArt>`. Never paste ASCII art into JSX, never draw characters by hand, never change generator numbers.
- The Stage is a fixed 1440×900 / 390×844 board scaled as a whole. Use the px boxes from DESIGN-SYSTEM.md §4.1–4.2.
- Backend/LLM output must validate against `SceneBlueprintSchema` (TS) / `SceneBlueprint` (Python). Never accept images or coordinates from the model.
- Touch targets ≥ 44px; keep `aria-*` and `<label>`s as in the components.
- Every screen renders inside `<ScaledBoard>` at its design frame (1440×900 desktop, 390×844 phone); choose with `useIsPhone()`.
- UI text only through `t(lang, key)` from `lib/i18n/ui.ts`; add new keys to BOTH `id` and `en`. Inside a story, `lang` = the story's `language`.
- Progress and results come from real data (SSE `BrewEvent`s, `AnswerRecord`s). No fake timers, no invented numbers.
- No green, no "coming soon" inputs on finished screens.

## If something is unclear
Stop and ask the human. Do not guess a value that changes what the screen looks like; quote the spec line or reference file you were reading.

## Workflow for any UI task
1. Find the screen in DESIGN-SYSTEM.md §4 and its reference frame in `reference/canvas/`.
2. Build with existing components + tokens. If something is missing, add it as a component and document it in DESIGN-SYSTEM.md.
3. Run `npm test` (golden parity must stay 100% green) and `npm run lint`.
4. Screenshot at 1440×900 and 390×844 and compare side by side with the canvas frame. Fix any difference in position, size, colour or copy before finishing.
5. In your summary, list every place you deviated from the spec (there should be none).

## Changing the design
Only when the human asks. Update the canvas first, re-export `ascii-golden.json` from it (`scripts/export-ascii-golden.cjs`), then update DESIGN-SYSTEM.md, then the code — in that order.
