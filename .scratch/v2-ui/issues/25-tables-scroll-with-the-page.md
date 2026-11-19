# 25: Tables scroll with the page; select mode selects

**What to build:** Two DataTable fixes (`web/src/ui/DataTable.tsx`), for every table:

1. **No scroll inside the table.** Today a table's viewport is capped (`max-h-[calc(100dvh-4rem)]`, `DataTable.tsx:469`) and scrolls by itself. With the page header, tabs and toolbar above it, the Owner must scroll the page down, then scroll the table (Keys table of a Provider with 58 keys). The Owner decided (2026-11-20): the page scrolls; the table grows to its rows (numbered pages keep it bounded). The column header stays sticky under the top of the page's scroll container while the table is in view. Wide tables still scroll sideways inside themselves without breaking the sticky header (an `overflow-x` container makes `position: sticky` stick to it, not to the page; solve it, e.g. a header synced to the body's horizontal scroll, `overflow-x: clip` where possible, or the approach UI SDK's docs suggest). The Requests feed keeps live rows, scroll anchoring and load-older-on-scroll, now driven by the page scroll (`maxHeight` prop and the feed's use of the table viewport). Check the sticky header under the chat panel and sheets, and on the phone layout.
2. **Select mode.** Once one or more rows are selected (select mode, the bulk bar is up), a click or tap anywhere on a row toggles its selection instead of opening the row's details; Shift+click selects a range. Opening a row in select mode is still possible through its name link or row menu ("Open"). The checkbox's hit area is the whole cell. Outside select mode, row click opens details as today. Keyboard: Space toggles the focused row in select mode. Tested on Upstream Keys and Models, where the Owner kept opening details by mistake.

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20. This reverses the "each table scrolls inside itself" decision reported after the first batch.

- [ ] Tables grow with their rows and the page scrolls; header sticky; sideways scroll still works; Requests feed live and load-older still work; tests
- [ ] In select mode a row click toggles selection, Shift+click selects a range, Open is still reachable; tests incl. agent test
- [ ] Checked in headless Chrome, light, dark and phone width (Keys, Models, Requests, Gateway Keys, Audit Entries)
