# 08: Gateway Keys and Settings tables on DataTable

**What to build:** Move the Gateway Keys list (`pages/gateway-keys/List.tsx`), Admin Tokens, Audit Entries and Sign-in sessions tables onto ticket 06's DataTable, with numbered pages, sorting, search and the actions each has today (Audit Entries: revert, filter by resource). The states demo page (`pages/states`) shows DataTable's empty, error and loading states.

**Destructive actions (Owner, 2026-11-19):** row and bulk actions that delete, remove, revoke or clear use the danger tone and confirm component from ticket 21 (`docs/agents/architecture.md`, "UI ticket 21"); if 21 is not merged when you start, keep those actions behind one prop so its component drops in.

**Blocked by:** 06

**Status:** done

Spec stories: 5, 6.

- [x] Four tables on DataTable; nothing lost
- [x] States page shows every DataTable state in light and dark

## Comments

**Built (UI ticket 08, branch agent/ui08).** Test-first with the `tdd` skill: a failing test per slice (DataTable phone details, then each page), then the code. Seams: DataTable's props for the two additions; each page rendered with a fake `fetch` (as `Keys.test.tsx`).

- **Gateway Keys** (`gateway-keys/List.tsx`) on DataTable: pages, `?q=` search by name or key, `?sort=&dir=` on Name, Access, Last used, Requests 24 h; row menu (Open settings, Copy key, Test as, Revoke…, Delete…); Revoke asks for the name typed and Delete asks, through `useConfirm` (`confirm.tsx` `useKeyQuestions`, shared with the key page's dialogs); row click and the name link ("Open <name>", still a real link) open the key's page; phone two-line rows; empty states for no keys and every key revoked.
- **Revoked Gateway Keys** (ticket-adjustments): its own DataTable under the "Revoked keys" Disclosure (UI SDK Collapsible, was a raw button), newest revoke first, Delete asks; phone rows.
- **Admin Tokens**: sort by Name, Created (default, as the API orders), Last used (stale stays amber); row menu Copy token / Revoke… (name typed); phone rows; the hint moved into the footer with the count.
- **Audit Entries**: DataTable with expandable rows (row click or chevron), numbered pages and the remembered page size, over the API's `before` cursor (page N is read when asked for; footer "1–25 of more than 25 changes" until the last page). URL filters (`q`, `actor`, `resource`) kept, a filter goes back to page 1. Revert stays in the row (in the details on phones) with its in-place result and Undo; reverting a create still asks.
- **Signed-in browsers**: sort by Browser, Signed in (default newest), Last seen, Expires; Sign out… asks through `useConfirm`. Distinct names for agents: "Change password…", "Save the new password", "Sign out this browser", "Sign out <browser>…", "Sign out the other browsers…".
- **States page**: DataTable loading, empty, no results, error, and a full table (sort, bulk bar with Delete… asking, row menu, a danger row, details, pages of 5).
- **DataTable** (small, backwards compatible, tested): phones show expandable rows (chevron at the end, details under the row); a table with `renderExpanded` and no `onRowClick` toggles details on row click.

**Not done, and why.**
- Audit Entries columns don't sort: the API pages by a newest-first cursor and has no order parameter, so sorting one page would lie about the rest; adding one is a backend change outside this pass.
- No search box on Admin Tokens or signed-in browsers: a handful of rows each (story 5: "where the data is long enough to need it").
- Admin Tokens and browsers use `pages` mode, not `none` as ticket 06's note suggests: the pager only shows past 25 rows, so it keeps story 6 without clutter.
- Audit Entries no longer groups rows under day headings (a table has no group rows); the first entry of each day on a page shows the day above its time instead.

**Browser check** (headless Chrome, seeded testkit: 7 active + 2 revoked Gateway Keys, 6 Admin Tokens, 6 browsers, ~70 Audit Entries): light, dark and 390 px phone for each table and /states, menus, the revoke confirm, Audit details, page 2, filtered and no-results views; no sideways scroll at 390 px. Screenshots and plan: `iroha-v2-notes/v2-ui/shots/08/`.