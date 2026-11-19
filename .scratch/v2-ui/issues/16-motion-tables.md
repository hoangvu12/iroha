# 16: Motion pass: Tables

**What to build:** A motion pass on one area only: DataTable everywhere: sorting, the bulk-action bar entering and leaving, rows added or removed after an action, page changes, inline Copied/saved morphs, row hover and press, filters (high-frequency surface: keep it fast or remove motion). One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Blocked by:** 04, 07, 08

**Status:** open

Spec story: 15.

- [ ] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [ ] Built motion matches the proposal; reduced motion holds still
- [ ] No dropped frames in a Chrome performance trace of this area's main interactions
- [ ] `review-animations` findings fixed or answered in Comments

## Comments
