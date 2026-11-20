# 26: Skeleton to data stays smooth with a lot of data

**What to build:** The Owner loves the skeleton sweep (Skullet `0.0.3`, `ui/Skeleton.tsx`, `app/skeletons.tsx`), but with a lot of data the switch from skeleton to real rows drops frames (e.g. a Provider's Keys table with 58 keys, Models with many models, the Requests feed). Find out why and fix it, keeping the sweep if possible.

- Measure first: headed Chrome performance traces (headless draws ~10 fps; see `shots\13\` scripts) of the skeleton→data switch on a big table, before and after. Name the cost (sweep painting per bone, Skullet measuring the real DOM, the rows' reveal animation running on every row at once, layout of many rows, React render).
- Read Skullet's docs that ship in `node_modules` and its GitHub repo/issues for performance guidance (e.g. one shared gradient vs one per bone, composited `transform` vs `background-position`, limits, `content-visibility`); note what you found in the notes folder (`skullet.md`).
- Use the `animation-performance` skill. Keep the sweep if it can be made composite-only and cheap; if not, use a lighter effect (e.g. a pulse on opacity) for large skeletons only and keep the sweep for small ones. Stagger or skip the row reveal when many rows arrive at once (ticket 16's motion; reveal only what's in view).
- Reduced motion stays respected.
- **Skeleton rows are inert** (found by ticket 24): a click on a Requests feed row while the skeleton showed opened a sheet for the sample record (`gk_sample`). Skeleton rows (sample data) must not open sheets, menus or links, nor be focusable; check every table and sheet skeleton; test it.

**Blocked by:** 25 (tables change how they scroll; measure on the new layout)

**Status:** done

Owner request, 2026-11-20.

- [x] Cause measured and written in Comments with before/after numbers (dropped frames or long frames during the switch)
- [x] Switch is smooth on the big tables; sweep kept or the fallback rule documented; tests for any rule (e.g. size threshold)
- [x] Checked in headless Chrome, light, dark and phone width

## Comments

### Cause (measured)

Headed Chrome over CDP, the API answer held with the Fetch domain and then released, rAF frame deltas + longtask observer + a CPU profile of the switch; CPU throttle 4x and 1x, 3 runs each. Seed: one Provider with 60 Keys, 100 Models, 100+ Requests, Gateway Keys. Scripts: `iroha-v2-notes\v2-ui\shots\26\trace26.mjs` (with `cdp26.mjs`), the before build is `shots\26\dist-before\`.

The sweep itself was not the cause: while the skeleton shows, a 153-bone sample sweeps at p90 4–8 ms per frame at 1x. The frames drop in one long main-thread task at the switch, all Skullet's and React's, so even composited motion can't hide it. Profile of the Requests switch (4x, task 2.2–2.7 s):

- Skullet's `smart` sequence reveal (~0.6 s): it reads every piece's box between the animations it starts, one forced layout per piece (upstream #19, #28).
- An overlay per pending image (~0.4 s): the Provider logos in every row, each with a forced layout.
- Bone exit (~0.3 s), React rendering 100 rows (~0.3 s), Skullet's Memory cloning the content twice (0.1–0.2 s, upstream #22, #29), then layout.
- A second, worse case: the remembered shape of a big table. Skullet remembers the last shown content with no size limit, so the next visit draws every row as bones: 1,414 bones for Requests (draw task 2–6.3 s at 1x, 10–33 s at 4x; switch 3–9.6 s at 1x), 486 for Keys.

The sweep animates `background-position` per bone on the main thread (upstream #2, #31 propose `transform`; nothing released), so it freezes during those tasks and costs paint on huge skeletons.

### What was built

- **Big reveals crossfade whole** (`app/skeletons.tsx`, `revealFor`): Skullet's `smart` still picks the reveal, but when it picks a sequence for more than 60 pieces Iroha uses `together` (one opacity crossfade). A waited or input-driven reveal stays instant, a refetch stays a 120 ms crossfade, as `smart` decides.
- **Rows past a screenful follow the reveal** (`ui/reveal-rows.ts`, `useRevealRows`, used by `DataTable`): when more than 30 rows arrive over a skeleton, the first 30 come with the reveal and the rest render in a transition on the next frame. Rows present from the start, or 30 or fewer, all come at once.
- **Logos don't hold the reveal** (`ui/LogoTile.tsx`): the `<img>` gets its `src` after Skullet's reveal has started, so Skullet sees no pending image and draws no overlays. Logos appear when loaded (no per-image crossfade).
- **Big skeletons are cut** (`styles/index.css`): a skeleton drawn from a big table's remembered shape is clipped at the window's height and rows past the 30th aren't laid out (Skullet skips `display:none` and clipped content when it measures). 1,414 bones became 266.
- **Fallback rule:** the sweep stays on samples (at most 20 rows, which all of Iroha's samples are); a skeleton with more than 20 rows (a remembered shape) pulses instead (`--skullet-animation: pulse`, opacity, composited). Reduced motion: Skullet still stops both the sweep and the pulse.
- **Skeleton content is inert** (`ui/Skeleton.tsx`): everything a skeleton draws (the sample, or the last-shown rows re-drawn as the skeleton) sits in an `inert` `display:contents` wrapper that also stops click, pointer, mouse, touch, key and submit events in the capture phase, so even dispatched events reach no handler. Covers every `Skeleton` use: tables, the phone lists, sheets and pages.
- `docs/agents/architecture.md`: new "UI ticket 26" subsection; the ticket 02 line now points to it. `skullet.md` in the notes folder has a Performance section with the internals and the upstream issues.

### Before/after (median of 3 runs: longest frame / frames lost / longest task)

| Table | Before 1x | After 1x | Before 4x | After 4x |
|---|---|---|---|---|
| Keys (60) | 212 ms / 13 / ~200 ms | 75 ms / 4 / 49–66 ms | 1067 ms / 92 / 0.98–1.83 s | 350 ms / 36 / 262–394 ms |
| Models (100) | 237 ms / 15 / 172–233 ms | 38 ms / 2 / 35 ms | 1221 ms / 97 / 1.07–1.13 s | 292 ms / 25 / 216–323 ms |
| Requests (100) | 442 ms / 32 / 396–473 ms | 58 ms / 5 / 46–50 ms | task 2.2–2.7 s | 496 ms / 51 / 291–468 ms |
| Gateway Keys | 62 ms / 3 / 57–68 ms | 63 ms / 3 / 55 ms | 363 ms / 26 / 314–406 ms | 163 ms / 9 / 134–141 ms |

Remembered shapes (visiting a big table again):

- Requests, 1x: mount 2.0–6.3 s → 146–474 ms; switch task 3.2–9.6 s → 91–109 ms (longest frame 125 ms). 4x: mount 10.5–33.5 s → 761–861 ms; switch 14.8–30.9 s → 311–400 ms.
- Keys, 1x: 16 frames lost → 2; switch task ~250 ms → ~50 ms; mount ~330 ms → 81–141 ms.

### Test-first

Seams (tdd skill): the `Skeleton` component, `DataTable` while loading, the `revealFor` rule, `LogoTile`. Each test was seen red on the old code, then green:

- `ui/Skeleton.test.tsx`: a skeleton's rows take no click, press or key, even dispatched straight at them (also for last-shown rows re-drawn as the skeleton); its controls sit under `inert`.
- `ui/DataTable.test.tsx`: sample rows open nothing (row click, bulk select, row menu); 100 rows over a skeleton come 30 first, then all; rows present from the start or few come at once.
- `app/skeletons.test.tsx`: `revealFor` for 30/60 pieces (sequence), 61/716 (together), waited/input (instant), refetch (120 ms crossfade), 2 pieces; `hold` stays 150.
- `ui/LogoTile.test.tsx` (new): no `src` during the parents' layout effects, then set; a new version updates it; an error shows the letter.
- `pages/requests/Feed.test.tsx`: the numbered-pages test waits up to 5 s for 100 rows (the transition renders slowly in jsdom under full-suite load).

The CSS cut and pulse rule live in `index.css` (jsdom has no layout), checked in the browser instead.

### Browser checks

`shots26.mjs` (headed Chrome, the API held to keep the skeleton up): light, dark, phone (390 px) and phone-dark. Sample skeleton: 153 bones sweeping (71 on phone); remembered shape: 266 pulsing (84 on phone); the Keys table renders all 60 rows at its bottom after the reveal. `inert26.mjs` clicked and tabbed through every page's skeleton, desktop and phone: nothing opened, no focus landed, every skeleton has `inert`. Screenshots in `iroha-v2-notes\v2-ui\shots\26\`.

### review-animations

- The big-reveal crossfade is opacity only, content replaced in place: fine, and it survives a busy main thread.
- The pulse on big skeletons is opacity (composited); the sweep is kept where it's cheap.
- Logos pop in when loaded rather than crossfading: acceptable for a 20 px tile, and keeps the reveal unblocked.
- Skullet's 280 ms height animation of the reveal root remains (a measured-height animation, Skullet's, not changed here).
- Reduced motion is handled by Skullet for the sweep, the pulse and the reveal.

### Deferred

- The live Requests feed: Skullet re-copies its content (Memory) ~250 ms after each arrival. Skullet's; adopt upstream #22/#29/#7 when released.
- A remembered Requests shape still costs 146–474 ms to mount at 1x: Skullet parses and sanitises the remembered HTML of all 100 rows, which CSS can't cut. Same upstream issues.
- A composited sweep (upstream #2, #31): when released, the sweep could come back on big skeletons.
