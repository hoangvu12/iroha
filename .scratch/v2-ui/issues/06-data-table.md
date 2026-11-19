# 06: Shared DataTable, proven on the Upstream Keys table

**What to build:** One `DataTable` component in `web/src/ui/`, replacing `web/src/ui/Table.tsx`: a semantic `<table>` driven by TanStack Table (`@tanstack/react-table`, headless), with UI SDK parts for its controls. Features, each switched on by the page: column definitions with cell renderers; sorting by clickable headers (`aria-sort`); a search box and column filters (client-side, or passed to the server when the page's API pages itself); row selection with a select-all checkbox and a bulk-action bar that slides in while rows are selected; a row-actions Menu; clickable rows (opening a sheet later, in ticket 10); sticky header inside a Scroll Area; empty, no-results and error states; a Skullet skeleton measured from a sample row (ticket 02's pattern); and pagination with UI SDK Pagination and a page-size Select, remembered per table in `localStorage` (wrapped in try/catch). It also supports an "infinite" mode (load more on scroll) for ticket 09. Build it by moving the Upstream Keys table (`web/src/pages/providers/Keys.tsx`, the Owner's most-used table) onto it with every feature it has today (bulk actions, Key States, gaps, Test, restrict) and nothing lost.

**Blocked by:** 01, 02, 03

**Status:** open

Spec stories: 5, 6.

- [ ] Keys table on DataTable with all of today's actions; pages of 25/50/100, choice remembered
- [ ] Keyboard: sort, select, open row actions and page without a mouse; agent test from the skill's agent-ready reference
- [ ] Usage notes for DataTable in `docs/agents/architecture.md` so tickets 07–09 follow one pattern
