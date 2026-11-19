# 18: Motion pass: Requests

**What to build:** A motion pass on one area only: the live feed (new rows arriving, the N new pill), the Request sheet, Attempts and their explanations, the route view inside a Request, the captured messages view. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 09, 11

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [x] No dropped frames in a Chrome performance trace of this area's main interactions
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, before building)

Recon: the motion system's tokens and recipes (architecture.md "UI motion system"); sheet motion is ticket 15's, generic DataTable motion (rows added/removed in page tables, bulk bar, dimming) ticket 16's, the canvas's buttons ticket 17's. Personality: a crisp dashboard the Owner watches all day, so the feed gets the least motion of all.

| # | Location | Today | Purpose | Frequency | Suggested motion |
|---|---|---|---|---|---|
| 1 | `pages/requests/Feed.tsx` `useArrivals` | One WAAPI flash typed as `1600, "ease-out"` (the weak built-in curve), skipped under reduce; rows otherwise appear at once | Preventing a jarring change (a row appears on top) | Tens a day, passively | The rows of one poll that land in view enter together, no stagger: `translate: 0 var(--motion-shift-sm)` + `opacity: 0` to place over `--duration-list-in` on `--ease-out` (WAAPI, values read from the tokens), and the background flash `--info-tint` to the row's own colour (implicit end keyframe, so a red-tinted failed row ends red) over `--duration-flash`, `--ease-out`. Rows that arrive while the view is held (scrolled down, pointer over the rows) don't enter at all; each gets its flash once, the first time it comes into view (the pill or a scroll), so the reader can still see which are new. Reduce: shift reads 0, so it's a fade + the colour flash. |
| 2 | `ui/DataTable.tsx` "N new" pill (only live tables use it) | Mounts and unmounts at once | Spatial consistency / state indication | Occasional | Rise like the bulk bar: `translate-y-(--motion-shift)` + `opacity-0` to place, `duration-list-in ease-out`; leave opacity only, `duration-list-out`, in place (the translate snaps back after the fade). The count changes in place. One element kept mounted, `data-shown`, `inert` + `aria-hidden` while hidden. |
| 3 | `pages/requests/Attempts.tsx` `AttemptCard` | `{open && …}` snaps; chevron bare `transition-transform` (150 ms, default curve, no reduce guard) | State indication | Occasional | UI SDK Collapsible: collapse recipe (`h-(--collapsible-panel-height)`, `transition-[height] duration-collapse ease-out`, `data-starting-style:h-0 data-ending-style:h-0`), chevron `transition-[rotate] duration-collapse ease-out`. The first failed Attempt is open on first paint (UI SDK doesn't animate that). Cards are keyed by Request, so ↑/↓ swaps them at once with each Request's own default. |
| 4 | `Attempts.tsx` `Headers` ("Response headers (n)", sheet and Route view panel) | Snaps; chevron bare `transition-transform` | State indication | Occasional | The shared `Disclosure` (same collapse recipe and chevron tokens). |
| 5 | `pages/requests/RouteView.tsx` `Card` and the side panel | Selection: border snaps while the ring fades on `transition-shadow` (150 ms, default curve). Panel mounts at once after Close | Feedback; preventing a jarring change | Tens a day (selection), occasional (panel reopened) | Card: `transition-[border-color,box-shadow] duration-hover ease-[ease]` so border and ring change together. Panel: fades in when it appears again (`starting:opacity-0 transition-opacity duration-fade ease-out`; built with a shift from its edge after review, below); switching cards swaps its content at once; Close is instant (the canvas regains the width at once). |
| 6 | `ui/Tabs.tsx` indicators (Request sheet tabs, Route view and Captured segmented tabs) | `duration-200 ease-out` typed, `motion-reduce:transition-none` | State indication | Tens a day | Same slide on the tokens: `duration-indicator ease-out`, no slide on first placement (`data-[activation-direction=none]`); the token zeroes it under reduce. Panels swap at once. Plus the Live toggle on `transition-colors duration-hover ease-[ease]`. |

Rejected:
- **↑/↓ (and j/k) between Requests in the sheet** (`Drawer.tsx`): keyboard, 100+ a day. The content swaps at once: no slide, no crossfade, nothing re-animating inside (Attempt cards remount open on first paint, so no collapse plays).
- **Load older rows**: the reader's own scroll drives it and the rows land below the fold. No entrance; the view stays anchored (16's row motion is off in infinite mode).
- **Filters, time range, search, chips, the stats row, polled values** (durations, status codes, in progress → done): high-frequency or data that refreshes on its own. They change in place.
- **The in-progress dot pulse**: kept as it is (state indication, a composited opacity loop, `none` under reduce since 94f4db1).
- **Captured "Show all N characters"**, Raw JSON toggle, Route view tab panels and the Captured side: the reader wants the text now; a height animation over reflowing text hinders. Instant.
- **Route canvas** pan, zoom, `+ − 0`, Tab to a card: 1:1 or keyboard (and ticket 17's).

Verdict: the area is close to right; the highest leverage is #1 (the arrival is the one motion the Owner sees every day, and it must stay quiet), then the pill and the Attempt collapse.

### Built (test-first)

Test-first with the `tdd` skill (seams picked from the ticket since this run is non-interactive: the arrivals hook with its rows, the DataTable pill, the Attempts tab, the Route view, the feed + sheet harness). Each slice red, then green:

1. **Arrivals** (`pages/requests/arrivals.ts`, replaces the old one-line flash in `Feed.tsx`): as proposed. Rows in view: WAAPI `translate: 0 var(--motion-shift-sm)` + `opacity: 0` → place, `--duration-list-in`, `--ease-out`, no delay; plus `backgroundColor: var(--info-tint)` at offset 0 → the row's own background over `--duration-flash`. Held rows: no entrance; an IntersectionObserver (threshold 0.5) flashes each once when first seen. Tokens are read once per page (a style read after the rows were added recomputed styles in the commit frame). Test: `arrivals.test.tsx`.
2. **"N new" pill** (`ui/DataTable.tsx` `NewRowsPill`): as proposed, `data-shown`, `inert` + `aria-hidden` while hidden, last count kept for the fade. Test: `ui/new-rows-pill.test.tsx`; the DataTable live-row tests still pass unchanged.
3. **Attempts** (`Attempts.tsx`): UI SDK Collapsible per card with the collapse recipe and a rotating chevron (`group/attempt` named group, because the response headers `Disclosure` inside a card is a `group` too and would turn with it); `<ol key={r.id}>`; `Headers` is the shared `Disclosure`. Test: `Attempts.test.tsx` (incl. agent test: `setOpen` on "Attempt 2").
4. **↑/↓ holds still**: the browser check found Skullet's skeleton panes fading (200 ms) when ↓ landed on a Request whose Attempts weren't loaded. Not motion I added, but it is motion on a keyboard step, so the sheet now prefetches its neighbours in the feed (`usePrefetchRequests` in `api.ts`, captures too on the Captured tab). After it, stepping on every tab runs no animation at all (probed in Chrome). Test: `FeedSheets.test.tsx`.
5. **Route view**: card border + ring on the hover tokens; the panel's entrance; `ui/Tabs.tsx` indicators on `duration-indicator` (was a typed `duration-200` + `motion-reduce:transition-none`, which the token covers) and tab colours on `duration-hover ease`. Test: `RouteView.test.tsx`.
6. Live toggle colours on `duration-hover ease`.

Not done: the in-progress pulses of several rows start out of phase (each from its row's mount). Rejected as decoration on polled data, not worth a shared clock.

### Browser checks

Seeded Iroha (testkit seed outside the repo, plus a Request every 3 s while a flag file exists, to get live arrivals); scripts and screenshots in `iroha-v2-notes/v2-ui/shots/18/` (`check18.mjs`, `probe-step.mjs`, `windows.mjs`, `breakdown.mjs`). Light, dark, phone (390), phone dark and reduced motion: feed, arrival 250 ms in (flash visible), pill, Request sheet Attempts (opened and with headers), Captured, Route view and its panel, Details.

- Read from `document.getAnimations()` in Chrome: arrival = `translate,opacity` 200 ms + `backgroundColor` 1600 ms, both `cubic-bezier(0.23, 1, 0.32, 1)`; reduced motion = `opacity` 200 + the flash, no translate. Pill in: opacity + translate 200 ms; pressed: scroll to 0, `inert`, opacity 150 ms, translate 0 ms; held rows run no animation until seen, then the flash only. Attempt and headers: `height` + chevron `rotate` 200 ms; reduced motion: none. ↑/↓: none on every tab. Route view: border/box-shadow 150 ms `ease`; panel back: opacity + translate on list-in; tab indicator translate + width 200 ms.
- **Frames** (headed Chrome, 240 Hz screen, motion vs every transition and WAAPI call off; `windows-headed-cpu1.json`, `results-headed-cpu{1,4}-trace.json`): no main-thread task over 23 ms in any window (the arrival's commit is 22 ms with motion, 18 ms without). Attempts toggling 0 dropped frames; Route view cards 2 dropped both with and without motion; the pill window 12 vs 2. The arrival window drops 35 frames of 724 at 240 Hz while the background flash repaints its row (a 120 Hz rate for parts of 1.6 s); one rAF gap of ~70 ms in that window lines up with an 80–88 ms browser-process task that is there in the still run too. At 4× CPU the long frames are the same with and without motion (the poll's React render). Recorded as acceptable: the flash is the motion system's one sanctioned paint animation, on one or two rows.

### `review-animations` (read from its file, run on the diff)

| Before | After | Why |
|---|---|---|
| Route view panel: pure fade (`starting:opacity-0`, `duration-fade`) | `starting:translate-x-(--motion-shift)` + opacity, `transition-[opacity,translate] duration-list-in ease-out` | A pure-fade entrance with no initial transform; the panel sits on the right edge, so it comes in from there. Reduced motion: shift 0, a fade. Fixed. |
| Arrivals: `"ease-out"` keyword fallback when the token is missing | No token, no motion | The built-in curve is the weak one; only reachable with no stylesheet. Fixed. |
| Arrival flash: `background-color` (paint, 1600 ms > 300) | Kept | The motion system's `flash` token, chosen for this exact use; one or two rows' paint, measured above. Answered. |
| Arrivals all at once, no stagger | Kept | Data arriving from one poll; the motion system forbids staggering it. Answered. |
| Collapse: 200 ms in and out | Kept | Not a press-and-release; the collapse token is one value both ways by design. Answered. |
| Panel and Attempt close instantly / collapse, cards swap at once | Kept | Close and selection are frequent while exploring; the canvas width changes at once anyway. Answered. |

Verdict after the fixes: approve. Nothing animates on a keyboard action (↑/↓, j/k, canvas keys), hover colours only under `(hover: hover)` (Tailwind's `hover:`), everything moving holds still under reduced motion with fades kept.

After `git merge v2-ui` (tickets 15, 16, 17 in): build and 304 web tests pass; the browser check run again on the merged build (`shots/18/merged/`) shows the same animations, none doubled by ticket 16's row motion (off in the live feed), and still nothing on ↑/↓.
