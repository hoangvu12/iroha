# 07: Providers and Pools tables on DataTable

**What to build:** Move the Providers list (`pages/providers/List.tsx`), Endpoints, Models, Rules and Pool Members tables onto ticket 06's DataTable, with numbered pages, sorting and search where the data needs it, and the actions each has today (Models: hide/show/add, filters visible/discovered/added/hidden/gaps; Rules: enable/disable, override, delete; Pool Members: order, enable). Pool Members keeps reordering (UI SDK's skill points at `createReorder` for drag to reorder). Same features and look as the Keys table.

**Destructive actions (Owner, 2026-11-19):** row and bulk actions that delete, remove, revoke or clear use the danger tone and confirm component from ticket 21 (`docs/agents/architecture.md`, "UI ticket 21"); if 21 is not merged when you start, keep those actions behind one prop so its component drops in.

**Blocked by:** 06

**Status:** open

Spec stories: 5, 6.

- [ ] Five tables on DataTable; nothing they did before is lost
- [ ] Models table pages through thousands of models without lag
