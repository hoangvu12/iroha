# 26: Skeleton to data stays smooth with a lot of data

**What to build:** The Owner loves the skeleton sweep (Skullet `0.0.3`, `ui/Skeleton.tsx`, `app/skeletons.tsx`), but with a lot of data the switch from skeleton to real rows drops frames (e.g. a Provider's Keys table with 58 keys, Models with many models, the Requests feed). Find out why and fix it, keeping the sweep if possible.

- Measure first: headed Chrome performance traces (headless draws ~10 fps; see `shots\13\` scripts) of the skeleton→data switch on a big table, before and after. Name the cost (sweep painting per bone, Skullet measuring the real DOM, the rows' reveal animation running on every row at once, layout of many rows, React render).
- Read Skullet's docs that ship in `node_modules` and its GitHub repo/issues for performance guidance (e.g. one shared gradient vs one per bone, composited `transform` vs `background-position`, limits, `content-visibility`); note what you found in the notes folder (`skullet.md`).
- Use the `animation-performance` skill. Keep the sweep if it can be made composite-only and cheap; if not, use a lighter effect (e.g. a pulse on opacity) for large skeletons only and keep the sweep for small ones. Stagger or skip the row reveal when many rows arrive at once (ticket 16's motion; reveal only what's in view).
- Reduced motion stays respected.

**Blocked by:** 25 (tables change how they scroll; measure on the new layout)

**Status:** open

Owner request, 2026-11-20.

- [ ] Cause measured and written in Comments with before/after numbers (dropped frames or long frames during the switch)
- [ ] Switch is smooth on the big tables; sweep kept or the fallback rule documented; tests for any rule (e.g. size threshold)
- [ ] Checked in headless Chrome, light, dark and phone width
