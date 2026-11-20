# 33: Models and Failure Rules open in sheets too

**What to build:** The Owner asked (2026-11-20, ticket 27) that record details show consistently in sheets, not dialogs. Ticket 27 moved Upstream Keys and Endpoints and deferred three (see its Comments' audit table):

1. **Model sheet.** `ModelDialog` (`pages/providers/Models.tsx`, "Model details") becomes a `model` sheet kind (`sheet=model:<provider>/<model>`): what the dialog shows and does today, plus links to the Provider and the Pools that use it, and Test in Chat (ticket 22's `{ kind: "model" }` target). Ticket 11 said models weren't records with their own sheet; this reverses it (Owner, 2026-11-20). Add a Go route to fetch one model if the sheet needs it (testkit test, served skill and OpenAPI in step), or derive it from the Provider's models query if that's cheap and correct; say which. Model names in other places (Requests, Pool members, Gateway Key scopes) link to the sheet through `RecordLink` where it fits.
2. **Failure Rule sheet.** Editing an existing rule (`RuleDialog` with a rule, `pages/providers/Rules.tsx`) opens a `rule` sheet (`sheet=rule:<provider>/<rule>`): the rule in words as the Flow view shows it (ticket 31's `RulesFlow.tsx`), today's hits, then Edit in the sheet (as EndpointSheet does, ticket 27), and Restore built-in / Delete with the ticket 21 confirm. Both the table rows and the Flow steps open it. Add stays a dialog.
3. **Gateway Key access.** Decide whether the Gateway Key sheet should edit access in place (ticket 27 kept `AccessDialog` on the full Gateway Key page because a sheet over its own page is odd); do it on the sheet if it fits, keep the page's dialog otherwise, and say why.

Follow the sheet stack's conventions (tickets 10, 15, 27: backdrop, motion, URL, focus, `useChatActions`) and keep the deep links working (old URLs that opened the dialogs redirect).

**Blocked by:** 30 (bulk edit changes the Models table at the same time)

**Status:** done

Owner request, 2026-11-20 (follow-up of ticket 27).

- [x] Model details open in a `model` sheet; model names link to it where they fit; tests incl. agent test
- [x] Editing a Failure Rule opens a `rule` sheet from table and Flow; tests
- [x] Gateway Key access decided and done; reason in Comments
- [x] Checked in headless Chrome, light, dark and phone width

## Comments

**Built** (agent/ui33). `docs/agents/architecture.md` "UI ticket 33" has the details.

- **Model sheet** (`sheets/records/ModelSheet.tsx`, `sheet=model:<provider>/<model>`; a model ID keeps its slashes). **I added a Go route** instead of deriving the model from the list query. The new route is `GET /api/providers/{provider}/models/{model...}` (`internal/models/routes.go`): it returns one entry by ID, takes slashes as is or escaped, and answers 404 with a hint when the list doesn't hold the model. Its test is `TestOneModelIsReadByItsID`, and it is in the served skill (`27_models.md`). OpenAPI is generated from the routes, so it carries the route with no file to update.
  - The list query was not "cheap and correct": `q` is a substring search, and the list is paged and capped, so finding one ID in it would need exact-match filtering over pages.
  - The sheet has everything `ModelDialog` had: state, details with where each comes from, editing the overrides, Hide/Show, Pin/Unpin and Remove from the list…. It adds a Provider link, the Model Pools using it, Model Gaps with their keys as links and Clear all, and Test in Chat (`{kind: "model"}`).
  - A model the list doesn't hold opens as "No model X on P" with "Add X to P's list".
  - The Models tab's row opens the sheet. "Details…" opens it on its fields (`startEditing`, as on EndpointSheet). `ModelDialog` is gone.
- **Model links** (`rec.model`) are on:
  - the model sent in a Request's Details, an Attempt's facts and the Route view's Attempt panel;
  - the feed's model cell, for a Request asked of a Provider directly (by `wire_model`; a Pool name still opens the Pool);
  - Pool members (table, phone line, Pool sheet);
  - an Upstream Key's Model Gaps;
  - a Gateway Key's narrowed models (`ScopeModels`, on the sheet and the key page).
- **Failure Rule sheet** (`sheets/records/RuleSheet.tsx`, `sheet=rule:<provider>/<rule>`). It needs no new route: it reads `GET /api/rules?provider=` (`useRules`), the only call that has the rule's order and its hits on that Provider.
  - The sheet shows the rule as a Flow step (`RuleStep`, exported from `RulesFlow.tsx`), Facts (hits today, last hit, applies to, order, what the built-in did, description) and the On switch.
  - Edit (or "Change" for a built-in) swaps in the form in place (`RuleFormFields`, shared with Add), with "Check against last week" and "Save rule".
  - The Owner's rules also get "Restore the built-in X…" or "Delete X…", each with ticket 21's confirm. Delete closes the sheet and toasts; Restore stays in the sheet and says so.
  - Table rows, Flow steps and the row menu's "Edit…" open it. Add stays a dialog (`AddRuleDialog`).
- **Gateway Key access: edited in the sheet.** The Gateway Key sheet has "Edit access". It swaps the Access list for the same `ScopeEditor` the page's dialog uses, with Cancel and "Save access", and the result shows in the sheet with Undo. A revoked key has no Edit access.
  - Why: a sheet is where the Owner looks at a key from Requests, Audit Entries or a Pool. Changing what the key may use is the commonest change from there, and editing in place matches Endpoint, Upstream Key, Model and Rule.
  - The key's own page keeps `AccessDialog`, for ticket 27's reason: opening the key's sheet over its own page would be odd.
- **Old URLs:** none to redirect. The Model and Rule dialogs were React state, never in the URL.

**Test-first.** The new tests were written first by hand and run red before the code; the `tdd` skill was not invoked. They cover:
- the Go route;
- the `records.test.ts` codec for `model`/`rule`;
- `ModelSheet.test.tsx` (9), `RuleSheet.test.tsx` (8) and `GatewayKeySheet.test.tsx` (5), each with an agent test;
- the model links in `Links.test.tsx`;
- the updated `Models.test.tsx` and `Rules.test.tsx`, which now assert sheet URLs.

One exception: the feed model-cell test in `FeedSheets.test.tsx` was added after its code and passed first time. The browser check found one bug: "Named by" said "you (added by hand)" for a model that is neither discovered nor added (an entry the Owner gave details only). The old dialog had the same flaw. I fixed it test-first ("Nobody: only your details for it are kept").

**Browser check:** headless Chrome over CDP on a seeded testkit server (`ui33seed.exe`, seed not committed). Shots are in `iroha-v2-notes/v2-ui/shots/33/` (`plan.json`), in light, dark, and at 390 px light and dark:
- the Model sheet: listed, hidden, slash ID, not listed, Edit details, and opened from a table row;
- the Rule sheet: custom, replaces built-in, built-in, Edit, and opened from a table row and from a Flow step (the URL became `sheet=rule:dashscope/...` both ways);
- the Gateway Key sheet with Edit access;
- the key page's Access with model links;
- a Request's "Model sent" link.

The Model sheet shots predate the Named-by fix, so they still show the old wording for qwen3-max.

**Deferred / notes:**
- The Failure Rule an Attempt matched is still text. `rec.rule(a.provider, a.rule)` would fit; a rule deleted since would open as "No Failure Rule".
- Cooling models on an Upstream Key are still text: `CoolingRow` is shared with the Keys tab.
- DataTable is untouched (ticket 26).
