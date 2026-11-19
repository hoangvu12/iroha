# 15: Motion pass: Sheet stack

**What to build:** A motion pass on one area only: the stacked side sheets: a sheet entering, the older ones sliding left, closing and the previous sliding back, focusing an earlier sheet, reduced motion and phone width (read the choreograph skill: several elements move together). One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it. Also apply `mobile-native` to this area at phone width (tap highlight, sticky hover, safe areas, full-screen layout).

**Blocked by:** 10, 11

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [x] No dropped frames in a Chrome performance trace of this area's main interactions
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, before building)

Recon: sheets are non-modal UI SDK Dialogs in the top layer, moved with CSS transitions on `translate` from `data-starting-style`/`data-ending-style` (ticket 10); tokens from "UI motion system" (`sheet-in` 300, `sheet-out` 240, `fade` 150, `ease-drawer`, `--motion-sheet-offset`). Crisp dashboard. Frequency: opening a linked record is occasional (pointer); a feed row clicked while a Request is open, and the next key from a Provider's list, are tens a day; ↑/↓ and Escape are keys.

| # | Location | Today | Purpose | Frequency | Suggested motion |
|---|---|---|---|---|---|
| 1 | `SheetStack.tsx` frame | Translate only; no fade, so reduced motion shows nothing at all | Spatial consistency | Occasional | Full Sheet recipe: `translate var(--duration-sheet-in) var(--ease-drawer)` + `opacity var(--duration-fade) var(--ease-out)`, start/end `translate-x(--motion-sheet-offset)` + `opacity-0`, exit `--duration-sheet-out`. Reduce: tokens zero the slide, the 150 ms fade stays. |
| 2 | Same, older sheets | Step aside on 300 ms whatever happened; on a close the one sliding back (300) and the one leaving (240) part ways | Spatial consistency, one gesture (`choreograph`: the new/leaving sheet leads, the others are carried on the same frame, no stagger) | Occasional | One duration per change: `--duration-sheet-in` when the stack grows, `--duration-sheet-out` when it shrinks or an earlier sheet is focused, for every sheet. |
| 3 | `Shell.tsx` `SheetsBesideChat` (`right: CHAT_WIDTH`) | Sheets jump 460 px at frame 0 while the chat slides (ticket 19 note) | Preventing a jarring change | Occasional by pointer; many by C | Move by `translate` (`--sheet-shift`), on the chat's timing (in 300 / out 240, `ease-drawer`), edges together; at once for C and a route change. A sheet entering beside the chat is clipped by as much as it is moved (`clip-path: inset(0 var(--motion-sheet-offset) 0 0)` → `inset(0)`, same curve), so it comes out from under the chat, not over it. |
| 4 | Older sheet pushed wholly off screen | `invisible` at once: it vanishes instead of sliding away (on phones the sheet under the new one disappears before it is covered) | Spatial consistency | Occasional | Keep painting until the move ends: `visibility 0s linear var(--sheet-move)` delay going hidden, 0 coming back. |
| 5 | Sheets restored with the page (reload, shared link, Forward) | Every sheet slides in from the right edge, older ones crossing 2–3 widths | Preventing a jarring change | Rare | Page load: at once. A sheet mounted under the top one fades in its place; only the top travels in. |

Rejected:
- **↑/↓ (and j/k) between Requests, tab changes**: keyboard, 100+ a day. Content swaps in place (already a `replace`; held by a test now).
- **A feed row clicked while a Request is open; another key from a Provider's list**: tens a day. Today the old sheet slides out while the new one slides in over the same spot. Remove: a record of the same kind opened over a sheet takes its place (content swaps, the sheet takes focus, Back swaps it back).
- **Content stagger or fade inside a sheet as it opens**: one entrance per container; the sheet carries its content. The skeleton → content reveal is Skullet's.
- **Dimming or scaling older sheets back (iOS-style)**: they are live, readable sheets in a non-modal stack, not a backdrop; decoration on data.
- **Anything extra on Escape**: a key; the top sheet uses its normal exit, nothing else.

Verdict: the stack was close; the highest leverage is row 3 (the 460 px jump) with row 2 (one gesture per change), and the removal of the double slide for same-kind records.

### Built (branch `agent/ui15`)

- Rows 1–5 and the in-place swap, as proposed. All in `sheets/SheetStack.tsx` (`frameClass`, `data-motion` in/out/instant, `data-top`, `data-away`, `data-beside`, `--sheet-shift`, `--sheet-move`, `--sheet-hide`; `useChatShift`) and `sheets/stack.tsx` (`opened`/`toEntries` keep a sheet's `id` for a record of the same kind; `opened` stamp gives focus). Tokens only, no new values.
- `Shell`'s `SheetsBesideChat` is gone: `SheetStack` reads the chat state itself (`chat={!chatPage}`). Bodies are memoised and the record sheets and the Request sheet use `useChatActions()` (ticket-adjustments "From motion tickets 13 and 19").
- `choreograph`: per change one lead (the sheet opening or leaving, or the chat), the others carried on the same frame and duration; nothing staggered. Found in the browser and fixed: a pointer-opened chat starts its slide a frame after it mounts (`animateIn`), so the sheets started first and opened a strip of page up to 45 px wide between them for ~100 ms; `useChatShift` now waits the same frame (samples below: edges equal on every frame).
- `mobile-native` at 390 px: the top sheet is full width and opening the next pushes it off left (the depth translate), Back is the reverse; frame pads by `env(safe-area-inset-top/right)` (left below `md`), the body by the bottom inset; the body's scroller is `overscroll-contain` (read back as `contain`). Tap highlight, touch-action and press were already global (tickets 13/14: Back, Close and Open page use `buttonClass`/`iconButtonClass` with `press`). Needs a real phone: the notch padding and overscroll feel.
- Test-first (`tdd`): `sheets/motion.test.tsx` (8) and two same-element assertions in `FeedSheets.test.tsx` written red first, then the code. One assertion (focus after a swap) was weak (`act(click)` never focuses the link); it was made to click as a user does.
- Flake (coordinator's extra): `RecordSheets` "Request → Provider → Upstream Key" failed ~1 in 4 busy runs. Two causes, neither the exit: (1) a sheet found by name can still be the Suspense fallback, which has its own Close and is replaced by the body's bar, so the click landed on a detached button (the URL never changed); (2) closing goes Back through the data router, which settles a few microtasks after the sheets change, so a bare `expect(where())` after `waitFor(sheets)` raced it. `loadedSheet()` waits for the body; URL assertions after an action now `waitFor`. 24 parallel stress runs of `src/sheets` after the fix: no assertion failures (two 15 s timeouts in one round of 8× parallel runs on a loaded machine; the test takes 1.7 s alone).

### Browser checks (`iroha-v2-notes/v2-ui/shots/15/`, script `trace15.mjs`, `analyze15.mjs`, samples `feel15.txt`)

Per-frame samples (right edge x / opacity / clip) at 1440×900, headless:
- Open: the new sheet 1980 → 1440 over 300 ms (opacity 1 by ~118 ms); the older ones step aside the same 540 px on the same frames.
- Close and "focus an earlier sheet": the leaving sheet 240 ms, the others back on the same 240 ms, all landing on the same frame.
- In place: ↓, a feed row while a Request is open, key-2 while key-1 is open: no position changes; focus moves into the sheet.
- Chat by pointer: Provider's right edge equals the chat's left edge on every frame (1425/1425 … 1007/1007); chat closing likewise (240 ms). C: both at once.
- Beside the chat, key-1 enters 1520 → 980 with clip `inset(0 100% 0 0)` → `inset(0)`, never crossing the chat's edge; the Request it pushes off screen turns `hidden` only at ~298 ms.
- Reduced motion (emulated): no translate change; the sheet fades 150 ms in and out; computed durations `0s, 0.15s, 0s, 0s`.
- Phone 390 px: Provider 780 → 390 while the Request moves 390 → 0; Back is the reverse.
- Screenshots: three sheets light/dark, sheets beside the chat, a close beside the chat at 10 % speed, phone Request and Provider sheets light/dark.

### Performance trace (headed Chrome over CDP `Tracing`, frame data from `PipelineReporter` `frame_reporter`)

Each run includes a control (a bare 40 px square on the compositor) because other agents share the machine. Long tasks (> 50 ms): none in any step at 1×.

Dropped / presented frames (240 Hz display), 3 repeats where listed:

| Interaction | No throttle | 4× CPU |
|---|---|---|
| Control square (3×) | 0/74, 10/63, 0/73 | 0/75, 1/77, 1/77 |
| Key opens from the Provider (3×) | 3/129, 0/116, 0/113 | 32/189, 6/240, 3/224 |
| Next key in place (3×, no motion) | 10/46, 5/40, 0/50 | 31/70, 21/81, 17/67 |
| Key closes, the others slide back (3×) | 9/231, 4/221, 4/224 | 37/258, 8/278, 13/277 |
| Provider closes (Escape) / opens | 3/176, 4/173 | 13/69, 3/189 |
| Chat opens beside the sheets / closes | 6/80, 2/133 | 40/161, 12/165 |
| Key opens / closes beside the chat (clip) | 1/162, 2/211 | 7/210, 12/167 |
| Feed row while a Request is open (in place) | 4/93 | 12/88 |

Unthrottled: no long task in any step, and the sheets drop about what the control square drops in the same run (0–10). The sheets animate `translate` and `opacity` (compositor) and, beside the chat only, `clip-path`. At 4×, `analyze15.mjs` with `DETAIL=1` places every long task: the click itself (55–115 ms: React re-rendering on the stack and URL change, most of it the Requests feed page, whose `useSearchParams`/`useSheets` see every sheet change), which ends before the first moving frame, and a style/layout frame after an exit ends (`onGone` and the router's Back settling, ~350–500 ms). None lands inside a slide. The 4× chat-open drops (first ~100 ms) are the chat panel mounting (ticket 19 measured 44/361 there). The constant main-thread animation flag is in the idle baseline too (the Requests page), so it isn't the stack. Traces: `trace-sheets-headed-cpu1.json`, `trace-sheets-headed-cpu4.json`.

### `review-animations` (read from `~/.claude/skills/review-animations`)

| Before | After | Why |
| --- | --- | --- |
| Pointer-opened chat: sheets started a frame before the chat (`SheetStack.tsx` shift applied at commit) | `useChatShift` waits for the chat's `animateIn` frame | Coordinated properties must stay in sync; a 45 px strip of page opened between the two edges |
| Sheet pushed off screen got `invisible` at frame 0 | `visibility 0s linear var(--sheet-hide)` (the move's duration going hidden) | It vanished instead of sliding away; on phones the sheet under the new one disappeared before it was covered |
| Close: the sheet sliding back on 300 ms, the leaving one on 240 | `data-motion="out"`: every sheet on `--duration-sheet-out` | One gesture: the edges part ways otherwise |
| Same-kind record over a sheet (feed row, next key): slide out + slide in at one spot | Swap in place (`stack.tsx` `opened`) | Tens a day: delete the animation |
| Reload / Forward: older sheets crossed 2–3 widths from the right edge | `instant` on page load; non-top mounts fade in place | Comes-from-nowhere travel for something that was already there |
| Beside the chat, a sheet entered over the chat panel (top layer) | `clip-path` shrinking with the slide | Physical correctness: it comes from under the chat |
| Every body re-rendered as the chat came and went | `useMemo` body + `useChatActions()` | Work in the click task before the first moving frame |

Answered, not changed:
- The exit's opacity reaches 0 by ~90 ms while the slide runs 240 ms, so a closing sheet reads mostly as a fade and the page shows through the strip it leaves until the sheet behind slides back. This is the shared Sheet recipe (opacity on `--duration-fade` so reduced motion still fades), the same as the chat panel (ticket 19); changing it is a recipe-level decision (e.g. a sheet-exit fade token at `sheet-out` that becomes `fade` under reduce), not this ticket's.
- Durations are asymmetric (300 in / 240 out); `ease-drawer` for every move; no hover motion was added; reduced motion keeps the fade only; when several sheets close at once (X on an older sheet) they all leave toward the right edge and fade, the older ones travelling further while transparent.
- `clip-path` is not a composited property; it runs only for a sheet entering or leaving while the chat is open (measured: 1 dropped frame of 162 at 1×).

Verdict after the fixes: approve.

### Notes for the orchestrator

- `SheetStack` now takes `chat?: boolean` instead of `right`; `SheetsBesideChat` was removed from `Shell.tsx` (ticket 19 had added it). `pages/requests/Drawer.tsx` changed only `useChatPanel` → `useChatActions` (2 lines), in case ticket 18 touches it.
- Feed cost (ticket 18/09's area, not changed): every sheet change re-renders the whole Requests feed (its `useRequestsUrl` reads `useSearchParams` and `useSheets()`), the main cost of the click task at 4× CPU. Reading only the first sheet through a selector and memoising the table would shorten it.
- A same-kind record opened over a sheet now replaces it in place (behaviour, not only motion): the Request sheet for feed row clicks, the key sheet for keys from a Provider. History still pushes; Back swaps back.
