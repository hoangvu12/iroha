# 09: Requests feed on DataTable, live with infinite scroll

**What to build:** Move the Requests feed (`pages/requests/Feed.tsx`) onto ticket 06's DataTable in infinite mode: new Requests keep arriving at the top live (without moving the row under the pointer or the reader's scroll position; when scrolled down, show an "N new" pill that jumps to the top), and older Requests load as you scroll, using the API's own paging. Keep the URL state (`url-state.ts`), filters, menus and keyboard navigation between rows it has today. Numbered pages remain available as a DataTable option in case the Owner prefers them.

**Destructive actions (Owner, 2026-11-19):** row and bulk actions that delete, remove, revoke or clear use the danger tone and confirm component from ticket 21 (`docs/agents/architecture.md`, "UI ticket 21"); if 21 is not merged when you start, keep those actions behind one prop so its component drops in.

**Blocked by:** 06

**Status:** open

Spec story: 7.

- [ ] Live rows insert without jumping the view; "N new" pill when scrolled
- [ ] Scrolling to the end loads older Requests until there are none
- [ ] Filters and the open Request survive reload (URL)
