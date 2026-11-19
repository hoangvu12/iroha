# 14: Motion pass: Popups and confirmations

**What to build:** A motion pass on one area only: dialogs, alert dialogs, menus, selects, comboboxes, tooltips (delay and instant-after-first), popovers and the remaining toasts, app-wide, so they share one set of curves and durations. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 03, 04

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [ ] No dropped frames in a Chrome performance trace of this area's main interactions (see "Performance trace": every animated property composites and no task over 13 ms falls in any window at 1×, but this machine's frame reporter counts as many "dropped" frames at rest as during motion, the same as ticket 13 found, so it can't give a clean zero)
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, 2026-11-19)

**Recon.** All popups are UI SDK parts styled in `web/src/ui/`: `popup.ts` `popupClass` (Menu `MenuContent`, `SubMenu`, `Select`, `Autocomplete`), `Tooltip.tsx` `tooltipClass` (`Tip`, so every icon button and `MenuIconTrigger`), `Dialog.tsx` (`Dialog`, and `Confirmation` behind `ConfirmDialog`/`TypeToConfirmDialog`/`useConfirm`), `toast.tsx` (`Toaster`). No other page renders its own popup: the chat Picker (Popover + Command, the only "combobox" and popover) is ticket 19's, sheets are 15's. The tokens and recipes in architecture.md "UI motion system" exist; none of these files uses them yet: everything is typed `duration-100/150/300`, `scale-96`, and exits last as long as entrances. Personality: crisp operator dashboard. Frequency: menus, selects and tooltips tens a day; dialogs, confirmations and toasts occasional; a swiped toast rare.

**Opportunities (what moves, exact values from the tokens):**

| # | Location | Today | Purpose | Frequency | Motion |
|---|---|---|---|---|---|
| 1 | `ui/popup.ts:6-7` (menu, submenu, select, autocomplete) | 150 ms in and out, typed `scale-96` | Spatial consistency (grows from its trigger), asymmetric exit so closing never lags | Tens/day | `origin-(--transform-origin) transition-[opacity,scale] duration-popup-in ease-out` (180 ms, `cubic-bezier(0.23, 1, 0.32, 1)`), from/to `scale-(--motion-scale-popup)` (0.96) + `opacity-0`, `data-ending-style:duration-popup-out` (120 ms) |
| 2 | `ui/Dialog.tsx:22-30` (dialog, alert dialog, backdrop) | 150/150 ms | Preventing a jarring change; centred, no origin | Occasional | content `transition-[opacity,scale] duration-dialog-in ease-out` (200 ms), from/to `scale-(--motion-scale-popup)` + `opacity-0`, `data-ending-style:duration-dialog-out` (150 ms); backdrop `transition-opacity` with the same two durations |
| 3 | `ui/Tooltip.tsx:7-8` | 100 ms, no curve (Tailwind's default), exit opacity only | Spatial consistency | Tens/day | same recipe with `duration-tooltip` (125 ms) `ease-out`, exit scales back too; `data-instant:duration-0` (the next tooltip after one was open appears at once). Delay stays UI SDK's 600 ms. |
| 4 | `ui/toast.tsx:37,44-47` | 300 ms `ease-out`; a swipe-dismissed toast fades where the finger let go; a downward swipe doesn't follow the finger (`--toast-swipe-y` unused) | Spatial consistency (enters from the bottom edge, leaves the way it was thrown) | Occasional (swipe rare) | toasts and region `duration-toast` (400 ms) `ease-[ease]`; enter from `translate-y-(--motion-toast-offset)` + `opacity-0`; older toasts move up on the same frame and curve (one move, no stagger); a timed-out or Undo'd toast fades in place (opacity); a swiped one continues one own-width right / own-height down while fading (`data-swipe-direction`), `motion-safe` only; follow `--toast-swipe-y` while dragging; `data-swiping:transition-none` stays |
| 5 | `ui/Dialog.tsx:76` (dialog Close ×) | no press, instant hover, unlike every other icon button | Feedback | Occasional | `iconButtonClass("sm")`: the shared press `active:scale-(--motion-scale-press)` (0.97) `duration-press ease-out` and hover colours; same centre as now |
| 6 | `ui/Dialog.tsx:148` (confirm button while `onConfirm` runs) and `:139` (its error) | pending looks like rest (only the cursor changes); the error line pops in | State indication; preventing a jarring change | Occasional | `data-pending:opacity-70`, instant (no spinner, not in the transition list); error `starting:opacity-0 transition-opacity duration-list-in ease-out` like the Field error (ticket 13) |

**Reduced motion:** built only from the tokens, so scale becomes 1 and toast/sheet offsets 0: popups, dialogs and tooltips play as short fades with the same durations; toasts keep `motion-reduce:transition-opacity` (the stack doesn't slide, a new toast fades in place), the region's height snaps, a swiped toast fades where it was let go. The parts drop `motion-reduce:transition-none` in favour of the system's fades.

**Rejected:**
- Highlight moving between menu, select and autocomplete items (arrow keys and pointer). **Frequency: keyboard and tens/day; instant background, no transition.**
- Push-back scale or offset of a dialog under a nested one (`ModelPicker` over `CreateDialog`), or of the page under any dialog. **Function: adds motion to a dense form; the second backdrop already shows the layer.**
- Collapsing the toast stack Sonner-style (peek, per-index scale, expand on hover). **Function: `expanded: true` is deliberate (at most 5, all readable at once); collapse adds motion on every hover.**
- Rotating the Select chevron on open, and a spinner on pending confirm buttons. **Purpose: decoration / no spinners (C25); the open border and the dimmed button say it.**
- Anything extra for a submenu opening on Arrow Right or a popup closing on Escape. **Frequency: keyboard; the normal short exit only.**
- Changing the tooltip delay or animating an instant tooltip. **Frequency: moving along a toolbar must read as one tooltip following the pointer.**

**Verdict:** the area already moves in the right ways (from the trigger, centred dialogs, swipe stops transitions); what it needs is the shared tokens, faster exits, and the toast's spatial story finished. Highest leverage: #1, `popupClass`, which carries every menu, select and autocomplete.

### Built (2026-11-19)

Test-first with the `tdd` approach (no `tdd` skill call needed for this: each behaviour got a failing test first). `ui/popup-motion.test.tsx` reads the classes on the real markup of a menu and its submenu, a Select, an Autocomplete, a tooltip, a Dialog, an alert dialog and a toast: tokens only (no `duration-150`, `scale-96`), exit durations, origin, the instant tooltip, the toast's swipe exits, the pending confirm button, the Close press. It was red on all six before the code. Skills: `find-animation-opportunities` (above), `animate`, `choreograph` (toast stack and dialog + backdrop), and the `animation-performance` checks below; the press itself is ticket 13's, reused.

- **Menus, submenus, selects, autocompletes** (`ui/popup.ts`): 180 ms in, 120 ms out, `ease-out` (0.23, 1, 0.32, 1), from and back to `--motion-scale-popup` at `--transform-origin`. Measured in Chrome: `opacity`/`scale` 180 ms in, 120 ms out.
- **Tooltips** (`ui/Tooltip.tsx`): 125 ms both ways with `ease-out` (it had none), scale out as well as in, `data-instant:duration-0`. Measured: the first tip runs 125 ms; the next one along shows with `data-instant` and no transition.
- **Dialogs and alert dialogs** (`ui/Dialog.tsx`): content and backdrop 200 ms in, 150 ms out, centred. The Close × is `iconButtonClass("sm")` (press, hover colours), centred where the old one was. The confirm button dims to 0.7 at once while `onConfirm` runs (measured: `data-pending`, opacity 0.7); its error fades in like the Field error.
- **Toasts** (`ui/toast.tsx`): 400 ms `ease`; enter from `--motion-toast-offset` below; the stack moves up on the same frame; Undo or timeout fades in place while the rest close the gap; a toast follows the finger down too now (`--toast-swipe-y` was unused) and, swiped, keeps going right or down (`motion-safe`; measured mid-exit `translate: calc(10% + 72px)` from 80 px toward 100%). The region's own height transition is gone (see review).
- **Reduced motion** (emulated in Chrome): menus, tooltips and dialogs run opacity at their durations and a `scale` transition from `1` to `none` (no movement); toasts run opacity only (no slide, no stack move); a swiped toast fades where it was let go (80 px).
- **Choreography** (timeline): new toast = lead (rise + fade, 0 ms, 400 ms); older toasts = support, translate up, 0 ms, 400 ms, together; a leaving toast fades in place, together with the stack closing; the region is static. Dialog content and backdrop start together on one duration. Menu items come with their menu (one entrance per container).

**The toast flake** (`ui/toast.test.tsx` "an action on a toast runs and closes it", tickets 13 and 21). Not that test's logic: UI SDK checks once, 1 s after a file's first toast, that a host renders toasts, and strict mode makes its warning an uncaught error that Vitest pins on whatever test ran last. Whether a test's `<Toaster />` was mounted at that instant depended on how fast the file ran. Reproduced: 1 unhandled "A toaster opened, but no host renders it" in 8 loaded full runs, 22 under heavier load, mostly from `pages/providers/Models.test.tsx` (its Undo toasts, no Toaster) and once from `toast.test.tsx`. Fix: `test/setup.ts` counts one host for the whole run (`overlays.attachHost()`, `@ui-sdk/core/overlays`); `test/toast-host.test.tsx` pins it (red before: the error, deterministically with fake timers). After: 8 loaded full runs and 240 repeats of `toast.test.tsx`, no errors.

**Browser checks** (headless Chrome, seeded testkit; light, dark, 390 px): screenshots in `iroha-v2-notes\v2-ui\shots\14\` (`*-menu`, `*-row-menu`, `*-filter-submenu`, `*-select`, `*-dialog`, `*-confirm`, `*-confirm-pending`, `*-toasts`, `*-tooltip`), measurements in `results.json` and `results-extra.json`, script `check14.mjs`. Not this ticket: `/states` is 539 px wide at 390 px (the page scrolls sideways, so its phone shots there are offset); real pages are 390.

### Performance trace

Headed Chrome, 1× and 4× CPU, on `/states`: menu open/close ×3, alert dialog open/Cancel ×2, tooltip then the next one, two toasts; each with the motion and again with every transition off, plus a 1.5 s rest window. Files `trace14-headed-cpu{1,4}.json`, `segments-cpu{1,4}.json` (outside the repo).
- **Compositing:** every animation of this area runs on the compositor (`scale`, `opacity`, `translate`, button `background-color`); only icon-button `color` (ticket 13's press) runs on the main thread.
- **1×:** no task over 13 ms in any window. rAF intervals with motion: dialog max 16 ms, tooltips 14, toasts 18, menu one 49 ms gap (no long task behind it; control 14). Main-thread work while a menu animates is about 0.8 ms per frame.
- **4×:** 52–101 ms tasks in both the motion and the still windows (React mounting and unmounting the popups), so not the motion.
- **Frame reporter:** 52 "dropped" frames in 1.5 s at rest with nothing moving, 33–53 in the motion windows; as in ticket 13 it can't give a clean count on this desktop, so the box stays unticked. A real 60 Hz device would settle it.

### `review-animations` (on this ticket's diff)

| Before | After | Why |
|---|---|---|
| Toast region `transition-[height] duration-300` | No transition | The region is transparent and doesn't clip (measured `overflow: visible`): animating its height was layout work every frame for nothing visible. Fixed. |
| A swiped toast faded where the finger let go; a downward drag didn't move it | Follows `--toast-swipe-y`; leaves right/down (`data-swipe-direction`, `motion-safe`) | Exit the way it was thrown. Fixed. |
| Popups, dialogs `150/150`, tooltip `100/100` with no curve | 180/120, 200/150, 125 `ease-out` | Exits faster than entrances; tooltip had Tailwind's weak default. Fixed. |
| Tooltip exit stays 125 ms while the next shows at once | Kept | UI SDK marks only the opening tip `data-instant`; the old one fades over a different button. Not a press or hold, so the asymmetry rule doesn't apply. Answered. |
| Toast `height` transition (a layout property) | Kept | UI SDK's toast recipe (`--toast-height` on an absolutely placed toast); it changes only when a toast's content does. Answered. |
| Under reduced motion a `scale` transition still runs | Kept | It goes from `1` to `none`: nothing moves (measured keyframes). Answered. |

Verdict: approve. No `transition-all`, `scale(0)`, `ease-in`, keyframes, ungated hover motion or motion on keyboard surfaces in the diff; everything is a CSS transition and so retargets when interrupted.
