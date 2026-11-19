# 23: Shared test chat panel

**What to build:** Following `design/v2-clean/` (C15–C17): a right-side chat panel available on every page (sidebar item and shortcut C), not modal, expandable to full page, with no tabs; earlier chats in a dropdown by the title. The composer's model button holds the model picker (Pools first, searchable over thousands of models, typed IDs allowed) and the settings: Provider, Upstream Key (any or one), Endpoint, Shape, reasoning level, tool-call check, and "send as" a Gateway Key. Replies stream; under each reply a collapsed details block shows serving key, timings, tokens and the tool-call result; a failed reply shows the Attempt explanation. A snippet for the current settings copies as curl, Python or TypeScript. Test buttons on a Provider, a Model Pool, a key row, a past Request (replay its prompt) and a Gateway Key open the panel filled in. Backed by an admin test API agents can also use; traffic is recorded as "Test", or "Test (as <name>)" when sending as a Gateway Key, which applies that key's scope but never counts as its traffic.

**Blocked by:** 22, 15

**Status:** ready-for-agent

- [ ] Pinning one key or Endpoint sends every Attempt there only
- [ ] Sending as a Gateway Key enforces its scope and records "Test (as <name>)"
- [ ] Snippets run unchanged against Iroha
- [ ] Multi-turn chat streams in all four Shapes; reasoning level is translated
- [ ] Tool-call check reports pass or fail with the raw tool call shown
- [ ] Each entry point fills in the panel as described
