# 19: Motion pass: Chat panel

**What to build:** A motion pass on one area only: the right-side chat panel: open and close, expand to full page, streaming replies, the collapsed details block, the model picker and settings, earlier chats dropdown, the snippet dialog, a failed reply. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 03, 05

**Status:** open

Spec story: 15.

- [ ] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [ ] Built motion matches the proposal; reduced motion holds still
- [ ] No dropped frames in a Chrome performance trace of this area's main interactions
- [ ] `review-animations` findings fixed or answered in Comments

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
