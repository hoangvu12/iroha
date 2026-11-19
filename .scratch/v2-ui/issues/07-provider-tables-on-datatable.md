# 07: Providers and Pools tables on DataTable

**What to build:** Move the Providers list (`pages/providers/List.tsx`), Endpoints, Models, Rules and Pool Members tables onto ticket 06's DataTable, with numbered pages, sorting and search where the data needs it, and the actions each has today (Models: hide/show/add, filters visible/discovered/added/hidden/gaps; Rules: enable/disable, override, delete; Pool Members: order, enable). Pool Members keeps reordering (UI SDK's skill points at `createReorder` for drag to reorder). Same features and look as the Keys table.

**Destructive actions (Owner, 2026-11-19):** row and bulk actions that delete, remove, revoke or clear use the danger tone and confirm component from ticket 21 (`docs/agents/architecture.md`, "UI ticket 21"); if 21 is not merged when you start, keep those actions behind one prop so its component drops in.

**Blocked by:** 06

**Status:** done

Spec stories: 5, 6.

- [x] Five tables on DataTable; nothing they did before is lost
- [x] Models table pages through thousands of models without lag

## Comments

**What was built.**
- Every table below is a `DataTable`: the Providers list and the Model Pools table on /providers, Endpoints, Models, Rules and Pool Members. Each has a phone row, a skeleton sample and Glossary names.
- **Providers and Pools.** Sortable columns. The default order is archived last, then Requests today, then name. `?q=` searches. A row opens its page. The hover "Test in Chat" button is kept.
- **Endpoints.** Name sorts. Edit, Copy URL, and a danger Delete… that asks first, all in the row menu.
- **Rules.** Kept in the order they're tried, so no sorting. `?q=` searches. The enable switch, override and Delete/Restore built-in all go through `useConfirm`.
- **Models.**
  - Server paging with numbered pages and a remembered size (25, 50 or 100). Tested against 2400 models.
  - `?q=` and `?filter=` (All, Listed, Discovered, Added, Hidden, With Model Gaps) are passed to the server, with counts shown on the filters.
  - Bulk Hide/Show is one `models/bulk` call; its result shows in the bar. Selection spans pages.
  - Add, remove (asks first), unpin and Test in Chat are kept.
- **Pool Members.** A new `ui/RowOrder.tsx` on `ui/reorder-primitive.ts` (`createReorder`) handles reordering. Drag handles work by keyboard (Space, arrows, Home/End, Escape) and by pointer. The save message names the member that moved. Move up/down, the enable switch, Test in Chat, Open, and a danger Remove… that asks first are kept.
- **Changes to `ui/DataTable.tsx`.** Both are small and backwards compatible.
  - A `phoneActions(row)` prop keeps a control (a Switch, a menu) on a phone row that opens on a tap. It is tested in `DataTable.test.tsx`.
  - The footer's pager group wraps on narrow screens. Without this, Models on a phone scrolled sideways.
- Architecture notes are under "UI ticket 07".

**Test-first.** Each page got its tests first, in vertical slices: List, Endpoints, Models, Rules and PoolMembers `.test.tsx`, plus the `phoneActions` test. Each test was red before its code. The seams came from architecture.md "UI ticket 06" (a page tests its own wiring: URL state, API calls, confirms, agent names), since no one could confirm them interactively. Web build passes; tests 205/205 (41 files) before the merge with v2-ui.

**Browser checks.** Run against a seeded Iroha (320 dashscope models, 6 Providers, 2 Pools) in light, dark and phone (390 px) widths. Screenshots are in `iroha-v2-notes/v2-ui/shots/07/`.
- No page scrolls sideways on a phone (`scrollWidth` 390 each).
- Keyboard pick-up tints the row and keeps focus on the handle.
- A pointer drag saved the new order to the server.
- The Delete confirm, row menus and page 3 of Models all render.

**Notes.**
- Providers and Pools rows keep their hover "Test in Chat" button rather than gaining a ⋯ menu; the row itself opens the page.
- Pool Members aren't paged, so a drag reaches every place.
- Models columns don't sort, because the server sorts by model.
- The member menu is now "More for <provider> (<model>)" instead of "More for member N".
- Docs gap in UI SDK: a slot prop of kind `"key"` needs `api.internal.keyOf`, which the React adapter doesn't provide, so the handle uses `"string"`. Finding this meant reading `reorder.js` in the package's dist, which the skill advises against.
- `ui/Table.tsx` is left for the orchestrator to delete.
