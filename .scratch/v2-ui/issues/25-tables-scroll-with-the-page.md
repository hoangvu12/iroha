# 25: Tables scroll with the page; select mode selects

**What to build:** Two DataTable fixes (`web/src/ui/DataTable.tsx`), for every table:

1. **No scroll inside the table.** Today a table's viewport is capped (`max-h-[calc(100dvh-4rem)]`, `DataTable.tsx:469`) and scrolls by itself. With the page header, tabs and toolbar above it, the Owner must scroll the page down, then scroll the table (Keys table of a Provider with 58 keys). The Owner decided (2026-11-20): the page scrolls; the table grows to its rows (numbered pages keep it bounded). The column header stays sticky under the top of the page's scroll container while the table is in view. Wide tables still scroll sideways inside themselves without breaking the sticky header (an `overflow-x` container makes `position: sticky` stick to it, not to the page; solve it, e.g. a header synced to the body's horizontal scroll, `overflow-x: clip` where possible, or the approach UI SDK's docs suggest). The Requests feed keeps live rows, scroll anchoring and load-older-on-scroll, now driven by the page scroll (`maxHeight` prop and the feed's use of the table viewport). Check the sticky header under the chat panel and sheets, and on the phone layout.
2. **Select mode.** Once one or more rows are selected (select mode, the bulk bar is up), a click or tap anywhere on a row toggles its selection instead of opening the row's details; Shift+click selects a range. Opening a row in select mode is still possible through its name link or row menu ("Open"). The checkbox's hit area is the whole cell. Outside select mode, row click opens details as today. Keyboard: Space toggles the focused row in select mode. Tested on Upstream Keys and Models, where the Owner kept opening details by mistake.

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20. This reverses the "each table scrolls inside itself" decision reported after the first batch.

- [x] Tables grow with their rows and the page scrolls; header sticky; sideways scroll still works; Requests feed live and load-older still work; tests
- [x] In select mode a row click toggles selection, Shift+click selects a range, Open is still reachable; tests incl. agent test
- [x] Checked in headless Chrome, light, dark and phone width (Keys, Models, Requests, Gateway Keys, Audit Entries)

## Comments

**Built** (all in `DataTable`, so every table has it; notes in `docs/agents/architecture.md` "UI ticket 25"):
- **Page scroll.** The table is as tall as its rows; `maxHeight` and the `max-h-[calc(100dvh-4rem)]` cap are gone. Its `ScrollArea` (now `TableScroller`, `axis="x"`) only scrolls sideways. The header can't be `position: sticky` (it would stick to the sideways scroller), so it follows the page with a CSS scroll-driven animation: `view-timeline` on the scroller, and the header translates down with the scroll from where the table's top passes the window's top, at most the table's height less its own (`--table-stick-end`, measured by a `ResizeObserver`). Off the main thread, aligned when scrolled sideways, under the chat panel and sheets. Firefox (no scroll timelines yet) gets a header that scrolls away; noted in architecture.md.
- **Requests feed on the page.** `hold-view` holds the view by moving the page and counts the stuck header as the top of the view; the "N new" pill sticks under the header at the top of the window; "Load older" sits under the table and its observer watches the window; `arrivals.ts` `inView` counts the window and the stuck header.
- **Select mode.** With any row selected, a click on a row toggles it instead of opening it, Shift+click selects a range (and doesn't select text), and Space on the row's controls toggles it, except where Space has its own job (checkbox, switch, fields, menu triggers). The name's "Open <name>" button, RecordLinks and the row menu still open the row. The checkbox's whole cell (and the header's) is its hit area. Phones already toggled on tap once selecting.

**Test-first:** used the `tdd` skill; one failing test, then the code, for each behaviour, in `ui/DataTable.test.tsx`: row click toggles in select mode and opens again once none are selected, Shift range, Open from the name and the row menu in select mode, the checkbox cell, Space, an agent test (select by boxes, open by name while selecting); live rows held by the page scroll (the two layout tests rewritten for the page), load-more watching the window, no height cap with the header's travel measured. `ui/new-rows-pill.test.tsx`'s layout now scrolls the page.

**Browser checks** (headless Chrome, seeded: a Provider with 58 keys, 120 models, 31 Gateway Keys, ~100 Requests and their Audit Entries), screenshots and scripts in `iroha-v2-notes/v2-ui/shots/25/`:
- Light and dark at 1440: Keys, Models, Requests, Gateway Keys, Audit Entries. Measured on each: the table never scrolls vertically (`scrollHeight - clientHeight` 0), the header is at the table's top until it reaches the window's top, then stays at 0 until the table's bottom passes (`*-probe` in `results.json`; `*-top.png`, `*-scrolled.png`).
- Requests at 1100 px: the table scrolls sideways (141 px), header and body stay aligned while scrolled sideways and the header is stuck (`requests-1100-sideways.png`); scrolling the page to the end loads older Requests (100 → 105, `older25.mjs`); a live Request arriving while scrolled keeps the row under the reader still (60 → 60 px) and shows "1 new" under the header; the pill brings the first row back under the header (`requests-live-pill.png`).
- Under the Request sheet and the chat panel the header stays at the top (`requests-under-sheet.png`, `keys-under-chat.png`).
- Select mode on Keys and Models: click → 2 selected, Shift+click → range, checkbox cell toggles, no text selected, no dialog opened; after Clear selection a row click opens the key / model dialog (`keys-select-mode.png`, `models-select-mode.png`, `*-row-opened.png`).
- Phone (390, light and dark) on all five: two-line lists scroll with the page, no sideways page scroll.

**Notes:** the seed's `go test` process was killed twice after ~3.5 min with no output (another worktree's clean-up stopping test processes by name, most likely); running a test binary built under a unique name avoided it. `pages/requests/Feed.test.tsx` "numbered pages in the View menu" took 21 s and timed out once in the full run while a server was seeding; it passes alone (pre-existing slow test).
