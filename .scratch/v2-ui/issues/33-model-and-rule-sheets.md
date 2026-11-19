# 33: Models and Failure Rules open in sheets too

**What to build:** The Owner asked (2026-11-20, ticket 27) that record details show consistently in sheets, not dialogs. Ticket 27 moved Upstream Keys and Endpoints and deferred three (see its Comments' audit table):

1. **Model sheet.** `ModelDialog` (`pages/providers/Models.tsx`, "Model details") becomes a `model` sheet kind (`sheet=model:<provider>/<model>`): what the dialog shows and does today, plus links to the Provider and the Pools that use it, and Test in Chat (ticket 22's `{ kind: "model" }` target). Ticket 11 said models weren't records with their own sheet; this reverses it (Owner, 2026-11-20). Add a Go route to fetch one model if the sheet needs it (testkit test, served skill and OpenAPI in step), or derive it from the Provider's models query if that's cheap and correct; say which. Model names in other places (Requests, Pool members, Gateway Key scopes) link to the sheet through `RecordLink` where it fits.
2. **Failure Rule sheet.** Editing an existing rule (`RuleDialog` with a rule, `pages/providers/Rules.tsx`) opens a `rule` sheet (`sheet=rule:<provider>/<rule>`): the rule in words as the Flow view shows it (ticket 31's `RulesFlow.tsx`), today's hits, then Edit in the sheet (as EndpointSheet does, ticket 27), and Restore built-in / Delete with the ticket 21 confirm. Both the table rows and the Flow steps open it. Add stays a dialog.
3. **Gateway Key access.** Decide whether the Gateway Key sheet should edit access in place (ticket 27 kept `AccessDialog` on the full Gateway Key page because a sheet over its own page is odd); do it on the sheet if it fits, keep the page's dialog otherwise, and say why.

Follow the sheet stack's conventions (tickets 10, 15, 27: backdrop, motion, URL, focus, `useChatActions`) and keep the deep links working (old URLs that opened the dialogs redirect).

**Blocked by:** 30 (bulk edit changes the Models table at the same time)

**Status:** open

Owner request, 2026-11-20 (follow-up of ticket 27).

- [ ] Model details open in a `model` sheet; model names link to it where they fit; tests incl. agent test
- [ ] Editing a Failure Rule opens a `rule` sheet from table and Flow; tests
- [ ] Gateway Key access decided and done; reason in Comments
- [ ] Checked in headless Chrome, light, dark and phone width
