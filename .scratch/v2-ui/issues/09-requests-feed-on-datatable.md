# 09: Requests feed on DataTable, live with infinite scroll

**What to build:** Move the Requests feed (`pages/requests/Feed.tsx`) onto ticket 06's DataTable in infinite mode: new Requests keep arriving at the top live (without moving the row under the pointer or the reader's scroll position; when scrolled down, show an "N new" pill that jumps to the top), and older Requests load as you scroll, using the API's own paging. Keep the URL state (`url-state.ts`), filters, menus and keyboard navigation between rows it has today. Numbered pages remain available as a DataTable option in case the Owner prefers them.

**Destructive actions (Owner, 2026-11-19):** row and bulk actions that delete, remove, revoke or clear use the danger tone and confirm component from ticket 21 (`docs/agents/architecture.md`, "UI ticket 21"); if 21 is not merged when you start, keep those actions behind one prop so its component drops in.

**Blocked by:** 06

**Status:** done

Spec story: 7.

- [x] Live rows insert without jumping the view; "N new" pill when scrolled
- [x] Scrolling to the end loads older Requests until there are none
- [x] Filters and the open Request survive reload (URL)

## Comments

**Built** (details in architecture.md, "UI ticket 09"):
- The feed is `DataTable id="requests"` in infinite mode. Its columns come from `COLUMNS` and `?hide=` is the table's column visibility. Filters, chips, range, Columns and Filter menus, the Live toggle and stats are unchanged.
- Failed rows have the danger tint. Phones get the same two-line rows. Every row has "Open Request <id>" for the keyboard and agents.
- The open Request (the first sheet, `?sheet=`) is highlighted (`aria-current`) and kept in view while ↑/↓ steps through rows. Stepping onto the last loaded row loads the older ones.
- "Show older Requests" is now load-on-scroll, with a "Load older Requests" button kept for the keyboard. It uses `next_before` until there is none, and the footer says "Showing 200 of 12,840 Requests".
- Live rows: while the reader is scrolled down or pointing at a row, rows arriving on top hold the view still, and an "N new" pill goes back to the top. At the top, with the pointer away, they come in on top as before.
- Numbered pages: set `FEED_PAGING = "pages"`. Those are server pages that load the cursor pages a later page needs.
- No destructive actions: the feed has no delete, remove, revoke or clear action.

**DataTable changes** (small, backwards compatible, tested; tickets 07/08 should merge cleanly):
- New props: `paging.newRowsLabel` (`ui/hold-view.ts`) and `activeRowId`.
- Rows now carry `data-row-id`, and the row container carries `data-rows`.
- A bug fix from ticket 06: body rows were an array of arrays keyed by index, so a row added on top remounted every row. They are now one flat keyed list.
- Load-more observes again after each load, inside the table's scroller, so a short page in a tall view keeps loading.
- For later tickets: refs on elements inside DataTable's `Skeleton` read `null` after the first update, because Skullet replaces them. The hook finds elements under DataTable's root instead.

**Test-first** (tdd skill). This run couldn't ask, so I chose the seams myself:
- DataTable's public props, with row geometry faked in jsdom.
- The feed page against a fake Iroha behind `fetch`.
- An agent test.

Each test was red before its code. The no-remount test was checked red with the old `map`.

New tests:
- `ui/DataTable.test.tsx`: 6.
- `pages/requests/Feed.test.tsx`: 6 new, 2 kept on the new markup.
- `sheets/FeedSheets.test.tsx`: moved to the new row markup.

**Checks:** `npm --prefix web run build` passes; `npm --prefix web test` passes. Browser: headless Chrome against a seeded testkit (260 Requests, one new Request every 3 s), through the built UI and Vite on port 3684. Checked:
- Light, dark and phone 390 px.
- Scrolled down on desktop, the anchor row stayed at the same pixel (310 before and after 3 arrivals) and "3 new" showed; the pill went back to the top and disappeared.
- Phone scrolled, the anchor stayed at -64 and "2 new" showed.
- Scrolling to the end loaded 420 rows and the button went away.
- ↓ in the sheet stepped the highlighted row.
- `?status=failed&range=24h&sheet=…` survived a reload.

Screenshots and plans are in `iroha-v2-notes/v2-ui/shots/09/`.

**Deferred:** Motion of the pill and arriving rows is ticket 18; the flash is unchanged from before. With fewer rows than fill the table's scroller, the scroller can't move, so arrivals push the rows down; the page's own scroll isn't adjusted for that case.
