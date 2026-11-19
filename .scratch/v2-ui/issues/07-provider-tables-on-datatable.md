# 07: Providers and Pools tables on DataTable

**What to build:** Move the Providers list (`pages/providers/List.tsx`), Endpoints, Models, Rules and Pool Members tables onto ticket 06's DataTable, with numbered pages, sorting and search where the data needs it, and the actions each has today (Models: hide/show/add, filters visible/discovered/added/hidden/gaps; Rules: enable/disable, override, delete; Pool Members: order, enable). Pool Members keeps reordering (UI SDK's skill points at `createReorder` for drag to reorder). Same features and look as the Keys table.

**Blocked by:** 06

**Status:** open

Spec stories: 5, 6.

- [ ] Five tables on DataTable; nothing they did before is lost
- [ ] Models table pages through thousands of models without lag
