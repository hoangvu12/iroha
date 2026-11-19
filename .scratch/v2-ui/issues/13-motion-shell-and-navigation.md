# 13: Motion pass: Shell and navigation

**What to build:** A motion pass on one area only: the sidebar (banner, items, collapse), page-to-page transitions, the page header, theme switch, keyboard shortcuts and their hints, login and first-time setup. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it. Also apply `mobile-native` to this area at phone width (tap highlight, sticky hover, safe areas, full-screen layout).

**Blocked by:** 01, 03, 05

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [ ] No dropped frames in a Chrome performance trace of this area's main interactions (see "Performance trace": every animation composites and no long task falls in a press, hover or theme window, but the frame counters on this machine aren't clean enough to tick this)
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, at ccf8ca0)

Recon: React 19, Tailwind 4 (`hover:` already only where hover exists), UI SDK beta.12, no motion library; tokens and recipes from "UI motion system". The shell is the most-used surface of a crisp operator dashboard, so most candidates fail the frequency gate. Input: motion-audit.md section 13 (#7, #8, login, health notice).

| # | Location | Today | Purpose | Frequency | Motion |
|---|---|---|---|---|---|
| 1 | `ui/Button.tsx` `base`, `iconButtonClass` (every Button, IconButton and `buttonClass` link) | No press state | Feedback | Tens/day | Press recipe: `transition-[scale,background-color,color] duration-press ease-out active:scale-(--motion-scale-press)` (0.97, 160 ms, `cubic-bezier(0.23, 1, 0.32, 1)`), not while `data-disabled`/`data-pending`. Reduce: press is 0 ms and scale 1, so it holds still. |
| 2 | `app/theme.tsx` effect that flips `.dark` | Every `transition-colors` element fades 150 ms while the rest snap: the page changes theme in two steps | Preventing a jarring change | Occasional (menu) and the OS switching at dusk | No motion: for the flip, a class on `<html>` sets `transition: none !important` on everything, a forced style read applies the new colours, the class comes off on the next frame. One-step switch, as the system says ("flips colours at once"). |
| 3 | `pages/login/LoginLayout.tsx` form column (Login and Setup) | Pops in after the blank session check | Preventing a jarring change / a little delight (rare) | Rare: first visit, every 30 days, after a sign-out | One entrance for the column (avatar, heading, form together, `@starting-style`): `opacity 0 → 1`, `translate-y (--motion-shift) 8px → 0`, `duration-dialog-in` 200 ms `ease-out`. The art stays still. No stagger (one entrance per container; a stagger would need a new delay token for one screen). Reduce: shift is 0, so a 200 ms fade. |
| 4 | `ui/Input.tsx` `Field` error, `SetupPage` form error line | Error appears instantly | State indication | Occasional | Opacity only, `@starting-style` `opacity-0`, `duration-list-in` 200 ms `ease-out`; no shift (it takes the hint's place) and no shake. Same under reduce (a fade). |
| 5 | `app/Shell.tsx` `HealthNotice` | Appears instantly above Settings | State indication | Rare | List recipe: `opacity 0`, `translate-y (--motion-shift-sm) 4px` → place, `duration-list-in ease-out` via `@starting-style`. Leaves at once (good news, nothing to follow). |
| 6 | `app/Shell.tsx` `navItemClass` | `transition-colors` 150 ms | Removal (`remove-animations`) | 100+/day, moved by P/G/R/C | Make the sidebar highlight instant: the current-page background moves when a key is pressed, and a 150 ms fade-out of the old item is a keyboard-triggered animation. Same rule as menu and table row highlights (instant). |

Mobile (`mobile-native`, 390 px): tap highlight already off and hover already gated. Add `theme-color` per scheme in `index.html` and keep it in step with the chosen theme from `theme.tsx` (the browser bar matches `--bg`); `touch-action: manipulation` on controls (base rule next to the pointer cursor); `select-none` and no long-press callout on the tab bar and the header avatar link; `overscroll-behavior: contain` on the sidebar scroller; safe-area insets on the left and right (landscape notch) for the sidebar, the page column, the tab bar and the login column; `enterKeyHint` on the login and setup fields.

Rejected:
- Page-to-page transitions and a PageHeader entrance: P/G/R are keyboard actions and pages are visited 100+ times a day. **Frequency / keyboard. Never.**
- `Kbd` hints and the phone tab bar's active state (indicator slide or press scale): core navigation, 100+/day. **Frequency.** The active state stays a colour and stroke change.
- Sidebar collapse: there is none, and adding one is not this ticket. If it comes: slide the sidebar with `translate`, never animate `main`'s padding.
- A View Transition crossfade for the theme (apple-design's "ease brightness jumps"): the system rule is that the theme flips at once; a whole-page snapshot fade also costs a full-screen capture. **Function / system rule.**
- The shell fading in after sign-in: the same render runs on every reload. **Frequency.**
- The chat nav item's panel: ticket 19 owns the panel's open/close; the item itself is a nav item (instant, #6).

### Built

- **Press** (#1): `ui/Button.tsx` `press` on `Button`, `IconButton` and `buttonClass` links: `transition-[scale,background-color,color] duration-press ease-out active:not-data-disabled:not-data-pending:scale-(--motion-scale-press)`, in place of `transition-colors`.
- **Theme** (#2): `app/theme.tsx` `applyTheme` puts `theme-switching` on `<html>` (`styles/index.css`: `transition: none !important` on everything) while `.dark` flips, forces a style read, and takes the class off two frames later (a second switch cancels the first one's removal). It also keeps `meta[name=theme-color]` on the chosen theme (`index.html` has one tag per scheme, and its pre-paint script sets them too).
- **Login/Setup column** (#3): `animate-rise-in` (new: `@keyframes rise-in` from `opacity 0` and `translate 0 var(--motion-shift)`, `duration-dialog-in ease-out`, fill `backwards`). It started as `@starting-style`, but the browser check showed Chrome skips that on a fast reload when the column is styled before the first frame (1 of 3 reloads played). A keyframe plays on every load (4 of 4).
- **Errors** (#4): `Field`'s `FieldError` and Setup's form error (now `role="alert"`) fade in, `starting:opacity-0 transition-opacity duration-list-in ease-out`.
- **Health notice** (#5): list recipe via `starting:` (shift-sm + fade, `duration-list-in`).
- **Sidebar** (#6): no transition on nav items (hover and the current page are instant).
- **Mobile**: `theme-color`, `touch-action: manipulation` on controls, `select-none` plus no callout on the tab bar and header avatar (and `select-none` on nav items and the Owner trigger), `overscroll-contain` on the sidebar scroller, safe-area padding on the sidebar (left) and login column (left/right), `enterKeyHint` (login: go; setup: next, next, go). Not checked on a real phone: no device here. The callout, `touch-action` and safe areas need one.
- Docs: `### UI ticket 13: shell motion` in `docs/agents/architecture.md`.

**Test-first** (the `tdd` skill; seams chosen without asking, since this session can't ask: `ThemeProvider`/`useTheme`, the rendered `Button`/`IconButton`/`buttonClass`, the stylesheet through the CSSOM, the Login/Setup pages). Red first, then green: `app/theme.test.tsx` (transitions are off at the moment `.dark` arrives and back on after the next frames; theme-color follows the chosen theme), `ui/Button.test.tsx` (press recipe on all three), `styles/motion.test.ts` (the `rise-in` keyframe and token). Two tests were written after their code, so they were never red: `motion.test.ts` "turns every transition off while the theme flips" (CSS written in the same step) and the two `LoginPage.test.tsx` tests (enterkeyhint; Setup's form error is announced). jsdom can't run CSS motion, so the browser check covers what moves.

**Browser check** (headless Chrome over CDP, seeded testkit, script `check13.mjs`). Screenshots and data are in `iroha-v2-notes/v2-ui/shots/13/`: login, setup and providers in light, dark and phone (390 px), the login entrance mid-way, press held, health notice, setup errors, `results.json`. Measured:
- Login entrance at 0.1× speed: mid-way `opacity 0.78`, `translate 0 1.7px`, then `none`. Reduced motion: `opacity 0.78`, `translate 0px` (a fade).
- Press held: `scale 0.97`; under reduced motion `1`.
- P/G/R: 0 animations in the sidebar.
- Theme via the menu: 0 colour transitions. A bare `.dark` toggle (the old way) started 9.
- Field error: an opacity transition runs.
- Health notice mid-way: `opacity 0.85`, `translate 0 0.6px`.

### Performance trace

CDP `Tracing`, headed Chrome (headless presents about 10 fps, so its frame counters are useless), at 1× and 4× CPU. Each interaction gets its own window on a settled page, recorded twice: with the motion, and with every transition and animation turned off as a control. Scripts: `trace13.mjs`, `segments.mjs`, `mainwork.mjs`. Traces: `trace13-headed-cpu{1,4}.json` (outside the repo).
- **Compositing:** every animation of this area runs on the compositor: `rise-in`, `scale`, `opacity`, `translate`, `background-color`. Only icon-button `color` (paint) and the input focus border/box-shadow (not this ticket) run on the main thread.
- **Main thread:** no task over 50 ms during the press, hover or health windows at either rate; the longest task in the 1× press window was 3.4 ms. At 4×:
  - The theme flip has one 81–118 ms task (restyling the whole page). The control without motion has the same (106–111 ms), so it is the colour change itself, not motion.
  - The login entrance overlaps one 62 ms load task; the keyframe keeps running on the compositor.
  - P/G/R page renders take 69–196 ms. Nothing animates there by design.
- **Frame pacing** (rAF, display at 240 Hz in the final run):
  - Presses with motion: max interval 38 ms at 4× and 50 ms at 1×, against 21 ms and 8 ms in the control.
  - Hover sweep: max 17 ms and 4 ms.
  - An earlier run at about 66 fps (4×) had 0 long frames in 169 during presses.
- **Why the box stays unticked:** the cc frame reporter counted dropped frames even in windows with nothing moving, and more at 1× than at 4×, so this desktop's headed window doesn't give a clean drop count. GPU and main-thread work per frame during presses is under 0.5 ms and 3.4 ms. The one-off 38–50 ms gaps have no long task behind them. A check on a real 60 Hz device would settle it.

### Review (`review-animations` is not installed here; I checked the diff myself against its checklist from `animate` and `emil-design-eng`)

- Fixed: the entrance used `@starting-style`, which Chrome skips before the first frame. It is now a keyframe.
- Fixed: the keyframe used fill `both`, which kept the column's animation effect, and so a compositor layer, after it ended. It is now `backwards`.
- Answered: holding Space on a focused button also scales it (`:active`). Kept: it is feedback for a held press, not a shortcut, and native buttons do the same.
- Answered: under reduced motion `duration-press` is 0, so a Button's hover colour also changes at once. That is stricter than needed, and accepted.
- For ticket 20: `settings/AuditEntries.tsx`'s IconButton passes `className="transition-transform"`, which now collides with the press transition list (`cn` has no tailwind-merge). Audit finding #6 already moves that rotation onto the chevron.
- Clean: no `transition-all`, no `scale(0)`, no `ease-in`, no layout properties, nothing on keyboard shortcuts, exits not slower than entrances, hover gated by Tailwind 4's `hover:`.

Flaky, not this ticket: `ui/toast.test.tsx` "an action on a toast runs and closes it" failed once in a full run under load and passed when run alone and in the next full run.
