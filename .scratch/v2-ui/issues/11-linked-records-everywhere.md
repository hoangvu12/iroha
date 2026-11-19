# 11: Every record reference opens its sheet

**What to build:** Everywhere the UI names another record, make the name a link that opens ticket 10's sheet for it (and still works as a normal link with a middle click or Ctrl/Cmd-click, to the full page): Requests feed cells and the Request sheet (Provider, Endpoint, Upstream Key, Gateway Key, Pool, model), Attempts, Audit Entries (the changed record), Pool Members, Gateway Key scopes (Providers and models), Upstream Keys' Endpoints and gaps, route views and route preview nodes, the chat panel's reply details (serving key and Endpoint). One shared `RecordLink` component.

**Blocked by:** 07, 08, 09, 10

**Status:** done

Spec story: 13.

- [x] Every reference listed above is a `RecordLink`; none is plain text
- [x] Middle click and Ctrl/Cmd-click open the full page in a new tab

## Comments

**Built** (test-first with the `tdd` skill: one failing test per place, then the link; seams were the rendered pages inside the sheet harness `sheets/test-iroha.tsx`, asserting each link's href and that a click opens the sheet):
- Requests feed: Caller (its Gateway Key), the model when it names a Pool, Provider, key. The feed's "Open Request" button now only goes in a plain-text column, so no link sits in a button.
- Request sheet: Details shows the Gateway Key's **name** (the Caller name it had when it called), linked by its ID; Attempts link each card's key and the Provider, Endpoint and Upstream Key (`AttemptTarget`, shared with the Route view).
- Route view: the Attempt cards' keys and the Start card's Pool are links on the canvas (an overlay button selects the card); the Start panel's Gateway Key (name) and Model Pool, the Attempt panel's Provider, Endpoint and key.
- Pool Route preview: each member card's Provider; the member panel's Provider (title), Endpoints, skipped and ready keys (they went to the Keys page before). Pool Members: Provider (was a link to its page) and the Gateway Keys that can use the Pool.
- Gateway Key page: Access lists Providers and Pools as links.
- Audit Entries: the changed record (`changedRecord` maps resource and name to a sheet; gaps open their key, several keys of one Provider open the Provider), and each record in an opened entry.
- Upstream Key dialog: allowed and worked-on Endpoints, Endpoint Gaps, "Open the Request" (now its sheet). New `RecordLink drop={["key"]}`: the link leaves the modal dialog for the sheet, and Back or closing the sheet reopens the dialog.
- Chat reply Details: serving key and Endpoint.
- Middle/Ctrl/⌘-click: every one is a `RecordLink`, a real `<a href>` with the sheet in the URL (asserted per place).

**Not links, on purpose**: model names (no model record or sheet, except a Pool's name); Failure Rules, Admin Tokens, settings, Owner sessions (no sheet); the Requests feed's phone row (the whole row is one button: a link can't sit in it; the Request sheet it opens has the links); the Gateway Keys list's Access column (counts, no names); the Keys table's Gaps pill (the key's dialog and sheet list them linked). No Go change was needed: the Gateway Key's name is the Request's `caller.name`.

**Browser checks** (headless Chrome, seeded testkit): light, dark and 390 px, in `iroha-v2-notes/v2-ui/shots/11/` (plan.json there): feed links, a feed key opening its sheet, Details with the key's name, Attempts, Route view and a card's key opening a sheet over it, Pool Route, Pool Members, Gateway Key Access, Audit Entries, the Key dialog and its round trip to an Endpoint sheet and Back, phone Members, Attempts and Audit Entries (no sideways scroll).

