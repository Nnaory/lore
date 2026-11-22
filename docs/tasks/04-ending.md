# Task 04 — Ending: VN credits + end card

**Goal:** replace the stacked "STORY COMPLETE" card with credits that roll, then the end card.

**Read first:** `docs/DESIGN-SYSTEM.md` §4.11, §6, §8 · `reference/canvas/Credits.dc.html`, `CreditsEnd.dc.html`, `CreditsMobile.dc.html`.
**Use:** `components/ending/Ending.tsx`, `lib/story/result.ts` (`StoryResult`, `conceptOutcomes`, `weakest`).

**Build the StoryResult (client)**
- From the `AnswerRecord`s collected in Task 02: `concepts = conceptOutcomes(records)`; `firstTryCorrect`, `questions`, `hp/hpMax`, `minutes` from the game engine.
- `cast`: every story character with `questions` / `firstTry` (choice beats they spoke or voiced), rival `trapsWon` / `trapsBroken`, and `lesson` = the concepts of their questions joined with the story language's “and”.
- `title`, `subtitle`, `world`, `sourceFile`, `pages` from the story.

**Wire up**
- After the last narration line: show `<Ending result lang onRetry onNewStory onViewLog />` (credits roll automatically; `startAtEnd` when reopening a finished story).
- `onRetry(concept)` → replay the beats of that concept; `onNewStory` → Home; `onViewLog` → existing log view.
- Remove the old "STORY COMPLETE" card, the green chip and the "Ask … (coming soon)" input on this screen.

**Done when**
- [ ] Roll lasts ~34 s, `skip ▸▸` jumps to the card, `↺ replay credits` restarts it; reduced motion opens the card directly.
- [ ] Concept squares: ember = first try, gold = after retry, empty = needs another go; primary button targets the weakest concept.
- [ ] Allies smile, the rival is angry; names use cloth colours.
- [ ] Web and phone match the references in both languages; no green anywhere.
