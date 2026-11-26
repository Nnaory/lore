# LORE — Design Spec (Black Cat Gold, v2)

> Source of truth for every screen. If code and this file disagree, this file wins.
> Visual reference: the design canvas (https://claude.ai/artifact/J1BaUMjHHUYUcz5UFghWuY, private) (`reference/canvas/*.dc.html` = exact source of every frame;
> each element's inline `style` is the spec). Numbers below are copied from those files.

---

## 0. How "identical" is guaranteed

| Layer | Guarantee |
|---|---|
| ASCII art (characters, scenes, pumpkins, wordmark) | `frontend/src/lib/ascii/*` is a 1:1 port of the canvas generators. `npm test` compares every output with `tests/fixtures/ascii-golden.json` exported from the canvas — **character-for-character**. |
| Colours, fonts, borders | Only tokens from `src/app/lore-tokens.css`. No other hex values in components (cloth colours live in `CAST`). |
| Layout | Fixed px from this spec. The **Stage** is a fixed 16:9 board scaled as a whole (§4.1); flows (Home, Preparation) are fluid columns with the px widths below. |
| Data | The AI sends recipes only (`src/lib/contracts/schemas/visual.schema.ts` ⇄ `backend/app/ai/contracts/visual.py`). It cannot invent assets. |

---

## 1. Palette

| Token | Hex | Use | Never |
|---|---|---|---|
| `ink` | `#0F0F12` | page/stage background, text on cream, mask behind sprites | — |
| `smoke` | `#2A2A2E` | 1–2px borders, hairlines, disabled fills, skyline | text |
| `gold` | `#C9A227` | speaker names, `LORE`, section numbers, frame corner ticks, "attached" | large fills |
| `ember` | `#FF7A18` | **the only interactive accent**: primary button, selected option, ▼ cursor, HP squares, PAUSED chip | body text on ink |
| `cream` | `#F4EFE6` | primary text on ink, dialogue box, selected rows, outline buttons | — |
| `muted` | `#A8A49C` | secondary text on ink (7.6:1) | on cream |
| `ink-soft` | `#5A5650` | placeholder / secondary text on cream (6.4:1) | on ink |
| `candle` | `#F2D27A` | pumpkin eyes/mouth glow, mouth input background | anywhere else |
| `candle-ink` | `#6B5418` | placeholder on candle (4.9:1) | — |

Cloth colours (characters only): Eldric `#6F86D9`, Mira `#7DA868`, Hazel `#E0393E`, Varr `#3FA79C`, Nyx `#9A6BD6`.
Text on ember or gold is always `ink`.

## 2. Typography

| Role | Font | Size / line | Weight | Extra |
|---|---|---|---|---|
| Screen title (H1) | Space Grotesk | 36/1.15 desktop · 28/1.15 phone | 700 | |
| Story title (HUD) | Space Grotesk | 16 desktop · 14 phone | 700 | |
| Body / descriptions | Space Grotesk | 15/1.5 desktop · 14/1.5 phone | 500 | `muted` |
| Dialogue text | JetBrains Mono | 17/1.6 desktop · 13/1.55 phone | 400 | `ink` on cream |
| Labels, buttons, chips | JetBrains Mono | 11–14 | 700 | uppercase labels use `tracking 0.12–0.24em` |
| Wordmark `LORE` (text) | JetBrains Mono | 13–40 | 700 | `letter-spacing: 0.4–0.5em`, gold in bars, cream on Home |
| ASCII art | JetBrains Mono | cell size = font-size = line-height | 400 | advance 0.6em — required |

## 3. Surfaces & shape rules

- **No** rounded corners, blur, backdrop-filter, glass, drop shadows, gradients (except the 24px grid background `.lore-grid-bg`), emoji.
- Borders: 1px `smoke` hairlines; 2px `smoke` for frames and outline buttons; 2px `cream` for the terminal bar and name tags; 3px `ink` + 2px cream ring (`box-shadow: 0 0 0 2px`) for the dialogue box.
- Cards do not exist. Group with hairlines, numbered section labels (`01 MATERIAL ────`) and inverted (cream) selection.
- Icons: inline stroke SVG, `stroke-width 2`, `stroke-linecap square`, `currentColor`.
- Tap targets ≥ 44px. Focus: 2px ember outline, 2px offset.
- Background jack-o'-lanterns are decorative (`aria-hidden`, `pointer-events:none`) and use the fixed placements in `PumpkinField.tsx`.

## 4. Screens

### 4.1 Stage — desktop (frame 1440 × 900)

Render the Stage foreground at its design size and scale it as one unit (`transform: scale(min(100vw / 1440, 100vh / 900))`, origin top-center) over a full-viewport (`100vw × 100vh`) Stage shell (`lore-grid-bg`, solid `ink` + 24px faint grid; no pumpkin backdrop during gameplay). `StageHud` and `StageScene` span the full viewport width edge-to-edge without any `1200×675` inner cutout box.

| Element | Box (px) | Notes |
|---|---|---|
| Background | whole viewport | `lore-grid-bg` (`bg-ink` `#0F0F12` + 24px faint grid). No `PumpkinBackdrop` during Stage gameplay (`/game` and `/play/[projectId]`) |
| HUD | 0,0 · full width × 64 | `bg-ink`, bottom 1px `smoke` border spanning 100vw, padding 0 24. Left: 44px back button (`bg-ink`, 2px `smoke` border) + `LORE` (mono 14/700, 0.4em, gold). Center: title 16/700 + `Chapter 1 / 2 · … · …` mono 12 muted. Right: `HP` mono 11 muted + 5× 12px ember squares (gap 4) + `5/5` mono 13/700 |
| Stage area | 0,64 · 1440×836 | Full height below HUD, transparent host (no inner box or border) |
| ↳ Scene | 0,64 · full viewport below HUD | `renderScene({biome, seed}, 'stageDesktop')`, cover-scaled and bottom-anchored across 100vw, opacity 0.85 |
| ↳ Canvas pane | 472,14 (in stage) · 736×414 frame | `<CanvasFrame>` (`736×414`, Remotion player + 40px `PlayerBar`). On desktop puzzles, `<PuzzleFeedback>`, `<PuzzleChoices>`, and `<PuzzleActions>` sit directly **below** `<CanvasFrame>` so `StageCanvas` never shrinks |
| ↳ Dialogue box | 344,614 (in stage) · 960×181 | `<DialogueBox>`; name tag at left 96 / top −18, text column `max-w-[700px]`. Holds 3 lines of about 68 characters (§4.3) |
| ↳ Speaker sprite | 64,260 (in stage) · 317×576 | full figure, **12px** cells, flush to bottom (`y: 900`), drawn **after** the box (`z 20`, mask makes it opaque). Secondary character (`other`) sits at `694,47` (`211×384`, 8px cells, `z 5`, 40% opacity) on ambient beats |
| Key hints | y 806 (in stage), centered | `bg-ink` pill, mono 12 muted, keys in cream: `SPACE next line · F fast/animate · L log chat` |

Choice buttons (desktop) sit below the `736×414` canvas frame under the puzzle: at least 44px tall (clamped up to 4 lines via `md:line-clamp-4` so an answer of up to 80 characters is never cut off), min-width 112, max-width 220, gap 10 (`<ChoiceButton>`).

### 4.2 Stage — phone (frame 390 × 844)

| Element | Box (px) | Notes |
|---|---|---|
| Background | whole viewport | `lore-grid-bg` (`bg-ink` + 24px faint grid), no pumpkin backdrop during Stage gameplay |
| HUD | 0,0 · full width × 56 | `bg-ink`, bottom 1px `smoke`, back 44px (`bg-ink`), center title 14/700 + `Ch 1/2 · <place>` mono 11, right 5× 7px squares + `5/5` |
| Scene | 0,56 · full viewport below HUD | `renderScene(…, 'stagePhone')`, cover-scaled and bottom-anchored, opacity 0.85 |
| Canvas frame | 12,68 · 366×246 | player bar 38px; corner ticks 10px |
| Speaker sprite | 6,318 · 211×384 | **8px** cells, drawn **before** the box (box covers its lower body) |
| Dialogue box | 12,582 · 366×250 (puzzle: 12,404 · 366×428) | text 13/1.55; on puzzle beats expands upward to 428px, pinning `<PuzzleFeedback>` cleanly above vertically stacked (`flex-col`), full-width unwrapped `<ChoiceButton>`s (`min-h-11`, no line-clamp truncation) + `<PuzzleActions>` (`44px`) + bottom bar (`46px`) `[> Ask…][fast|animate][log]` |

### 4.3 Dialogue box (both sizes)

Cream box, 3px ink border + 2px cream ring. Name tag: ink, 2px cream border, name in gold (or the cloth colour on Home B), role in muted (desktop only). Text column: desktop padding `26px 56px 0 96px`, max-width 700. ▼ in ember bottom-right. Bottom bar: 2px ink top border; input with `>` prompt; segmented `fast | animate` (selected = ink bg + cream text); `log` = ember bg.

Text capacity (desktop): the text column is 700px wide at mono 17px, so a line holds 68 characters and the box holds **3 lines**. A lesson shows its **body only**; its title is drawn in the canvas heading and beside the `LESSON` name tag (desktop). The AI is told to write chunks of at most **180 characters** (`MAX_CHUNK_CHARS`, equal in `backend/app/ai/chunking.py` and `frontend/src/lib/dialogue/pagination.ts`, kept equal by a test), and `puzzle.narrative_context` is kept to **140 characters** in the prompt (runtime guardrail splits anything over `180 - 33 = 147` chars into preceding narration blocks so adding `" Choose your answer on the board."` fits one box). Feedback and explanation fields carry prompt character limits too (`180` / `140` chars). `paginateText` pages any remaining legacy/demo text; SPACE turns a page before it moves to the next line. The phone box scrolls instead of paging.

Text modes: **animate** reveals one character every 25 ms (skip to full line on SPACE/click); **fast** shows the full line instantly. Expression changes on the line's first character.

### 4.4 Canvas frame

Ink fill, 2px smoke border, gold corner ticks (14px desktop / 10px phone, 2px). Header: `CANVAS / <label>` mono 11 gold+muted; status chip `PAUSED · YOUR MOVE` (ember) / `RESUMED` (gold), ink text. Footer: play button, mono time, 4px smoke track with ember progress and 8px gold diamonds at pause keyframes (`[100]` on `puzzle`/`decision` beats).

Puzzle canvas: when the story gives the puzzle a `visual`, the canvas draws a `Puzzle` heading, that picture (any lesson primitive: vectors, plot, diagram, table, formula; the unknown is marked `?`), the picture's caption in muted (20px), and the **question** in cream **34px**, at most three lines, at the bottom. The picture only poses the problem; it never shows an answer. Without a `visual` (older projects, or an invalid one) the canvas shows the question node and the question in **44px**, and **no answer boxes**. The answers are the `ChoiceButton` chips below the canvas (desktop) or inside the puzzle dialogue box (phone); the question stays in the DOM for screen readers (`sr-only`) because the canvas draws it. Vector and point labels (`visual.points`) in `VectorsView` are placed inside the visual `area` clear of every arrow, axis line, axis tick label, and each other (`placeVectorLabels`).

### 4.5 Preparation — desktop (1440 × 900)

One flat column: x 380, width 680, full height, ink fill, 1px smoke left/right borders, padding `24px 48px 0`. Pumpkins: `PUMPKINS_PREP_DESKTOP`.

1. Top row 44px: `← Back` (mono 13) · `LORE` (mono 13/700, 0.4em, gold).
2. `NEW STORY` mono 12/700 0.24em ember (margin-top 36) → H1 36px → paragraph 15/1.5 muted, max 560.
3. `01 MATERIAL` label row (number gold, label cream, 1px smoke rule) → dropzone 128px tall, 2px **dashed** smoke, padding 0 28: file-up icon (ember) + "Drop your document here" 17/700 + formats mono 12 muted · button "Choose a file" (cream bg, ink text, 44px). With a file: border 2px **solid gold**, file name mono 15/700, "Replace" outline button. Under it: privacy note mono 11 muted.
4. `02 WORLD` → 3-column grid inside a 2px smoke border, cells 84px tall, separated by 2px smoke; selected cell = cream bg, ink text, 8px ember square; others transparent, 8px smoke square.
5. `03 CHAPTERS` → five 44px squares (selected = ember fill) + `› Advanced options` (mono 12 muted).
6. Action bar pinned bottom, 80px, 1px smoke top border: status (mono 12) · `Build the world →` (48px; disabled = smoke bg + muted text; enabled = ember bg + ink text).

### 4.6 Preparation — phone (390 × 844)

Header 56 (back icon + LORE). Padding 20. Same sections stacked; world options become 54px rows; chapters a 5-column grid; dropzone stacks (icon + text, full-width button). Sticky bottom bar: status line + 52px full-width CTA.

### 4.7 Home — three candidate inputs (pick one, delete the others)

| Option | Desktop | Phone |
|---|---|---|
| **A · Pumpkin mouth** | `PumpkinMouthInput size="desktop"` centered at y 140 (MOUTH_PRESETS.desktop: w 130, 9px cells → 724×531); `LORE` mono 30/700 0.5em + tagline at y 44; under it at y 708: file chip (2px gold), formats line, `Play the demo` outline button | `size="phone"` (w 112, 5px cells) at y 190; demo button pinned bottom 32, 52px |
| **B · Greeted by Hazel** | Hazel full figure 10px cells at 230,300 (in front); dialogue box 450,548 · 780×212, name `HAZEL` in `#E0393E`; input row 56px + `Add file` + `Brew it →` (ember). Adding a file switches Hazel to `surprised` and changes the line | Hazel bust 9px at 10,150; box 12,420 · 366 wide; buttons as a 2-column row (50px) |
| **C · Terminal** | `wordmark()` at 22px cells (660×132) at 390,170; command bar 340,384 · 760×64, 2px cream border: `lore ›` (gold) + input + ember block cursor 10×20 + `[ + file ]` + `build ↵` (ember) | wordmark 8.8px cells; bar full width with buttons on a second 50px row |

Common: files PDF · DOCX · PPTX · TXT · MD up to 25 MB, read on device; "Play the demo: The Last Beacon".

## 5. ASCII system

- Grid cell = `fontPx × 0.6` wide, `fontPx` tall. Always JetBrains Mono, `line-height = font-size`, `white-space: pre`.
- Render with `<AsciiArt>` (canvas, per-glyph placement). `<AsciiPre>` is the DOM equivalent for SSR/print.
- Characters are drawn with an `ink` mask layer (`█`) so they are opaque over scenes and the dialogue box.
- Sizes: Stage desktop sprite 12px · Stage phone 8px · Cast busts 9px (31 rows) · Home B 10px · background pumpkins 5–12px.

| Key | Glyph | Colour | Opacity | Meaning |
|---|---|---|---|---|
| c1…c5 | `. : + # @` | cream | .42 .60 .78 .92 1 | skin/hair/metal shading ramp |
| u1…u4 | `. : + #` | cloth | .60 .80 .95 1 | clothes |
| k | `-` | ink | 1 | eyes (ink), brows, mouth |
| g1 g2 g3 g4 g5 | `* # \| \\ ;` | gold | 1 (g5 .85) | trims, buckles, shafts, straw |
| o1 o2 o3 o4 | `* @ · =` | ember | .9 1 .75 .95 | glow, ember eyes, blush, scarf/bands |
| v | (mask only) | ink | — | hood void |

Expressions: `calm`, `smile`, `worried`, `surprised`, `angry`. They only change eyes, brows and mouth.

## 6. Cast & learning functions

| id | Name · role | Function | Cloth | Recipe |
|---|---|---|---|---|
| eldric | Eldric · Keeper of the Beacon | guide: explains, gives hints | blue | robe, pointed hat, long beard, lantern, ember eyes |
| mira | Mira · Apprentice Cartographer | peer: asks (sometimes wrong) | moss | coat + scarf, buns, book, blush |
| hazel | Hazel · Witch of the Ember Marsh | practice: turns theory into experiments on the canvas | red | dress, witch hat, long hair, broom, gold eyes |
| varr | Varr · Warden of the Outer Gate | examiner: tests before you pass | teal | armor, helmet, mustache, spear |
| nyx | Nyx · The Hollow Voice | rival: plants misconceptions | violet | cloak + hood (void face), orb |

Two speakers: the active speaker uses the sprite slot of §4.1/4.2; the other is shown at 40% opacity (desktop: in place of the canvas frame when the beat has no canvas; phone: not shown).

### 6.1 Cast fallback rules

The AI names characters and expressions freely (`character_id`, `name`, an expression word), but the Stage can only draw the five cast ids and five expressions above. Mapping lives in `src/lib/cast/cast-mapping.ts` (pure, never throws; failures return `{ ok: false, … }`), so an unmapped value is a normal path, not an error screen.

1. **Allocation once per campaign** (`resolveCampaignCast`). A character whose id or name maps to a cast id keeps it. If two characters map to the same cast id, the first wins and the second is treated as unmapped.
2. **Unmapped characters** are taken in array order and get the first free cast, starting at index `stableHash(character_id) mod 5` and searching forward (wrapping) through `eldric, mira, hazel, varr, nyx`. The result is deterministic. From the 6th character on, casts are shared.
3. **Unknown expression** → `calm` (`mapExpression`). Known words reuse `emotionFor`, so the emotion logic stays in one place. State overrides (puzzle, ending, answer reaction, failed) go through `emotionToExpression`.
4. **Names are never replaced.** The name tag and the sprite's `aria-label` (`{name}, {expression}`) always use the campaign's `Character.name`, whatever cast is drawn. The narrator, an empty speaker, or an id not in the campaign shows the tag `NARRATION`; a lesson shows `LESSON`.
5. The fallback is silent: no warning, no placeholder art, and the story is never stopped.

## 7. Accessibility

Real `<button>`, `<a>`, `<input>` + `<label>`. ASCII art: `role="img"` + name for characters, `aria-hidden` for decoration. Contrast as in §1. `prefers-reduced-motion` → text mode defaults to `fast`.

## 8. Components added or extended

Reuse these; extend, don't fork. Every file has a header comment with its reason.

### 8.1 `components/ui`

| Component | Props | Notes |
|---|---|---|
| `Icon` | `name`, `size` (24), `className`, `label`, `data-testid` | Inline SVG, 24×24 viewBox, stroke 2, square caps, `currentColor`. Names: `back exit file-up paperclip arrow-up file close check play alert`. No `label` → `aria-hidden`; with `label` → `role="img"`. Replaces every `lucide-react` import. |
| `ErrorLine` | `children`, `className`, `data-testid` | The only error pattern (the palette has no danger colour): ember `ERROR` chip (ink text) + cream message, mono 12 (13 desktop), `role="alert"`. |
| `Button` | `variant` (`primary` \| `outline` \| `disabled`), `href`, `children`, `className`, `data-testid`, plus native button props | `primary` = ember bg, ink text, 52px phone / 48px desktop. `outline` = 2px cream border, cream text. `disabled` = smoke bg, muted text; set by `variant` or `disabled`, and then is natively disabled with `aria-disabled`. All ≥ 44px. With `href` (and not disabled) renders an `<a>` with the same look. An internal `href` (starts with `/`, not `//`) renders `next/link` for client-side navigation; external, protocol-relative and `#` hrefs stay a plain `<a>`. Exposes `data-variant`. |
| `StatusBadge` | `variant` (`done` \| `current` \| `available` \| `locked`), `children`, `className`, `data-testid` | Small mono 11/700 label, 1px border, no radius. `done` = gold fill, ink text; `current` = ink fill, cream text (sits on the inverted cream Current row); `available` = cream border and text; `locked` = smoke border, muted text. Exposes `data-variant`. First user: `CampaignLobby` (`story-badge-<id>`); also planned for `EndingDisplay` (`Success` = done, `Failed` = locked, `Partial Success` = available). |
| `Modal` | `onClose`, `labelledBy`, `children`, `closeOnBackdrop` (true), `className` (panel size), `data-testid` | The one dialog pattern (Pola M). Portals to `document.body`, so it is never inside `ScaledBoard`. Scrim `fixed inset-0 z-50 bg-ink/90` (the animated root backdrop stays faintly visible). Panel: `ink` fill, 2px `smoke` border, 10px gold corner ticks, no radius, no shadow; phone full screen, desktop centred, max height 80dvh. The panel carries `data-testid`, `role="dialog"`, `aria-modal`, `aria-labelledby`; the scrim is `<testid>-scrim`. Initial focus goes to the child marked `data-autofocus` (else the first focusable); Tab wraps inside the panel; `Esc` and a scrim click call `onClose`; focus returns to the opener on unmount. Callers pass `modalOpen` to `resolveShortcut` so SPACE/F/L are ignored while it is open. First user: `ChatLog` (`STORY LOG`, 720 wide desktop, 44px `Close`). |

### 8.1a `components/home` (Home option B)

| Component | Props | Notes |
|---|---|---|
| `HomeHero` | none | Home option B (§4.7): `ScaledBoard inFlow rootClassName="lore-grid-lines"`. Desktop: `wordmark()` 8px at y 64, Hazel `renderCharacter` 10px at 230,300 (z 20), `DialogueBox` 780×212 at 450,548, formats row + demo link at y 790. Phone: wordmark 5px at y 56, Hazel `renderBust` 9px at 10,150 (z 5, behind), box 366 wide at 12,420, formats at y 726, demo link pinned bottom 28 (52px). State from `useHomeComposer`; the greeting (`hazelGreeting`) turns Hazel `surprised` with a new line when a file is attached and restores both on removal. The file is required: Brew is disabled without it and Enter shows `home-file-required`. Hooks: `home-hazel`, `home-dialogue`, `home-composer`, `home-demo-link`. Draws no static pumpkins; the animated backdrop is the root layout's. |
| `SavedStories` | none | `01 YOUR STORIES` list in a 680px column (the page wrapper is 680 + 2×16 padding), rows split by 1px `smoke`, `Continue`/`Replay` (primary, 44px) and `Delete` with a two-step `Delete`/`Keep` confirmation. Transparent, no card. Placed below the hero on `/`. Hooks: `saved-stories`, `saved-story-<id>`, `continue-<id>`, `delete-<id>`, `confirm-delete-<id>`. Empty state renders no error. |

### 8.2 Stage (`components/stage`)

| Component | Props | Notes |
|---|---|---|
| `ScaledBoard` | `children` (nodes or `(layout) => nodes`), `inFlow` (false), `rootClassName`, `fullBleed` | Default host is `position: fixed; inset: 0` with no fill (`rootClassName` selects `.lore-grid-lines` on transparent pages or `.lore-grid-bg` on the full-screen Stage). Optional `fullBleed` renders viewport-wide elements (`StageHud`, `StageScene`) behind the scaled board. `inFlow` makes the root `position: relative`, as wide as its parent and exactly `board height × scale` tall (`overflow: hidden`), measuring `clientWidth` so vertical scrollbars never clip the board horizontally. Inner board is 1440×900 (desktop) or 390×844 (phone), `transform: scale(s)`, origin `top center`, centered. Layout and scale come from `useBoardMetrics` (breakpoint 768: ≤ 767 phone, ≥ 768 desktop; an invalid viewport keeps the last valid scale). Exposes `data-layout`, `data-scale`. Modals render outside it (`position: fixed`). |
| `BoardScaleContext`, `useBoardScale()`, `useBoardPixelRatio()` | | Scale for children. `useBoardPixelRatio()` = `min(devicePixelRatio × scale, 4)`, passed to `AsciiArt.pixelRatio` so art stays sharp when the board is scaled up. |
| `StageSprite` | `layout`, `characterId`, `castId`, `name`, `expression`, `emotion`, `role` (`active` \| `other`), `style` | `renderCharacter(castId, expression)` via `AsciiArt`: 12px cells desktop at 64,260 in stage coords (z 20, in front of the box, flush to bottom), 8px phone at 6,318 (z 5, behind the box); boxes from `STAGE_BOXES`. `role="other"` is drawn on desktop ambient beats at 694,47 (8px cells, 211×384, z 5, 40% opacity, §6). `role="img"`, name `{name}, {expression}`. Hooks: `data-testid` `stage-character` / `stage-character-other`, `data-character-id`, `data-cast-id`, `data-expression`, `data-emotion`. |
| `StageDialogue` | `layout`, `entry`, `entryKey`, `mode`, `onModeChange`, `canAdvance`, `onAdvance`, `onTypingChange`, `onOpenLog`, `speakerRole`, `askName`, `choices`, `actions`, `feedback`, `boxHeight`, `modalOpen` | Wraps `DialogueBox` at the `STAGE_BOXES` dialogue box (`z 10`) and drives it with the typewriter (§4.3). Clicking the text shows a still-typing line in full first, turns pages (`paginateText`) before advancing, and keys pagination state by `entryKey ?? text`. Tag: character name, `NARRATION`, or `LESSON` (body only; lesson title sits in the canvas heading and beside `LESSON` on desktop). The ask input is disabled ("coming soon"). On phone puzzles, `DialogueBox` expands upward (`428px` height), rendering `feedback` in a non-scrolled pinned banner above vertically stacked `choices`; `actions` sit under the text. SPACE, F, L are ignored while `modalOpen` or while an input has focus. |
| `CanvasPane` | `scene`, `sceneKey`, `pacing`, `layout`, `label`, `puzzle`, `className` | A filled `CanvasFrame`: Remotion player (controls off) + `PlayerBar` (with pause `keyframes` `[100]` on `puzzle`/`decision` beats), 736×414 desktop / 366×246 phone. Framed scenes are `lesson`, `visual`, `puzzle`, and `decision`; a beat without a canvas shows only the full-bleed `StageScene` (`ambient`, no frame). `label` becomes snake_case, max 24 characters. On desktop puzzle mode, `PuzzleFeedback`, `PuzzleChoices` (up to 4 `ChoiceButton`s, min-width 112, gap 10), and `PuzzleActions` sit cleanly **below** `<CanvasFrame>` so the Remotion `StageCanvas` keeps its full `736×336` size; on phone the feedback and stacked choices live in `DialogueBox`. Right/wrong and HP come only from `usePuzzleInteraction`, never from the pane. |
| `PuzzleChoices`, `PuzzleActions` (exported from `CanvasPane.tsx`) | `PuzzleChoices`: `puzzle`, `interaction`, `gapClass` (default `gap-2.5`; phone passes `gap-1.5`). `PuzzleActions`: `interaction`, `onComplete`, `className` (default `shrink-0`) | `PuzzleChoices` renders at most four `ChoiceButton`s (letters A-D, `choice-<id>` test ids, `aria-pressed`, disabled once correct) in `puzzle-choices` (horizontal wrapping row on desktop, full-width vertical column on phone). `PuzzleActions` renders `puzzle-submit` (primary when `canSubmit`, else disabled) until the answer is right, then `puzzle-continue`. Desktop mounts both below the canvas frame; phone passes them inside the expanded `DialogueBox`. Right/wrong still comes only from `PuzzleInteraction`. |

### 8.3 Kit extensions (all optional; defaults keep the original Kit look)

| Component | New props | Behaviour |
|---|---|---|
| `AsciiArt` (`components/ascii`) | `pixelRatio` | Canvas backing-store scale. Omitted = `min(devicePixelRatio, 2)`. Layout size is unchanged. `AsciiPre` has no `pixelRatio`. |
| `CanvasFrame` (`components/story`) | `footerless`, `bodyClassName` | `footerless` drops the footer bar even if `footer` is passed. `bodyClassName` adds classes to the body wrapper. |
| `DialogueBox` (`components/story`) | `askDisabled`, `onAdvance`, `testIds`, `nameTag` (true), `wrapText`, `feedback` | `askDisabled` disables the ask input. `onAdvance` makes the text area a click / Enter / Space target (`role="button"`, `tabIndex 0`). `testIds` = `{ root, nameTag, text, advance, ask, fast, animate, log, mode }` (`mode` marks the fast\|animate group). `nameTag={false}` hides the speaker tag. `wrapText(paragraph)` wraps the text paragraph (`narration-block`, `learning-card`, `character-bubble`). **Phone (< md):** text 13/1.55 in a scrolling area (`min-h-0`, `overflow-y-auto`); optional pinned `feedback` sits non-scrolled above vertically stacked `choices` directly above the 46px bottom bar `[> Ask.][fast\|animate][log]`; the 8px gap above the bar is desktop only. On desktop `choices` is hidden (`md:hidden`) because choices sit below the canvas. |
| `DialogueBox` (`components/story`), Home B | `bottomBar`, `padLeft`, `nameColor` | `bottomBar` replaces the whole bottom bar (ask input, fast\|animate, log) with the given node; Home puts its composer there (file chip + 56px row: `>` input, `Add file`/`Replace`, `Brew it →`; on phone the two buttons form a 50px 2-column row under a 52px input). `padLeft` (px, default 96) is the desktop left inset of the text and name tag via `--dlg-pl`; Home B uses 40. `nameColor` colours the speaker name (Hazel = `--color-cloth-hazel`). |
| `ChoiceButton` (`components/story`) | `letter`, `title`, `testId`, `ariaPressed`, `disabled` | `letter` is a decorative prefix (A–D). `title` is the tooltip (default: label). On phone (`< md`), full-width button wraps text cleanly without truncation; on desktop (`≥ md`), clamps up to 4 lines (`md:line-clamp-4`), min-height 44px, min-width 112px, max-width 220px. |

### 8.4 Remotion compositions use tokens

Compositions (`stage/compositions.tsx`, `stage/visual-compositions.tsx`) take colour, gradient and shadow from the Kit tokens, not from literal hex: `GOLD` = `var(--color-gold)`, `GOLD_DIM` = gold mixed 70% with ink, `TEXT` = cream, `TEXT_DIM` = muted, `VOID` = ink, `SURFACE` = smoke. Geometry, data, labels, numbers and the `LessonVisual` content are unchanged.

## 9. Don'ts

Glass/blur/radius/shadows · new colours · emoji · cards · changing generator numbers without updating the golden fixture and this file · hand-drawn character art (always use the generator) · letting the AI send pixels or images.
