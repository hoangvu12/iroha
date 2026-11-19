# 31: See how Failure Rules decide

**What to build:** The Owner asked (2026-11-20) whether the Failure Rules can be visualised. Today a Provider's Rules tab (`pages/providers/Rules.tsx`) is a table: name, Status, Body contains, Upstream Key effect, Request effect, Hits today, Source. The rules are tried in order and the first match decides, which the table doesn't show.

Add a visual view of the same rules (a "Table / Flow" view choice on the tab, remembered per browser, or the flow above the table; decide from screenshots):

- A failure enters at the top and falls through the rules in order. Each rule is a step showing what it matches (status codes, body text) and, on its "match" branch, what happens to the Upstream Key (cool for N, invalid, Model Gap, nothing) and to the Request (retry elsewhere, return the error). Built-in and the Owner's rules are told apart; a disabled rule is shown skipped; the Owner's version of a built-in rule shows it replaces it.
- Today's hits show on each rule (e.g. a bar or count), so the Owner sees which rules actually fire.
- If the API offers a replay (`Replay` in `pages/providers/api.ts`), let the Owner enter a status and body and highlight the path that failure takes through the rules (which rule matches, what happens). If it doesn't, say whether one is worth adding; don't add a server feature without need.
- Clicking a rule opens it for editing as the table does. Use the `ui/Canvas` or plain layout as fits; check the route view (`pages/requests/RouteView.tsx`, `PoolRoute.tsx`) for a look the app already has for flows, and match it.
- Phone width: a vertical list that still reads as a flow.

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20. Ticket 27 may move the rule edit dialog into a sheet at the same time; keep to the view.

- [ ] Flow view of the rules in order, with matches, effects, source, disabled and hits; tests incl. agent test
- [ ] Try-a-failure path highlight if the API supports it (or the reason it isn't there)
- [ ] Checked in headless Chrome, light, dark and phone width
