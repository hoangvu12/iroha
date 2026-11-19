# 31: See how Failure Rules decide

**What to build:** The Owner asked (2026-11-20) whether the Failure Rules can be visualised. Today a Provider's Rules tab (`pages/providers/Rules.tsx`) is a table: name, Status, Body contains, Upstream Key effect, Request effect, Hits today, Source. The rules are tried in order and the first match decides, which the table doesn't show.

Add a visual view of the same rules (a "Table / Flow" view choice on the tab, remembered per browser, or the flow above the table; decide from screenshots):

- A failure enters at the top and falls through the rules in order. Each rule is a step showing what it matches (status codes, body text) and, on its "match" branch, what happens to the Upstream Key (cool for N, invalid, Model Gap, nothing) and to the Request (retry elsewhere, return the error). Built-in and the Owner's rules are told apart; a disabled rule is shown skipped; the Owner's version of a built-in rule shows it replaces it.
- Today's hits show on each rule (e.g. a bar or count), so the Owner sees which rules actually fire.
- If the API offers a replay (`Replay` in `pages/providers/api.ts`), let the Owner enter a status and body and highlight the path that failure takes through the rules (which rule matches, what happens). If it doesn't, say whether one is worth adding; don't add a server feature without need.
- Clicking a rule opens it for editing as the table does. Use the `ui/Canvas` or plain layout as fits; check the route view (`pages/requests/RouteView.tsx`, `PoolRoute.tsx`) for a look the app already has for flows, and match it.
- Phone width: a vertical list that still reads as a flow.

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20. Ticket 27 may move the rule edit dialog into a sheet at the same time; keep to the view.

- [x] Flow view of the rules in order, with matches, effects, source, disabled and hits; tests incl. agent test
- [x] Try-a-failure path highlight if the API supports it (or the reason it isn't there)
- [x] Checked in headless Chrome, light, dark and phone width

## Comments

**Built.** A "View: Table | Flow" choice on the Rules tab, remembered per browser (`iroha:rules:view`, Table by default so the tab opens as before). Decided from the screenshots: a view choice rather than the flow above the table, since with 20+ built-in rules the flow is long and the table above would push it off screen. Flow (`pages/providers/RulesFlow.tsx`) draws the Provider's rules as the path a failed Attempt takes through `Set.Classify`: Start ("A failed Attempt on <handle>"), the label "Tried in order; the first rule that matches decides", one numbered step per rule in the API's order, then End with the engine's own fallback (no response or 5xx: try the next key; anything else: return the error to the Caller). Each step shows what it matches in words ("429 or 5xx and code Throttling.RateQuota and body has "quota"": any of a list, all of the conditions), Built-in / Custom / "Replaces built-in" (with "Built-in did: cool the key for this model, 60 s", so an override that only changes the time still shows the change), a scope note for rules tried early ("only dashscope", "on aliyuncs.com"), today's hits as a count and a bar against the busiest rule, the On switch, and a "matches" branch to what happens to the Upstream Key (Key State colour) and the Request. A switched-off rule is dashed, "Off, skipped", with a dashed "skipped" branch and no arrow. Clicking a step opens the same dialog as a table row (built-in: Change; Owner's: Edit). Look: the route view's connector, tag and icon tile (exported from `PoolRoute.tsx`) on its dotted ground; plain layout, not the Canvas, because the list scrolls better with the page than panned. Below about 940 px of room (phones, tablets, a narrow window) each step stacks: the effect and hits sit inside the card under "If it matches" and the conditions wrap.

**Try a failure: not built.** The API has nothing that classifies a failure the Owner types: `Replay` (dry runs) only re-reads the last week's stored Attempts. Matching in the browser would drift from the engine (errors inside a 2xx read as the status they stand for, codes read from six JSON fields, the body read by its error fields only, SSE bodies by their first payload, host scopes), so it would sometimes highlight the wrong rule. It is worth adding as its own small ticket: `POST /api/rules/classify {provider, status, body, headers}` returning `Set.Classify`'s decision (rule, outcome, reason, cooling) for the Provider's compiled rules; the Flow view would then highlight the path down to that step and its branch. No server change made here.

**Test-first** (the `tdd` skill): each behaviour got a failing test in `Rules.test.tsx` first (Flow lists the steps in order and is remembered; matches and effects, override, skipped, hits, End; clicking opens the dialog; the stacked step; an agent switching to Flow with `setValue` and pressing a step). `npm --prefix web run build` passes; web tests all pass (see the finishing report for counts). Note: `requests/Feed.test.tsx`'s "numbered pages" test hit its 15 s timeout once on this loaded machine; it passes alone with a longer timeout and isn't touched here.

**Browser checks** (headless Chrome, seeded dashscope with Owner rules, an override, a switched-off built-in and failures that hit five rules): light, dark, phone (light and dark), 820 px (stacked, no sideways scroll), 1100 px and 2560 px, and the dialog opened from a step. Screenshots, plan and seed: `iroha-v2-notes/v2-ui/shots/31/`.

**Motion**: none added beyond the route view's card hover (border colour, `duration-hover`); the view switch swaps at once and the segmented indicator slides as everywhere.
