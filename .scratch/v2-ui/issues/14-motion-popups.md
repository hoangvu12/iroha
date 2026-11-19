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
