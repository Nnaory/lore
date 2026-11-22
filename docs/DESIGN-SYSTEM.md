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
| Data | The AI sends recipes only (`src/lib/schemas/visual.ts` ⇄ `backend/app/schemas/visual.py`). It cannot invent assets. |

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

### 4.0 Fixed boards

Every screen is designed as a fixed frame — desktop **1440 × 900**, phone **390 × 844** — and rendered with
`<ScaledBoard>` (components/layout): the frame keeps its exact px layout and is scaled as one unit
(desktop: contain; phone: fit width). Pick the frame with `useIsPhone()` (< 768px). Never re-flow children.

### 4.1 Stage — desktop (frame 1440 × 900)

Render the stage at its design size and scale it as one unit:
`transform: scale(min(100vw / 1440, 100vh / 900))`, origin top-center. Never re-flow its children.

| Element | Box (px) | Notes |
|---|---|---|
| Background | 1440×900 | `.lore-grid-bg` + `PUMPKINS_STAGE_DESKTOP` |
| HUD | 0,0 · 1440×64 | ink, bottom 1px smoke, padding 0 24. Left: 44px back button (2px smoke border) + `LORE` (mono 14/700, 0.4em, gold). Center: title 16/700 + `Chapter 1 / 2 · … · …` mono 12 muted. Right: `HP` mono 11 muted + 5× 12px ember squares (gap 4) + `5/5` mono 13/700 |
| Stage board | 120,92 · 1200×675 | ink, `outline: 2px solid smoke`, overflow hidden |
| ↳ Scene | 0,0 | `renderScene({biome, seed}, 'stageDesktop')`, **12px** cells, opacity 0.85 |
| ↳ Canvas frame | 432,32 · 736×414 | `<CanvasFrame>`; Remotion player fills it; player bar 40px |
| ↳ Dialogue box | 300,470 · 876×181 | `<DialogueBox>`; name tag at left 96 / top −18 |
| ↳ Speaker sprite | 20,99 · 317×576 | full figure, **12px** cells, drawn **after** the box (in front, mask makes it opaque) |
| Key hints | y 800, centered | mono 12 muted, keys in cream: `SPACE next line · F fast/animate · L log chat · / ask` |

Choice buttons (desktop) live in the canvas frame under the puzzle: 44px tall, min-width 112, gap 10 (`<ChoiceButton>`).

### 4.2 Stage — phone (frame 390 × 844)

| Element | Box (px) | Notes |
|---|---|---|
| HUD | 0,0 · 390×56 | back 44px, center title 14/700 + `Ch 1/2 · <place>` mono 11, right 5× 7px squares + `5/5` |
| Scene | 0,56 | `renderScene(…, 'stagePhone')`, **8px** cells, opacity 0.85 |
| Canvas frame | 12,68 · 366×246 | player bar 38px; corner ticks 10px |
| Speaker sprite | 6,318 · 211×384 | **8px** cells, drawn **before** the box (box covers its lower body) |
| Dialogue box | 12,582 · 366×250 | text 13/1.55, choices **inside** the box (3 buttons, flex 1, 44px), bottom bar 46px `[> Ask…][fast|animate][log]` |

### 4.3 Dialogue box (both sizes)

Cream box, 3px ink border + 2px cream ring. Name tag: ink, 2px cream border, name in gold (or the cloth colour on Home B), role in muted (desktop only). Text column: desktop padding `26px 56px 0 96px`, max-width 700. ▼ in ember bottom-right. Bottom bar: 2px ink top border; input with `>` prompt; segmented `fast | animate` (selected = ink bg + cream text); `log` = ember bg.

Text modes: **animate** reveals one character every 25 ms (skip to full line on SPACE/click); **fast** shows the full line instantly. Expression changes on the line's first character.

### 4.4 Canvas frame

Ink fill, 2px smoke border, gold corner ticks (14px desktop / 10px phone, 2px). Header: `CANVAS / <label>` mono 11 gold+muted; status chip `PAUSED · YOUR MOVE` (ember) / `RESUMED` (gold), ink text. Footer: play button, mono time, 4px smoke track with ember progress and 8px gold diamonds at pause keyframes.

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

### 4.7 Home — option B "Greeted by Hazel" (chosen)

Component: `components/home/HomeGreeting.tsx`. Reference: `HomeB.dc.html`, `HomeBMobile.dc.html`.

| Element | Desktop (1440×900) | Phone (390×844) |
|---|---|---|
| Wordmark | `LORE` mono 40/700, 0.5em tracking, centered at y 72 + tagline 16 muted | mono 26 at y 56 + tagline 14 |
| Hazel | full figure, **10px** cells at 230,300, drawn **after** the box (in front) | bust (31 rows), **9px** at 10,150, behind the box |
| Dialogue box | 450,548 · 780 wide, min 212 tall; name tag `HAZEL` in `cloth-hazel` + role | 12,420 · 366 wide |
| Reply row | 56px: `>` + input (15px) · `Add file` (2px ink left border; ink fill when a file is attached) · `Brew it →` ember | input row 52px, then a 2-column 50px row: `Add file` · `Brew it →` |
| File chip | ink chip with file name + ✕, above the reply row | same |
| Footer | formats line (mono 12 muted) left, `Play the demo` outline button right, at y 790 | formats line at y 726, demo button pinned bottom 28 (52px) |

Behaviour: idle line = `home.greeting`, Hazel `smile`. After choosing a file: line = `home.gotFile`, Hazel `surprised`.
Submit needs a file or a typed topic. Files: PDF · DOCX · PPTX · TXT · MD, ≤ 25 MB, read on device.

### 4.8 (not used)

Home options A and C were removed from the Kit; the number is kept so §4.9–4.11 stay stable for `docs/tasks/*`.

### 4.9 Answer layer

A choice beat replaces the generic buttons. The **question is spoken in the DialogueBox** (with `hint` under it);
the canvas only shows visuals. Flow (`useAnswerFlow`): click/tap once = highlight + shape preview, same option again
(or Enter) = lock. No submit button. Wrong lock: HP −1, option REJECTED for good (dashed + struck), speaker shows
`reaction.wrong` and says the option's `why`. Right lock: option ember, chip `SEAL OPEN`, speaker `reaction.correct` + `why`.
Keys: 1–4 highlight, Enter lock. Reference: `AnswerStates.dc.html` (every state).

**4.9.1 Runes (desktop, `mode: 'rune'`)** — `RuneBoard` inside the Stage canvas frame (736×414):
preview panel 18,46 · 452×236 (1px smoke border, `SHAPE PREVIEW` label, `ShapePreview`, caption at bottom);
seal 490,46 · 228×236 (ring r96, dotted ring r78, 8 gold ticks, slot 160×44 centered at 34,90, label under);
rune tiles centered at y 296, 56px tall, gap 12, min-width 160, 22px key cap. Chip: `PAUSED · YOUR MOVE` / `SEAL REJECTS` (cream) / `SEAL OPEN` (gold).

**4.9.2 Menu (phone)** — canvas frame 12,68 · 366×246 shows `PhonePreview`; dialogue box 12,450 · 366×382 holds the
question, `AnswerMenu` rows (48px, gap 6, ▶ + key cap + label + tag) and the hint. Focused row = ink fill, cream text;
correct = ember; rejected = dashed muted border, ink-soft, struck.

**4.9.3 Council of Voices (`mode: 'council'`)** — for misconception questions. `CouncilVoices` replaces the canvas
content: 3 columns (2px smoke separators), each a 6px-cell bust, name in cloth colour + mood, claim (mono 12, centered),
`Trust <name>` button (44px). One click commits. After the pick: right voice gets an ember inset ring + `RIGHT` stamp,
a wrong pick gets a cream ring + `WRONG` stamp; expressions react (right voice smiles, rival turns angry when beaten,
the voice that fooled you smiles). Phone: use 4.9.2 with the claims as row labels.

`ShapePreview` kinds (viewBox 450×200, 40px grid): `vector2d` (arrow from origin, dashed gold projections, component
labels), `scalar` (number line, ember dot), `matrix` (ember boxes inside cream brackets + `r×c`), `text`. The caption
describes the shape only — **it never reveals correctness**.

### 4.10 Building World — Hazel's cauldron

Component: `components/brew/BrewingScreen.tsx` (+ `Cauldron`). Reference: `Brew.dc.html`, `BrewReview.dc.html`, `BrewMobile.dc.html`.
Data: SSE events → `brewReducer` (lib/schemas/brew.ts). **No fake timers or progress.**

| Element | Desktop | Phone |
|---|---|---|
| Header | 64px: `LORE` gold · `BUILDING YOUR WORLD` ember mono 12/700 + meta line · total time mono 13/700 | 56px, same three parts, smaller |
| Hazel | full figure 10px at 110,186 | 6px at 2,248 |
| Cauldron | `cauldron(frame)` 10px at 380,404, 4 frames @250ms | 6px at 150,380 |
| Bubbles | zone 380,160 · 400×260; each new concept / world part / chapter rises `( label )` mono 14/700 (`lore-bub`, 3.2s, steps(16)); concepts candle, world cream, chapters ember | zone 140,110 · 250×270, mono 12 |
| Steps | column at 880,112 · 440×556, 1px smoke left border: 4 rows 52px (14px square: done ember fill, active ember border + blinking core, review = gold border + `waiting for you`, pending smoke), per-step mm:ss | 4 segment bars (6px) + current step line |
| Log | bordered box under the steps, last 11 lines, blinking ember cursor | last 3 lines |
| Dialogue | 110,700 · 1210×160, `HAZEL` tag, line per step (`brew.hazel.*`) | 12,676 → bottom 12 (review: top 462) |

Review step (`awaiting_review`): Hazel `smile`; chips for every concept (kept = ink fill `✓ label`, dropped = dashed,
struck `+ label`), button `Stir again · n concepts →` (ember, disabled at 0) → POST kept list, resume graph.
Done: `Enter <world> →`. Expressions per step: reading calm · review smile · world calm · writing surprised · done smile.

### 4.11 Ending — VN credits

Component: `components/ending/Ending.tsx`. Reference: `Credits.dc.html` (roll), `CreditsEnd.dc.html`, `CreditsMobile.dc.html`.
Data: `StoryResult` (lib/story/result.ts), computed on the client from the locked answers.

- **Roll** starts after the last narration line: backdrop `renderScene(…,'credits')` 9px at 55% opacity; center column
  400,0 · 640×900 (ink, 1px smoke sides) scrolling up with `lore-roll` (34s, linear): presents → title 48 → subtitle gold →
  source file → `THE CAST` (per character: 7px bust, name in cloth colour 26/700, role, verb by `function`, lesson, stat line gold)
  → `CONCEPTS YOU TAKE HOME` → world/stirred by/written by/played by **you** (ember) → `Thanks for playing.`
  `skip ▸▸` button at bottom-right. Allies `smile`, rival `angry`.
- **End card** (after roll or skip): column 340,0 · 760 wide: `THE END` ember stamp, title 44, subtitle gold, lineup of
  5px busts, then a 648px grid — concept list (10px squares: ember = first try, gold = after retry, empty = needs another go,
  meta ember for weak) and stats (HP squares, accuracy, concepts mastered, minutes) — then primary `Retry: <weakest concept> →`
  (ember, 52px), `New story` (2px cream), and text links `↺ replay credits` / `view conversation log`.
- Phone: roll is full-width (6px busts, text centered); end card stacks stamp → title → 4px busts (cropped to cols 4–40) →
  4-up stats row → concept list → pinned buttons.
- No green anywhere; no "Ask …" input on the ending.

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

Real `<button>`, `<a>`, `<input>` + `<label>`; `aria-pressed` on highlight/toggle states. Characters are `role="img"` with name + expression; decorative ASCII is `aria-hidden`. The brewing log is `role="log"` + `aria-live="polite"`. Contrast as in §1. `prefers-reduced-motion` → text mode defaults to `fast` (see §8 for motion).

## 8. Motion

Stepped, ASCII-like motion only (CSS `steps()`), all defined in `lore-tokens.css`: `lore-bub` (bubble rise), `lore-blink`
(cursor / active step), `lore-roll` (credits), `lore-in` (end card). Cauldron 4 fps. Typewriter: 25 ms per character.
`prefers-reduced-motion`: no bubbles (log still updates), cauldron frame 0, credits skip straight to the end card.

## 9. Language (i18n)

UI labels live in `lib/i18n/ui.ts` (`id` + `en`, same keys — tested). Inside a story the UI language = the blueprint's
`language`. Before a story exists (Home, Preparation, Building World until `start`) use `detectUiLang(savedSetting, navigator.language)`.
AI-written text (dialogue, prompts, options, `why`, claims) is never translated by the UI. Never hard-code UI text in a component.

## 10. Don'ts

Glass/blur/radius/shadows · new colours (incl. green) · emoji · cards · hard-coded UI strings · fake progress · changing generator numbers without updating the golden fixture and this file · hand-drawn character art (always use the generator) · letting the AI send pixels or images.

## 11. Repo components added or extended

Components built in this repo on top of the Kit (ui-redesign spec, Kiro tasks 0–9). Reuse these; extend, don't fork. Every file has a header comment with its reason.

> **Two `ScaledBoard`s.** `components/stage/ScaledBoard` (below, used by the existing screens) and the Kit v2 `components/layout/ScaledBoard` (§4.0, used by the Kit v2 screens) coexist until the Kit v2 tasks are finished; the follow-up merges them.

### 11.1 `components/ui`

| Component | Props | Notes |
|---|---|---|
| `Icon` | `name`, `size` (24), `className`, `label`, `data-testid` | Inline SVG, 24×24 viewBox, stroke 2, square caps, `currentColor`. Names: `back exit file-up paperclip arrow-up file close check play alert`. No `label` → `aria-hidden`; with `label` → `role="img"`. Replaces every `lucide-react` import. |
| `ErrorLine` | `children`, `className`, `data-testid` | The only error pattern (the palette has no danger colour): ember `ERROR` chip (ink text) + cream message, mono 12 (13 desktop), `role="alert"`. |
| `Button` | `variant` (`primary` \| `outline` \| `disabled`), `href`, `children`, `className`, `data-testid`, plus native button props | `primary` = ember bg, ink text, 52px phone / 48px desktop. `outline` = 2px cream border, cream text. `disabled` = smoke bg, muted text; set by `variant` or `disabled`, and then is natively disabled with `aria-disabled`. All ≥ 44px. With `href` (and not disabled) renders an `<a>` with the same look. An internal `href` (starts with `/`, not `//`) renders `next/link` for client-side navigation; external, protocol-relative and `#` hrefs stay a plain `<a>`. Exposes `data-variant`. |
| `StatusBadge` | `variant` (`done` \| `current` \| `available` \| `locked`), `children`, `className`, `data-testid` | Small mono 11/700 label, 1px border, no radius. `done` = gold fill, ink text; `current` = ink fill, cream text (sits on the inverted cream Current row); `available` = cream border and text; `locked` = smoke border, muted text. Exposes `data-variant`. First user: `CampaignLobby` (`story-badge-<id>`); also planned for `EndingDisplay` (`Success` = done, `Failed` = locked, `Partial Success` = available). |
| `Modal` | `onClose`, `labelledBy`, `children`, `closeOnBackdrop` (true), `className` (panel size), `data-testid` | The one dialog pattern (Pola M). Portals to `document.body`, so it is never inside `ScaledBoard`. Scrim `fixed inset-0 z-50 bg-ink/90` (the animated root backdrop stays faintly visible). Panel: `ink` fill, 2px `smoke` border, 10px gold corner ticks, no radius, no shadow; phone full screen, desktop centred, max height 80dvh. The panel carries `data-testid`, `role="dialog"`, `aria-modal`, `aria-labelledby`; the scrim is `<testid>-scrim`. Initial focus goes to the child marked `data-autofocus` (else the first focusable); Tab wraps inside the panel; `Esc` and a scrim click call `onClose`; focus returns to the opener on unmount. Callers pass `modalOpen` to `resolveShortcut` so SPACE/F/L are ignored while it is open. First user: `ChatLog` (`STORY LOG`, 720 wide desktop, 44px `Close`). |

### 11.1a `components/home` (Home option B)

| Component | Props | Notes |
|---|---|---|
| `HomeHero` | none | Home option B (§4.7): `ScaledBoard inFlow rootClassName="lore-grid-lines"`. Desktop: `wordmark()` 8px at y 64, Hazel `renderCharacter` 10px at 230,300 (z 20), `DialogueBox` 780×212 at 450,548, formats row + demo link at y 790. Phone: wordmark 5px at y 56, Hazel `renderBust` 9px at 10,150 (z 5, behind), box 366 wide at 12,420, formats at y 726, demo link pinned bottom 28 (52px). State from `useHomeComposer`; the greeting (`hazelGreeting`) turns Hazel `surprised` with a new line when a file is attached and restores both on removal. The file is required: Brew is disabled without it and Enter shows `home-file-required`. Hooks: `home-hazel`, `home-dialogue`, `home-composer`, `home-demo-link`. Draws no static pumpkins; the animated backdrop is the root layout's. |
| `SavedStories` | none | `01 YOUR STORIES` list in a 680px column (the page wrapper is 680 + 2×16 padding), rows split by 1px `smoke`, `Continue`/`Replay` (primary, 44px) and `Delete` with a two-step `Delete`/`Keep` confirmation. Transparent, no card. Placed below the hero on `/`. Hooks: `saved-stories`, `saved-story-<id>`, `continue-<id>`, `delete-<id>`, `confirm-delete-<id>`. Empty state renders no error. |

### 11.2 Stage (`components/stage`)

| Component | Props | Notes |
|---|---|---|
| `ScaledBoard` | `children` (nodes or `(layout) => nodes`), `inFlow` (false), `rootClassName` | Default host is `position: fixed; inset: 0` with an ink fill. `inFlow` makes the root `position: relative`, as wide as its parent and exactly `board height × scale` tall (`overflow: hidden`, no ink fill), so page content (Home's `SavedStories`) can follow it and the root layout's animated backdrop shows through. `rootClassName` adds classes to the root (Home passes `lore-grid-lines`). Inner board is 1440×900 (desktop) or 390×844 (phone), `transform: scale(s)`, origin `top center`, centered. Layout and scale come from `useBoardMetrics` (breakpoint 768: ≤ 767 phone, ≥ 768 desktop; an invalid viewport keeps the last valid scale). Exposes `data-layout`, `data-scale`. Modals render outside it (`position: fixed`). |
| `BoardScaleContext`, `useBoardScale()`, `useBoardPixelRatio()` | | Scale for children. `useBoardPixelRatio()` = `min(devicePixelRatio × scale, 4)`, passed to `AsciiArt.pixelRatio` so art stays sharp when the board is scaled up. |
| `StageSprite` | `layout`, `characterId`, `castId`, `name`, `expression`, `emotion`, `role` (`active` \| `other`), `style` | `renderCharacter(castId, expression)` via `AsciiArt`: 12px cells desktop at 20,99 (z 20, in front of the box), 8px phone at 6,318 (z 5, behind the box); boxes from `STAGE_BOXES`. `role="other"` is drawn at 40% opacity (§6). `role="img"`, name `{name}, {expression}`. Hooks: `data-testid` `stage-character` / `stage-character-other`, `data-character-id`, `data-cast-id`, `data-expression`, `data-emotion`. |
| `StageDialogue` | `layout`, `entry`, `mode`, `onModeChange`, `canAdvance`, `onAdvance`, `onTypingChange`, `onOpenLog`, `speakerRole`, `askName`, `choices`, `actions`, `modalOpen` | Wraps `DialogueBox` at the `STAGE_BOXES` dialogue box (z 10) and drives it with the typewriter (§4.3). Clicking the text shows a still-typing line in full first, then advances. Tag: character name, `NARRATION`, or `LESSON` (the lesson title is the first text line). The ask input is disabled ("coming soon"). `choices` appear inside the box on phone; `actions` sit under the text. SPACE, F, L are ignored while `modalOpen` or while an input has focus. |
| `CanvasPane` | `scene`, `sceneKey`, `pacing`, `layout`, `label`, `puzzle`, `className` | A filled `CanvasFrame`: Remotion player (controls off) + `PlayerBar`, 736×414 desktop / 366×246 phone. Only `lesson`, `visual`, `decision` scenes get a frame; a beat without a canvas is the `ambient` scene on the board (no frame). `label` becomes snake_case, max 24 characters. In puzzle mode on desktop it shows the question, feedback (`ErrorLine`) and a row of `ChoiceButton`s (44px tall, min-width 112, gap 10) plus submit/continue; on phone the choices live in the `DialogueBox`. Right/wrong and HP come only from `usePuzzleInteraction`, never from the pane. |
| `PuzzleChoices`, `PuzzleActions` (exported from `CanvasPane.tsx`) | `PuzzleChoices`: `puzzle`, `interaction`, `gapClass` (default `gap-2.5`; phone passes `gap-1.5`). `PuzzleActions`: `interaction`, `onComplete`, `className` (default `shrink-0`) | `PuzzleChoices` renders at most four `ChoiceButton`s (letters A-D, `choice-<id>` test ids, `aria-pressed`, disabled once correct) in a `min-w-0 flex-1` group (`puzzle-choices`), so long labels shrink and clamp instead of overflowing the canvas. `PuzzleActions` renders `puzzle-submit` (primary when `canSubmit`, else disabled) until the answer is right, then `puzzle-continue`. Desktop mounts both in the canvas pane; phone passes them to `StageDialogue` as `choices` / `actions`. Right/wrong still comes only from `PuzzleInteraction`. |

### 11.3 Kit extensions (all optional; defaults keep the original Kit look)

| Component | New props | Behaviour |
|---|---|---|
| `AsciiArt` (`components/ascii`) | `pixelRatio` | Canvas backing-store scale. Omitted = `min(devicePixelRatio, 2)`. Layout size is unchanged. `AsciiPre` has no `pixelRatio`. |
| `CanvasFrame` (`components/story`) | `status` (legacy), `footerless`, `bodyClassName` | Kit v2 API is `chip` + `title`; `status` (`paused`\|`playing`\|`resumed`) is a legacy shortcut mapped to a chip, ignored when `chip` is given (used by `CanvasPane` until the answer layer lands). `footerless` drops the footer bar even if `footer` is passed. `bodyClassName` adds classes to the body wrapper. |
| `DialogueBox` (`components/story`) | `askDisabled`, `onAdvance`, `testIds`, `nameTag` (true), `wrapText` | `askDisabled` disables the ask input. `onAdvance` makes the text area a click / Enter / Space target (`role="button"`, `tabIndex 0`). `testIds` = `{ root, nameTag, text, advance, ask, fast, animate, log, mode }` (`mode` marks the fast\|animate group). `nameTag={false}` hides the speaker tag. `wrapText(paragraph)` wraps the text paragraph (used for `narration-block`, `learning-card`, `character-bubble` hooks). **Phone (< md):** text 13/1.55 in a scrolling area (`min-h-0`, `overflow-y-auto`) inside the fixed 250px box; `choices` render in a `Choices` group inside the box (1-4 buttons, `flex 1`, gap 6, 44px) directly above the 46px bottom bar `[> Ask.][fast\|animate][log]`; the 8px gap above the bar is desktop only. On desktop the `choices` slot is hidden (`md:hidden`) because choices live in the canvas. |
| `DialogueBox` (`components/story`), Home B | `bottomBar`, `padLeft`, `nameColor` | `bottomBar` replaces the whole bottom bar (ask input, fast\|animate, log) with the given node; Home puts its composer there (file chip + 56px row: `>` input, `Add file`/`Replace`, `Brew it →`; on phone the two buttons form a 50px 2-column row under a 52px input). `padLeft` (px, default 96) is the desktop left inset of the text and name tag via `--dlg-pl`; Home B uses 40. `nameColor` colours the speaker name (Hazel = `--color-cloth-hazel`). |
| `ChoiceButton` (`components/story`) | `letter`, `title`, `testId`, `ariaPressed`, `disabled` | `letter` is a decorative prefix (A–D). `title` is the tooltip (default: label). The label clamps to 2 lines. Still 44px tall, min-width 112 on desktop. |

### 11.4 Remotion compositions use tokens

Compositions (`stage/compositions.tsx`, `stage/visual-compositions.tsx`) take colour, gradient and shadow from the Kit tokens, not from literal hex: `GOLD` = `var(--color-gold)`, `GOLD_DIM` = gold mixed 70% with ink, `TEXT` = cream, `TEXT_DIM` = muted, `VOID` = ink, `SURFACE` = smoke. Geometry, data, labels, numbers and the `LessonVisual` content are unchanged.

