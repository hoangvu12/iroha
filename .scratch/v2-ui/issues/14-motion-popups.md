# 14: Motion pass: Popups and confirmations

**What to build:** A motion pass on one area only: dialogs, alert dialogs, menus, selects, comboboxes, tooltips (delay and instant-after-first), popovers and the remaining toasts, app-wide, so they share one set of curves and durations. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 03, 04

**Status:** open

Spec story: 15.

- [ ] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [ ] Built motion matches the proposal; reduced motion holds still
- [ ] No dropped frames in a Chrome performance trace of this area's main interactions
- [ ] `review-animations` findings fixed or answered in Comments

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
