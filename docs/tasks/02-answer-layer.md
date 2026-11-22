# Task 02 — Answer layer (runes, phone menu, council)

**Goal:** replace the A/B/C buttons + "Submit Answer" on the Stage with the new answer layer.

**Read first:** `docs/DESIGN-SYSTEM.md` §4.1–4.4, §4.9 · `reference/canvas/AnswerRune.dc.html`, `AnswerMenu.dc.html`, `AnswerDebate.dc.html`, `AnswerStates.dc.html` (every state).
**Use:** `components/answer/{useAnswerFlow,RuneBoard,AnswerMenu,CouncilVoices,ShapePreview}.tsx`, `DialogueBox` (`hint`, `extra`), `CanvasFrame`, `lib/schemas/visual.ts` (`ChoiceBeat`).

**Backend (orchestrator)**
- Emit choice beats with the v2 contract: `mode`, `concept`, per-option `why`, `preview` (shape only — never hint at correctness), and `voice` on every option when `mode: "council"`. Validate with `backend/app/schemas/visual.py` (`with_structured_output(SceneBlueprint)`).
- Use `mode: "council"` only for misconception questions; the rival character must voice the most tempting wrong option.

**Frontend**
- Desktop: the speaker asks `beat.prompt` in the DialogueBox with the `answer.hint.*` line; the canvas frame shows `<RuneBoard>` (council: `<CouncilVoices>`).
- Phone: `<PhonePreview>` in the canvas frame; `<AnswerMenu>` inside the DialogueBox via `extra`.
- `useAnswerFlow(beat.options, onLock)`: in `onLock`, wrong → HP −1 + speaker expression `beat.reaction.wrong` + text = option `why`; right → `reaction.correct` + `why`, resume the Remotion player; record an `AnswerRecord` for the ending.
- Remove the old Submit button and the question text from the canvas.

**Done when**
- [ ] Click once = preview, same option again / Enter = lock; keys 1–4 work; no submit button anywhere.
- [ ] Wrong option is dashed + struck and can't be picked again; HP square empties; seal shows cracks.
- [ ] Preview captions never reveal right/wrong.
- [ ] Council: one click commits; stamps, rings and expressions match `AnswerDebate.dc.html`.
- [ ] Web 1440×900 and phone 390×844 match the references in both languages.
