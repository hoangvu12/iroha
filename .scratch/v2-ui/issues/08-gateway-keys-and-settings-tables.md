# 08: Gateway Keys and Settings tables on DataTable

**What to build:** Move the Gateway Keys list (`pages/gateway-keys/List.tsx`), Admin Tokens, Audit Entries and Sign-in sessions tables onto ticket 06's DataTable, with numbered pages, sorting, search and the actions each has today (Audit Entries: revert, filter by resource). The states demo page (`pages/states`) shows DataTable's empty, error and loading states.

**Destructive actions (Owner, 2026-11-19):** row and bulk actions that delete, remove, revoke or clear use the danger tone and confirm component from ticket 21 (`docs/agents/architecture.md`, "UI ticket 21"); if 21 is not merged when you start, keep those actions behind one prop so its component drops in.

**Blocked by:** 06

**Status:** open

Spec stories: 5, 6.

- [ ] Four tables on DataTable; nothing lost
- [ ] States page shows every DataTable state in light and dark
