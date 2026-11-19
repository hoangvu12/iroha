# 11: Every record reference opens its sheet

**What to build:** Everywhere the UI names another record, make the name a link that opens ticket 10's sheet for it (and still works as a normal link with a middle click or Ctrl/Cmd-click, to the full page): Requests feed cells and the Request sheet (Provider, Endpoint, Upstream Key, Gateway Key, Pool, model), Attempts, Audit Entries (the changed record), Pool Members, Gateway Key scopes (Providers and models), Upstream Keys' Endpoints and gaps, route views and route preview nodes, the chat panel's reply details (serving key and Endpoint). One shared `RecordLink` component.

**Blocked by:** 07, 08, 09, 10

**Status:** open

Spec story: 13.

- [ ] Every reference listed above is a `RecordLink`; none is plain text
- [ ] Middle click and Ctrl/Cmd-click open the full page in a new tab
