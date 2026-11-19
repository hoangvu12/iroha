# 10: Stacked side sheets for linked records

**What to build:** The sheet stack in the spec's "Stacked sheets (Owner's design)": sheets side by side in one row, the newest on the right and focused, older ones pushed left (off screen when there's no room) and kept mounted with their scroll; opening a record slides a sheet in from the right, closing the top one slides it out and the previous one back. Escape and Back close the top sheet only; opening a record already in the stack focuses it; opening from a lower sheet closes the ones above it first. The stack lives in the URL (reload, Back/Forward and shared links restore it). Build it from UI SDK (Drawer or Dialog, non-modal, or a part composed from `@ui-sdk/core` behaviours if neither fits: read the Drawer, Dialog and Popups pages and decide). Record sheets for Provider, Upstream Key, Endpoint, Gateway Key, Model Pool and Request, each with name, logo, state, key facts, its own linked records as links, the common actions (Test, enable/disable, copy) and an "Open page" button. The Requests page's detail drawer becomes the Request sheet, the first level of a stack. On phone width the stack shows only the top sheet, full width, with Back.

**Blocked by:** 03, 05

**Status:** done

Spec stories: 10, 11, 12.

- [x] Request → Provider → Upstream Key opens three sheets; closing returns one level at a time with the slide
- [x] Reload and Back/Forward restore the stack; focus moves into each new sheet and back on close
- [x] "Open page" goes to the record's full page; keyboard and screen reader can use every sheet

## Comments

**Built** (`web/src/sheets/`, details in architecture.md "UI ticket 10"):
- `SheetStackProvider` + `SheetStack`, mounted by `Shell`: one non-modal UI SDK `Dialog` per sheet, siblings in one row (each older sheet one width further left, off screen when there's no room, `inert` there; mounted with its scroll). The stack is in the URL as repeated `sheet=` params (`sheet=request:req_1/attempts&sheet=provider:acme&sheet=key:acme/team-5`); opening pushes history, closing the top goes Back when that entry opened it, else replaces. The old `?request=` links still work (rewritten).
- Rules: a record already open is focused (sheets above it close); opening from a lower sheet closes the ones above it first; Escape (in the top sheet, in an older one, or on the page) and Back close the top sheet only; a sheet's X closes it and those above. Focus moves into each new sheet (dialog `initialFocus="content"`; after a reload the top one) and back on close (the link that opened it, else the sheet now on top).
- Record sheets: Request (the drawer, now `RequestSheet` in `pages/requests/Drawer.tsx`; tabs in the URL, ↑/↓ stepping through the feed kept), Provider, Upstream Key, Endpoint, Gateway Key, Model Pool, each with logo, name, state, facts, linked records as links, actions (Test / Chat test, enable or disable for Providers and keys, copy), "Open page". A Test of a key shows its result in the sheet. Missing records say so (404).
- `RecordLink` + `rec.*` for ticket 11 (API in architecture.md); the Request sheet's Details already link Gateway Key, Provider, Endpoint, Upstream Key and Pool.
- Phones: only the top sheet, full width, Back in place of the X.
- Motion is plain: slide in and out on `translate` with `data-starting-style`/`data-ending-style`, `data-depth`/`data-top`/`--sheet-depth` ready for ticket 15.

**Decision, Dialog vs Drawer** (ui-sdk.md §4's open questions, checked with a throwaway jsdom probe and in Chrome): sibling non-modal Dialogs work. A dialog rendered open takes focus as it mounts (the last mounted, the top, wins after a reload). Escape reaches only the topmost layer, and only while focus is inside it: Escape in an older sheet does nothing on its own, so `SheetStack` closes the top sheet from the sheet's `onKeyDown`; Escape on the page is marked handled by UI SDK while a sheet is open, so the page listener runs in the capture phase. Back = the browser's history (each open is a history entry); UI SDK's `back` reason closes the top sheet through the same function, so nothing double-pops. `inline` was not needed. Drawer not used (owns translate, nested stacking, mouse drag).

**Test-first** (tdd skill; seams I chose since this run couldn't ask: the URL codec, the stack through the rendered host and links, the record sheets against a fake Iroha behind `fetch`, the agent test). 22 new tests in `sheets/*.test.ts(x)`; mutation check: removing the older-sheet Escape handler and the focus-after-close target each fail a test. Found on the way: the Request sheet's disabled ↑/↓ buttons had tooltips on disabled buttons (UI SDK strict-mode error, also in the old drawer): now `focusableWhenDisabled` (`IconButton` takes it).

**Checks:** `npm --prefix web run build` passes; `npm --prefix web test` 79/79. `ui/toast.test.tsx`'s "an action on a toast runs and closes it" timed out under a busy parallel run (passes alone): its exit wait now has a 4 s timeout. Browser (headless Chrome, seeded testkit): light, dark, phone 390 px, reload, Back/Forward, Escape; screenshots in `iroha-v2-notes/v2-ui/shots/10/` (`plan.json` there).

**Deferred:** Gateway Key name instead of its ID in Details, and links everywhere else a record is named (ticket 11). Polished motion (ticket 15). `CopyIconButton` is plain copy + toast until ticket 04's `CopyButton` lands.
