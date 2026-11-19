# 18: Motion pass: Requests

**What to build:** A motion pass on one area only: the live feed (new rows arriving, the N new pill), the Request sheet, Attempts and their explanations, the route view inside a Request, the captured messages view. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 09, 11

**Status:** open

Spec story: 15.

- [ ] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [ ] Built motion matches the proposal; reduced motion holds still
- [ ] No dropped frames in a Chrome performance trace of this area's main interactions
- [ ] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, before building)

Recon: the motion system's tokens and recipes (architecture.md "UI motion system"); sheet motion is ticket 15's, generic DataTable motion (rows added/removed in page tables, bulk bar, dimming) ticket 16's, the canvas's buttons ticket 17's. Personality: a crisp dashboard the Owner watches all day, so the feed gets the least motion of all.

| # | Location | Today | Purpose | Frequency | Suggested motion |
|---|---|---|---|---|---|
| 1 | `pages/requests/Feed.tsx` `useArrivals` | One WAAPI flash typed as `1600, "ease-out"` (the weak built-in curve), skipped under reduce; rows otherwise appear at once | Preventing a jarring change (a row appears on top) | Tens a day, passively | The rows of one poll that land in view enter together, no stagger: `translate: 0 var(--motion-shift-sm)` + `opacity: 0` to place over `--duration-list-in` on `--ease-out` (WAAPI, values read from the tokens), and the background flash `--info-tint` to the row's own colour (implicit end keyframe, so a red-tinted failed row ends red) over `--duration-flash`, `--ease-out`. Rows that arrive while the view is held (scrolled down, pointer over the rows) don't enter at all; each gets its flash once, the first time it comes into view (the pill or a scroll), so the reader can still see which are new. Reduce: shift reads 0, so it's a fade + the colour flash. |
| 2 | `ui/DataTable.tsx` "N new" pill (only live tables use it) | Mounts and unmounts at once | Spatial consistency / state indication | Occasional | Rise like the bulk bar: `translate-y-(--motion-shift)` + `opacity-0` to place, `duration-list-in ease-out`; leave opacity only, `duration-list-out`, in place (the translate snaps back after the fade). The count changes in place. One element kept mounted, `data-shown`, `inert` + `aria-hidden` while hidden. |
| 3 | `pages/requests/Attempts.tsx` `AttemptCard` | `{open && …}` snaps; chevron bare `transition-transform` (150 ms, default curve, no reduce guard) | State indication | Occasional | UI SDK Collapsible: collapse recipe (`h-(--collapsible-panel-height)`, `transition-[height] duration-collapse ease-out`, `data-starting-style:h-0 data-ending-style:h-0`), chevron `transition-[rotate] duration-collapse ease-out`. The first failed Attempt is open on first paint (UI SDK doesn't animate that). Cards are keyed by Request, so ↑/↓ swaps them at once with each Request's own default. |
| 4 | `Attempts.tsx` `Headers` ("Response headers (n)", sheet and Route view panel) | Snaps; chevron bare `transition-transform` | State indication | Occasional | The shared `Disclosure` (same collapse recipe and chevron tokens). |
| 5 | `pages/requests/RouteView.tsx` `Card` and the side panel | Selection: border snaps while the ring fades on `transition-shadow` (150 ms, default curve). Panel mounts at once after Close | Feedback; preventing a jarring change | Tens a day (selection), occasional (panel reopened) | Card: `transition-[border-color,box-shadow] duration-hover ease-[ease]` so border and ring change together. Panel: fades in when it appears again (`starting:opacity-0 transition-opacity duration-fade ease-out`); switching cards swaps its content at once; Close is instant (the canvas regains the width at once). |
| 6 | `ui/Tabs.tsx` indicators (Request sheet tabs, Route view and Captured segmented tabs) | `duration-200 ease-out` typed, `motion-reduce:transition-none` | State indication | Tens a day | Same slide on the tokens: `duration-indicator ease-out`, no slide on first placement (`data-[activation-direction=none]`); the token zeroes it under reduce. Panels swap at once. Plus the Live toggle on `transition-colors duration-hover ease-[ease]`. |

Rejected:
- **↑/↓ (and j/k) between Requests in the sheet** (`Drawer.tsx`): keyboard, 100+ a day. The content swaps at once: no slide, no crossfade, nothing re-animating inside (Attempt cards remount open on first paint, so no collapse plays).
- **Load older rows**: the reader's own scroll drives it and the rows land below the fold. No entrance; the view stays anchored (16's row motion is off in infinite mode).
- **Filters, time range, search, chips, the stats row, polled values** (durations, status codes, in progress → done): high-frequency or data that refreshes on its own. They change in place.
- **The in-progress dot pulse**: kept as it is (state indication, a composited opacity loop, `none` under reduce since 94f4db1).
- **Captured "Show all N characters"**, Raw JSON toggle, Route view tab panels and the Captured side: the reader wants the text now; a height animation over reflowing text hinders. Instant.
- **Route canvas** pan, zoom, `+ − 0`, Tab to a card: 1:1 or keyboard (and ticket 17's).

Verdict: the area is close to right; the highest leverage is #1 (the arrival is the one motion the Owner sees every day, and it must stay quiet), then the pill and the Attempt collapse.
