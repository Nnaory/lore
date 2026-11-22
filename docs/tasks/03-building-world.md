# Task 03 — Building World: Hazel's cauldron

**Goal:** replace the glass "BUILDING YOUR WORLD" card with the cauldron screen, driven by real pipeline progress.

**Read first:** `docs/DESIGN-SYSTEM.md` §4.10, §8 · `reference/canvas/Brew.dc.html`, `BrewReview.dc.html`, `BrewMobile.dc.html`.
**Use:** `components/brew/{BrewingScreen,Cauldron}.tsx`, `lib/schemas/brew.ts` (`BrewEventSchema`, `brewReducer`, `toggleConcept`, `keptConcepts`), `backend/app/schemas/brew.py`.

**Backend (FastAPI + LangGraph)**
- SSE endpoint streaming `BrewEvent`s in this order: `start` → `concept`* (as each concept is extracted) → `awaiting_review` (LangGraph `interrupt`) → *(resume via POST `ReviewDecision{kept}`)* → `step: world` → `world`* (places, then characters) → `step: writing` → `chapter`* → `done`.
- On failure send `error` (the screen shows it in the log; add a retry button using the existing error pattern).

**Frontend**
- `EventSource` → `BrewEventSchema.parse` → `brewReducer(state, event, Date.now())`. Render `<BrewingScreen state lang worldName …>`.
- `lang` = `start.language` once received (before that, `detectUiLang`).
- Review: `onToggleConcept` → `toggleConcept`; `onProceed` → POST kept concepts (`keptConcepts(state)`).
- `onEnter` → open the story Stage with `storyId`.

**Done when**
- [ ] Bubbles appear exactly when events arrive (no fake timers); per-step timers come from `startedAt/endedAt`.
- [ ] The pipeline really pauses on review and resumes with the kept list.
- [ ] Reduced motion: no bubbles, static cauldron, log still updates.
- [ ] Web and phone match the references in both languages.
