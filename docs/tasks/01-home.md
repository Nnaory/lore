# Task 01 — Home, option B "Greeted by Hazel"

**Goal:** replace the current Home (glass input bar) with Hazel's greeting, web + phone, identical to the canvas.

**Read first:** `docs/DESIGN-SYSTEM.md` §4.0, §4.7, §9 · `reference/canvas/HomeB.dc.html`, `HomeBMobile.dc.html`.
**Use:** `components/home/HomeGreeting.tsx` (ready-made), `lib/i18n/ui.ts` (`home.*`, `common.*`).

**Wire up**
- `lang = detectUiLang(localStorage.getItem('lore.lang'), navigator.language)` (no story yet).
- `onBrew({ text, file })` → go to the existing Preparation flow with the file/topic prefilled (keep the current upload + on-device reading logic; only the UI changes).
- `onPlayDemo` → the existing demo route ("The Last Beacon").
- Keep the pumpkin background placements from the component (they are part of the spec).

**Done when**
- [ ] Web at 1440×900 and phone at 390×844 match the reference frames (positions, sizes, colours, copy).
- [ ] Choosing a file shows the chip, switches Hazel to `surprised` and changes her line; ✕ removes it.
- [ ] Submit is blocked with neither file nor text; files > 25 MB are ignored.
- [ ] `id` and `en` both render (switch `lang`), no hard-coded strings.
- [ ] Keyboard: Tab reaches input → Add file → Brew it; Enter submits.
