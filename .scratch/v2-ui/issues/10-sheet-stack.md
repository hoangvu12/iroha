# 10: Stacked side sheets for linked records

**What to build:** The sheet stack in the spec's "Stacked sheets (Owner's design)": sheets side by side in one row, the newest on the right and focused, older ones pushed left (off screen when there's no room) and kept mounted with their scroll; opening a record slides a sheet in from the right, closing the top one slides it out and the previous one back. Escape and Back close the top sheet only; opening a record already in the stack focuses it; opening from a lower sheet closes the ones above it first. The stack lives in the URL (reload, Back/Forward and shared links restore it). Build it from UI SDK (Drawer or Dialog, non-modal, or a part composed from `@ui-sdk/core` behaviours if neither fits: read the Drawer, Dialog and Popups pages and decide). Record sheets for Provider, Upstream Key, Endpoint, Gateway Key, Model Pool and Request, each with name, logo, state, key facts, its own linked records as links, the common actions (Test, enable/disable, copy) and an "Open page" button. The Requests page's detail drawer becomes the Request sheet, the first level of a stack. On phone width the stack shows only the top sheet, full width, with Back.

**Blocked by:** 03, 05

**Status:** open

Spec stories: 10, 11, 12.

- [ ] Request → Provider → Upstream Key opens three sheets; closing returns one level at a time with the slide
- [ ] Reload and Back/Forward restore the stack; focus moves into each new sheet and back on close
- [ ] "Open page" goes to the record's full page; keyboard and screen reader can use every sheet
