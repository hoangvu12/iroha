# 19: Motion pass: Chat panel

**What to build:** A motion pass on one area only: the right-side chat panel: open and close, expand to full page, streaming replies, the collapsed details block, the model picker and settings, earlier chats dropdown, the snippet dialog, a failed reply. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 03, 05

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [x] No dropped frames in a Chrome performance trace of this area's main interactions (headed, no throttle; see Comments for 4× CPU)
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, at `ccf8ca0`)

Recon: CSS transitions only, tokens from "UI motion system"; UI SDK state attributes; `animateIn`/`animateOut` (`@ui-sdk/core`) for plain elements. Crisp dashboard: few suggestions, short. The earlier-chats dropdown (`MenuContent`) and the snippet dialog (`ui/Dialog`) are shared popups whose motion is ticket 14's: nothing chat-specific to add (both already grow from the trigger / centre).

| # | Location | Today | Purpose | Frequency | Suggested motion |
|---|---|---|---|---|---|
| 1 | `app/Shell.tsx:52-61` chat `<aside>` | Mounts and unmounts at once, whatever opened it | Spatial consistency (the panel lives off the right edge) | Occasional by pointer (sidebar Chat, Close, Test buttons); many a day by C | Pointer: sheet recipe. Enter `translate-x-(--motion-sheet-offset)` + `opacity-0` → place, `translate var(--duration-sheet-in) var(--ease-drawer)`, `opacity var(--duration-fade) var(--ease-out)`; leave the same edge, `--duration-sheet-out` (240 ms) + fade, unmount when `animateOut` reports done. Reopen mid-exit turns back from where it is (CSS transition retargets, no restart). **C key, Full page and Back to the side panel: instant** (`data-instant:transition-none`, no starting style; route change, keyboard). Reduce: tokens zero the slide, the 150 ms fade stays. |
| 2 | `chat/Reply.tsx:118-169` Details; `:79-88` Thinking | `{open && …}` snaps; chevron `transition-transform` (150 ms, default curve, no reduce guard) | State indication / preventing a jarring change | Occasional | UI SDK Collapsible, collapse recipe: `h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-collapse ease-out data-starting-style:h-0 data-ending-style:h-0`; chevron `transition-[rotate] duration-collapse ease-out`. Details keeps its fetched data while it closes (no skeleton flash in the exit). Thinking: open while it streams (first paint open, so no animation), collapses with the same recipe when the answer starts. |
| 3 | `ui/Disclosure.tsx:11,14` (System prompt block) | Typed `duration-200`, chevron bare `transition-transform` | Same as 2 (audit #13, #5) | Occasional | Panel `duration-collapse`; chevron `transition-[rotate] duration-collapse ease-out` (the token zeroes under reduce, so `motion-reduce:transition-none` can go). |
| 4 | `chat/Picker.tsx:71-75` | `duration-150` in and out, exit without scale, `motion-reduce:transition-none` | Spatial consistency, asymmetric exit (audit #3) | Occasional (tens a day at most, pointer) | Popup recipe: `origin-(--transform-origin) transition-[opacity,scale] duration-popup-in ease-out`, start and end `scale-(--motion-scale-popup) opacity-0`, `data-ending-style:duration-popup-out` (180 / 120 ms). Under reduce it fades (scale token 1). |
| 5 | `chat/Reply.tsx:97-116` Failure | The error block appears at once | Preventing a jarring change (a failure is the one reply state worth noticing) | Occasional | When it fails while on screen only (not for failures already in history when the panel or chat opens): `animateIn`, `translate-y-(--motion-shift-sm)` + `opacity-0` → place, `transition-[opacity,translate] duration-list-in ease-out`. No shake. Reduce: fade. |
| 6 | `chat/ChatPanel.tsx:237-249,221-231,288-293` Send/Stop, Tools, starter chips | No press feedback (raw `SdkButton`/`<button>`, so ticket 13's `Button` press won't reach them) | Feedback | Tens a day by pointer (Enter sends most messages: no motion there) | Press recipe: `transition-[scale,background-color,color] duration-press ease-out active:scale-(--motion-scale-press)`, not while disabled. |

Rejected:
- Streamed tokens, the caret, new messages and the user bubble arriving: **data that refreshes on its own / Send is many a day (and mostly Enter).** Text changes in place; auto-scroll stays instant (`stickToEnd`).
- Expand to Full page (and back): **a route change.** No morph; the panel goes and the page shows at once.
- Picker view swaps (settings ↔ model list ↔ keys) and its size change: **keyboard-driven (Enter, Escape) and frequent.** Swap at once.
- Send ↔ Stop icon swap, New chat, opening an earlier chat, the "Sending as" bar appearing: **frequent content swaps; a height animation on the bar would shove the whole log.** At once.
- Snippet dialog language switch: **tab-like panel swap.** Code swaps at once (the Segmented indicator is ticket 16's).

Verdict: the panel is almost right already; it needs one entrance and exit (row 1, highest leverage, with the C key kept instant), the token swap on the picker and disclosures, and one small arrival for failures.

### Built (branch `agent/ui19`)

- Rows 1–6 as proposed. The slot moved to `app/ChatSheet.tsx` (`animateIn`/`animateOut`, inert while it leaves, retargets when reopened mid-exit, `data-instant` for C / Full page / Back to the side panel / a route change). `open`, `close` and `toggle` take `{ instant }`; `shortcuts.ts` passes it for C. Details and Thinking are Collapsibles; Disclosure and Picker are on the tokens; failures that arrive on screen enter with `animateIn`; Send/Stop, Tools and the starter chips get the press recipe. Notes in `docs/agents/architecture.md` "UI ticket 19".
- Added after the trace and review (below): Details fetches its Request when its trigger is pointed at or focused (before, the data landed mid-animation: a 60–74 ms task at 4× CPU inside the 200 ms height transition, then a jump from the skeleton's height); the stream's own Thinking fold is instant (`transition-none` until the Owner toggles it); Send/Stop animate scale only; and `useChatActions()` / `useChatRequest()` (three contexts) so opening and closing the sheet no longer re-renders the chat, the shell frame or the Test-button pages (Providers and Pools tables, Keys table, Provider/Pool/Gateway Key pages, switched with one line each); the Shell's sheet stack offset moved into `SheetsBesideChat` for the same reason.
- `choreograph` (panel + what sits beside it): the sheet is the only lead; its content is carried (no inner entrance, no stagger). Static on purpose: the Route view's right edge (a full-page resize; animating it would lay out the page every frame). **Not done, ticket 15's (sheet stack)**: the record sheets (`SheetStack right=`) and the Request drawer (`right: CHAT_WIDTH`) jump 460 px at frame 0 while the chat slides. They should move with it: `translate-x` by `-CHAT_WIDTH` with the chat's own transition (`translate var(--duration-sheet-in|out) var(--ease-drawer)`), instant when `useChatPanel().instant` is true, never by animating `right`.
- Test-first (`tdd` skill): `app/ChatSheet.test.tsx` (9) and `pages/chat/Reply.test.tsx` (5) written red first, then the code.

### Browser checks

Screenshots and traces in `iroha-v2-notes/v2-ui/shots/19/` (outside the repo; scripts `trace19.mjs`, `smooth19.mjs`, `frames19.mjs`, `probe19.mjs` there): mid-slide at 10 % speed, panel with Details open and a live failure in light and dark, the picker, `/chat` on a 390 px phone in light and dark.
- Sampled each frame: a pointer open slides 100 % → 0 over ~320 ms with opacity done by ~120 ms; C opens with `translate: none` and opacity 1 on the first frame and closes at once.
- Reduced motion (emulated): translate stays 0 the whole way; the sheet only fades (150 ms) in and out; sheet transition durations read `0s, 0.15s`.
- `probe19.mjs`: on mount, the first style is already final (child layout effects force a style recalc before the slot's), so a backwards transition starts; UI SDK's `animateIn` finishes it at once, then the real entrance runs. Nothing visible, same in UI SDK's own popovers; nothing to fix.

### Performance trace (headed Chrome over CDP `Tracing`, 240 Hz display, frame data from cc `FrameSequenceTrackerV3`)

Headless Chrome never presents frames, so its frame reporter marks nearly all of them dropped; these numbers come from a real window. Each run includes a control (a bare 40 px square on the compositor), because other agents share the machine.

| Interaction | No throttle: dropped / expected | 4× CPU |
|---|---|---|
| Control square (3×) | 0 / 289 | 74 / 293 |
| Pointer close (4×) | 0 / 454 | 77 / 575 |
| Pointer open (4×) | 0 / 347 | 44 / 361 |
| C close, C open | no animation | no animation |
| Details open (height, main thread) | 1 / 119 | 93 / 174 |
| Picker open / close | 0 / 115, 0 / 29 | 2 / 118, 0 / 30 |
| Earlier chats open / close | 0 / 65, 0 / 101 | 0 / 66, 0 / 102 |
| Failure arrives | no drops | 0 / 49 |
| Snippet dialog open / close (shared `ui/Dialog`, ticket 14) | 4 / 41, 8 / 192 | 12 / 114, 11 / 150 |

Unthrottled, the panel's interactions drop no frames (one on Details' main-thread height). The sheet animates `translate` and `opacity` only, both composited; long tasks land before the first moving frame (mount on open: ~25 ms, ~110 ms at 4×), never inside the slide. At 4× the slide drops about as much as the control square, which points at the machine; the outlier is Details' height transition, the documented exception that runs on the main thread (each frame lays out the log). Traces: `trace-chat-panel-headed-cpu1.json`, `trace-chat-panel-headed-cpu4.json`.

### `review-animations` (read from `~/.claude/skills/review-animations`: it can't be called through the Skill tool)

| Before | After | Why |
| --- | --- | --- |
| Send/Stop `transition-[scale,background-color,color]` (`ChatPanel.tsx`) | `transition-[scale]` | Its colour flips when the Owner types the first letter or clears the box: a keyboard-driven change, so it stays instant |
| Thinking auto-fold animated its height when the answer started (`Reply.tsx`) | `transition-none` until the Owner toggles it | The stream moved it, not the Owner; streamed content changes in place, and a main-thread height transition during streaming is avoidable |
| Details fetched on open, data landed mid-transition (`Reply.tsx`) | Fetch on `pointerenter` / `focus` of the trigger | No main-thread task inside the 200 ms height transition, no jump from the skeleton height |
| Every `useChatPanel()` consumer re-rendered on open and close (`chat-panel.tsx`) | `useChatActions()` / `useChatRequest()` for consumers that don't draw the open state | The click task before the slide starts shrinks; a 500-row Keys table no longer re-renders when the chat opens |

Answered, not changed: the sheet's opacity reaches 1 by ~120 ms while the slide runs 300 ms (the recipe: opacity on `--duration-fade` so reduced motion still fades); collapse is 200/200 (one `collapse` token, documented); popup 180/120, sheet 300/240, dialog 200/150 are asymmetric; no hover motion was added (colours only, and Tailwind's `hover:` is hover-capable only); origins: picker from `--transform-origin`, dialog centred. Verdict after the fixes: approve.

### Notes for the orchestrator

- After merging v2-ui at `1b5d0ea` (ticket 13's `@utility press`): Tools and the starter chips use `press`; Send/Stop copy only its scale (down on `duration-press`, back on `duration-release`, not for a key or while disabled), so their colour still flips instantly as the Owner types.

- `ui/toast.test.tsx` "an action on a toast runs and closes it" flakes when the whole suite runs on a busy machine (also on the base without this ticket's tests: the announcer keeps the text). It passes alone. Not touched (ticket 14's area).
- Record sheets (`sheets/records/*Sheet.tsx`) still call `useChatPanel()` only for `open`; switching them to `useChatActions()` would spare their re-render as the chat comes and goes (ticket 10/15).
