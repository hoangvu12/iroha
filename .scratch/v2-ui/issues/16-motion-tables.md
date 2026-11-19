# 16: Motion pass: Tables

**What to build:** A motion pass on one area only: DataTable everywhere: sorting, the bulk-action bar entering and leaving, rows added or removed after an action, page changes, inline Copied/saved morphs, row hover and press, filters (high-frequency surface: keep it fast or remove motion). One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 04, 07, 08

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [x] No dropped frames in a Chrome performance trace of this area's main interactions
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, at `f450b26`)

Recon: CSS transitions only, UI SDK state attributes, tokens from "UI motion system". A crisp dashboard; tables are the most-used surface in the app, so most of it stays still. Input: motion-audit.md section 16 plus findings #4, #12, #14. Today `ui/DataTable.tsx` has a bulk-bar entrance (`starting:`) but no exit, rows appear and vanish at once, and the expand chevron already rotates on `duration-collapse`.

| # | Location | Today | Purpose | Frequency | Suggested motion |
|---|---|---|---|---|---|
| 1 | `DataTable.tsx` bar (`key="bulk"`) | Rises in with `starting:`; vanishes at once when the selection clears, and the toolbar pops back | Spatial consistency, preventing a jarring change | Occasional | Keep the entrance (`translate-y-(--motion-shift)` + `opacity-0` → place, `duration-list-in ease-out`). Exit: `animateOut` on the bar, `data-ending-style:opacity-0 data-ending-style:duration-list-out` (opacity only), showing the last selection's content while it fades, `inert`. The toolbar comes back under it in the same grid cell with `animateIn`: `data-starting-style:opacity-0`, `transition-opacity duration-fade ease-out`, one crossfade. Reopening mid-exit turns back from where it is (`animateOut`'s stop). |
| 2 | `DataTable.tsx` body rows (`tr`, phone `li`) | A row deleted, revoked, or added (Add key, Undo of a delete, a key revoked moving to Revoked keys) appears or vanishes with no bridge | Preventing a jarring change | Occasional (after an action) | Only when `data` changes and still shares rows with the previous `data`, in client modes (`pages`, `none`), not dimmed: a row new to `data` enters with `animateIn` (`data-starting-style:translate-y-(--motion-shift-sm) data-starting-style:opacity-0` → place, `transition-[opacity,translate] duration-list-in ease-out`); a row gone from `data` stays drawn in its place, `inert` and `aria-hidden`, and fades with `animateOut` (`data-ending-style:opacity-0`, `duration-list-out`), then leaves; the rows under it close the gap at once (no height). Never for a page, sort, filter or search change (they don't change `data`), the first load, a whole new data set, server or infinite paging (the Requests feed is 18's). |
| 3 | `Segmented.tsx` indicator | Animates `left` (layout) with typed `duration-200` | Performance (fix) | Tens/day | `left-0 top-0 translate-x-(--segmented-control-indicator-left) translate-y-(--segmented-control-indicator-top) transition-[translate,width] duration-indicator ease-out data-[activation-direction=none]:transition-none`; items `transition-colors duration-hover`. Indicator jumps under reduce (token). |
| 4 | `DataTable.tsx` table `opacity-60` while `dimmed` | Dims at once on every page/sort/filter change, so a fast answer flickers dim-undim | Preventing a jarring change (removal of a flicker) | Tens/day | Dim only when the answer is slow: while dimmed `transition-opacity duration-fade delay-(--duration-fade)`; undim instantly (no transition class when not dimmed). The same 150 ms the skeleton holds back. |
| 5 | `CopyButton.tsx` `swapIn`, `SaveStatus.tsx` | Copied/Couldn't-copy icon scales from a typed `scale-50` in `duration-150`; the save result fades in on typed `duration-200` and vanishes at once when it times out | State indication | Tens/day (copy), occasional (saves) | Icon: `transition-[scale,opacity] duration-fade ease-out starting:scale-(--motion-scale-popup) starting:opacity-0` (a crossfade, tokens). SaveStatus result: in `starting:opacity-0 transition-opacity duration-fade ease-out`; out `animateOut` with `data-ending-style:opacity-0 duration-list-out` when it times out (not when the next "Saving…" replaces it). |
| 6 | Row hover buttons (`Keys.tsx:477`, `List.tsx:58`, `gateway-keys/List.tsx:303`, `AdminTokens.tsx:145`) | `opacity-0 group-hover:opacity-100`: never shown on touch (tablet-width table) | Not motion; a fix (audit #14) | Tens/day | One `row-reveal` utility in `styles/index.css`: hidden until the row is hovered (`@media (hover: hover)`), or the button is focused or shows a result (`data-copy`); always shown where there is no hover. Instant, no transition. |
| 7 | `Switch.tsx` | Bare `transition-transform`/`transition-colors`, `motion-reduce:transition-none` | Feedback (tokens) | Tens/day (row switches in Rules, Pool Members) | Thumb `transition-[translate] duration-press ease-out`; track `transition-colors duration-hover`; drop `motion-reduce:` (the press token zeroes the thumb, the colour may fade). |

Expanded details (Audit Entries): the chevron rotates already (`duration-collapse`); the details row's content fades in with `starting:opacity-0 transition-opacity duration-fade ease-out` (it mounts when opened; nothing on screen at load). Closing is instant (the gap closes at once).

**Leave still** (rejected):
- Sorting, header arrow swap, filters, search results, page changes: **high-frequency and the reader is reading data**; rows swap at once (only the slow-answer dim of #4).
- Row hover and row press: **tens to hundreds a day**; instant `bg-subtle`, no scale on rows (the press utility stays on buttons only). Selection checkboxes: colour only (`transition-colors`, 150 ms), no check-mark draw-in.
- Arrow/Enter keys in tables and ↑/↓ from the Request sheet (`activeRowId` scroll): **keyboard; never animate**, `scrollIntoView` stays instant.
- Rows arriving in the Requests feed, the "N new" pill, load-older: **not this area** (ticket 18); DataTable adds no row motion in infinite mode.
- Polled numbers and Key States in cells: **data that refreshes on its own**; change in place. Skeleton reveal: Skullet's own.
- Stagger on the first load of a table: **seen many times a day, functional**; rejected.

**Verdict:** tables need little motion. The highest leverage is #2 (a row that leaves after a delete or revoke fades where it was, so the Owner sees what went) together with #1 (the bulk bar leaving as one crossfade). #3 is a correctness fix (layout property). Everything else is tokens and small fixes.

### Built (test-first)

Test-first with the `tdd` skill: `web/src/ui/table-motion.test.tsx` (15 tests) was written red against the proposal, then the code. Built as proposed, plus two changes from the browser and the trace (below). Skills followed in order: `find-animation-opportunities` (above), `animate`, `choreograph`, `animation-performance` thinking on the traces, `remove-animations` thinking (the "Leave still" list), and `review-animations` read from its files (below).

- `ui/row-motion.ts` (`useRowMotion`): rows added to or removed from `data` enter (shift-sm and a fade, `animateIn`) or leave (drawn again in place, inert and `aria-hidden`, `animateOut` fade), only in `pages`/`none` paging.
- `ui/presence.ts` (`useLeaving`): keeps what an element last showed while it fades out. Used by the bulk bar (`BarSlot`) and `SaveStatus`.
- `DataTable.tsx`: `BarSlot` (the bar and the toolbar crossfade in one grid cell), the delayed dim, the details fade.
- `Segmented` on translate, `Switch`, `Checkbox`, `CopyButton`, `SaveStatus` on the tokens. `row-reveal` in `styles/index.css`, now used by the four quiet row buttons (Keys copy, Providers/Pools Test, Gateway Keys copy, Admin Tokens copy).
- architecture.md: `### UI ticket 16: table motion`.

**Changed after the browser check:**
- On phones the bar wraps to two lines. While it faded, the returning toolbar sat centred in the taller cell, then moved up. Both now sit at the top of the cell (`self-start`).
- Under 4x CPU the bar's exit ending re-rendered the whole table. The bar and toolbar moved into their own `BarSlot`, so it re-renders only that.

### Browser checks (`iroha-v2-notes/v2-ui/shots/16/`)

`check16.mjs` drives `/providers/dashscope/keys` on a seeded testkit Iroha (8 keys). It samples `getComputedStyle` every frame, and `results-headed-cpu1.json` / `results-headed-cpu4.json` hold the numbers.
- **Bulk bar in:** 8px to 0 with a fade over 200 ms.
- **Bulk bar out:** opacity 1 to 0, gone at about 150 ms. The toolbar fades 0 to 1 in the same frames.
- **Row deleted (Delete… confirmed):** fades in place, then leaves. The bar leaves on the same frame.
- **Row back (Undo on the toast):** 4px to 0 with a fade over 200 ms.
- **Segmented:** `translate` and `width` animate, 200 ms.
- **Reduced motion (emulated):** the bar and rows fade with `0px` shift, and the segmented indicator has no animation (it jumps).
- **Quiet buttons:** opacity 0 at rest with a mouse and 1 on row hover. With touch emulation, `(hover: none)` matches and they show at 1.
- **Screenshots:** `bar`, `keys-light`, `keys-dark`, `keys-phone`, `keys-phone-dark`, `keys-phone-bar`, `keys-phone-bar-leaving`, `keys-touch-1024`.

**Trace** (headed Chrome, 144/240 Hz display). Each interaction ran twice with motion and twice with every transition off as the control, after a warm-up.
- **CPU 1x:** motion matches the control in every pass: bulk bar select and clear ×3, segmented ×4, row hover sweep, delete a row, Undo it back. Median frame 7 ms; at most 1 frame over 17 ms, none over 34 ms, the same as the control.
- **Animated properties:** translate, opacity and scale run on the compositor. Not composited, as the recipes allow: the indicator's `width`, and the colour transitions of checkboxes and segmented items.
- **CPU 4x:** long tasks of 50–300 ms come from React re-rendering the table on select and filter, in both modes. `window.mjs` shows main-thread time with motion no higher than the control, and the composited indicator keeps moving through them (`PRESENTED_PARTIAL`). Passes vary a lot on this machine, because other agents' builds share it: the bulk bar with motion ran 195 and 430 frames across the two passes, against 434 and 611 for the control.
- The 4x trace file was deleted for size. `trace16-headed-cpu1.json` is kept.

### `review-animations` on the diff

| Before | After | Why |
|---|---|---|
| `dimClass` `transition-opacity duration-fade` (Tailwind's default curve) | `+ ease-out` | Weak built-in curve on a deliberate state change |
| Checkbox, Segmented item, Switch track `transition-colors` (default curve) | `duration-hover ease-[ease]` | Hover and colour changes take `ease` (motion system) |
| Segmented indicator `transition-[left,width]` | `translate-x/y-(--segmented-control-indicator-*)`, `transition-[translate,width]` | `left` is layout every frame. `width` stays, as the indicator recipe allows (no transform equivalent without distorting the radius); it is not composited but cost no frames in the trace |
| Bar's exit end re-rendered the table | `BarSlot` | Main-thread work while the next interaction starts |

Answered, not changed:
- **Pure-fade entrances** (toolbar back, save result, details): no transform on purpose.
  - The toolbar is one side of a crossfade in the same slot; a shift would make the two views fight.
  - The save result is text beside the field that made it. The motion system says these morphs crossfade.
  - The details open under a row while the rows below move at once, on a tens-a-day action.
- **A leaving row holds its space for 150 ms before the gap closes** (`choreograph` prefers it out of layout at once). A table row can't be lifted out without overlapping the row that takes its place, and sliding the rows below would move every row on the page. Feel-checked in the browser: it reads as "this one went". Rows never animate height (motion system).
- **The Copied icon swaps in with a fade, without blur.** At 15 px and 150 ms there is nothing to bridge.
- **Space on a row's checkbox brings the bar in with motion.** That is activating a control, not a shortcut or a navigation key. The bar comes once per selection, and the table's own keys (arrows) don't animate.
- No `transition-all`, `scale(0)` or `ease-in`, and no typed durations in the diff. Exits are faster than entrances (150 against 200 ms), and every exit can be interrupted (`animateOut`'s stop; tested).
- Decision: approve.

### Deferred and notes

- Row motion is off for server and infinite paging: Models, Audit Entries, the Requests feed and its numbered pages. In server paging a page that loses a row pulls one in from the next page, and that would read as an arrival. The feed's arrivals are ticket 18's.
- `row-reveal` meant one-class edits in pages owned by 17 and 20: `providers/Keys.tsx`, `providers/List.tsx`, `gateway-keys/List.tsx`, `settings/AdminTokens.tsx`. Merges may touch those lines.
- `CopyButton` and `SaveStatus` are shared beyond tables, so the token changes apply everywhere. Ticket 20's reveal-once secret builds on the same Copied crossfade.
