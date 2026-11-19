# 06: Shared DataTable, proven on the Upstream Keys table

**What to build:** One `DataTable` component in `web/src/ui/`, replacing `web/src/ui/Table.tsx`: a semantic `<table>` driven by TanStack Table (`@tanstack/react-table`, headless), with UI SDK parts for its controls. Features, each switched on by the page: column definitions with cell renderers; sorting by clickable headers (`aria-sort`); a search box and column filters (client-side, or passed to the server when the page's API pages itself); row selection with a select-all checkbox and a bulk-action bar that slides in while rows are selected; a row-actions Menu; clickable rows (opening a sheet later, in ticket 10); sticky header inside a Scroll Area; empty, no-results and error states; a Skullet skeleton measured from a sample row (ticket 02's pattern); and pagination with UI SDK Pagination and a page-size Select, remembered per table in `localStorage` (wrapped in try/catch). It also supports an "infinite" mode (load more on scroll) for ticket 09. Build it by moving the Upstream Keys table (`web/src/pages/providers/Keys.tsx`, the Owner's most-used table) onto it with every feature it has today (bulk actions, Key States, gaps, Test, restrict) and nothing lost.

**Destructive actions (Owner, 2026-11-19):** row and bulk actions that delete, remove, revoke or clear use the danger tone and confirm component from ticket 21 (`docs/agents/architecture.md`, "UI ticket 21"); if 21 is not merged when you start, keep those actions behind one prop so its component drops in.

**Blocked by:** 01, 02, 03

**Status:** done

Spec stories: 5, 6.

- [x] Keys table on DataTable with all of today's actions; pages of 25/50/100, choice remembered
- [x] Keyboard: sort, select, open row actions and page without a mouse; agent test from the skill's agent-ready reference
- [x] Usage notes for DataTable in `docs/agents/architecture.md` so tickets 07–09 follow one pattern

## Comments

**Built.** `web/src/ui/DataTable.tsx`, on TanStack Table `9.3.1` (exact pin), with `columnsFor`, `RowMenu` and `useTablePaging`. It has:
- Sorting through header buttons, with `aria-sort`.
- Search and column filters, client-side or `manualFiltering`.
- Selection, with a mixed select-all, Shift ranges, and a bulk bar that slides in (`starting:`, `duration-list-in`) and offers "Select all N".
- A row menu, and clickable rows that ignore their own controls; `meta.opens` gives the keyboard and agents a way in.
- Expandable rows, hidden columns, and a danger row tone.
- Phone two-line rows (C31), with Select / Done.
- A sticky header inside a ScrollArea.
- Error, empty and no-results states with chips.
- A built-in Skullet skeleton (`table:<id>`, `:phone`).
- Four paging modes: pages, server, infinite (IntersectionObserver plus a "Load more" button), none.

Pages hold 25/50/100 rows; the size is remembered per table in `localStorage` (try/catch). `web/src/ui/Pagination.tsx` (`Pager`) is UI SDK Pagination, 1-based. `Checkbox.onChange` now passes the event, for Shift ranges.

The Keys tab is on it with every action it had:
- Test, Disable and Enable; Endpoints…; Clear Model/Endpoint Gaps; Restrict to working Endpoints; Copy keys; Delete…; Test in Chat.
- Key States, gaps pills and the secret cell.
- `?q`, `?state`, `?sort`, `?dir` and `?key` in the URL.
- Bar results with Undo, and the per-key results dialog.

Deletes (row and bulk) ask through `useConfirm` and name the count and the first five keys. The old `ConfirmDialog` state is gone. The API for tickets 07–09 is in `docs/agents/architecture.md`, "UI ticket 06".

**Test-first** (tdd skill), at two seams: `DataTable` (`ui/DataTable.test.tsx`, 16 tests, including an agent test with sort/select/menu/page/page-size steps) and `KeysTab` (`pages/providers/Keys.test.tsx`, 7 tests). The Keys tests were written against the old table first, and 5 of 7 failed there. Full web suite: 36 files, 173 tests, all passing; `npm --prefix web run build` passes.

**Browser check** against a seeded testkit server (42 keys, one Provider with no keys), in Chrome light, dark and phone (390 px, no sideways scroll). I looked at:
- Selection and a whole page selected.
- The footer, page 2 and the page-size menu.
- The sticky header while the table scrolls.
- The row menu and the bulk delete confirm.
- No results with chips, and the empty state.

Screenshots: `iroha-v2-notes/v2-ui/shots/06/` (outside the repo; `plan.json` is the shot plan). Fixed after looking:
- The page-size Select stretched (`w-full` beats a width class with no tailwind-merge) and pushed the pager onto its own line.
- The footer text was squeezed on phones.
- The phone state filter took the whole line; now it shares the search line, as in C31.

**Deferred / worth knowing:**
- Not run in a browser: the skeleton (covered in jsdom; its ids are set) and Shift-click ranges (covered by jsdom).
- The sticky header needs the table to be its own scroller (default `max-h-[calc(100dvh-4rem)]`), so a long table scrolls within itself before the page does.
- Expanded rows appear with no height animation (the motion system says table rows never animate height); the chevron rotates.
- Clearing Model/Endpoint Gaps doesn't ask: ticket 21 rules it not destructive (Undo), although this ticket's line lists "clear".
- `ui/Table.tsx` stays: other pages still use it until 07–09 move off it, and the last of them should delete it.
