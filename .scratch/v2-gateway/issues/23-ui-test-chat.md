# 23: Shared test chat panel

**What to build:** Following `design/v2-clean/` (C15–C17): a right-side chat panel available on every page (sidebar item and shortcut C), not modal, expandable to full page, with no tabs; earlier chats in a dropdown by the title. The composer's model button holds the model picker (Pools first, searchable over thousands of models, typed IDs allowed) and the settings: Provider, Upstream Key (any or one), Endpoint, Shape, reasoning level, tool-call check, and "send as" a Gateway Key. Replies stream; under each reply a collapsed details block shows serving key, timings, tokens and the tool-call result; a failed reply shows the Attempt explanation. A snippet for the current settings copies as curl, Python or TypeScript. Test buttons on a Provider, a Model Pool, a key row, a past Request (replay its prompt) and a Gateway Key open the panel filled in. Backed by an admin test API agents can also use; traffic is recorded as "Test", or "Test (as <name>)" when sending as a Gateway Key, which applies that key's scope but never counts as its traffic.

**Blocked by:** 22, 15

**Status:** done

- [x] Pinning one key or Endpoint sends every Attempt there only
- [x] Sending as a Gateway Key enforces its scope and records "Test (as <name>)"
- [x] Snippets run unchanged against Iroha
- [x] Multi-turn chat streams in all four Shapes; reasoning level is translated
- [x] Tool-call check reports pass or fail with the raw tool call shown
- [x] Each entry point fills in the panel as described

## Comments

- Implemented on `agent/t23`. Backend: `POST /api/test` (`internal/gateway/testrun.go`) runs the built body through the normal Gateway path (`Gateway.run`), pins filter the route after resolve (a pinned key is tried whatever its Key State), `as` applies the Gateway Key's scope while `caller_kind` stays `test`. `internal/testchat` builds the body per Shape (reasoning: `reasoning_effort` / `reasoning.effort` / Anthropic `thinking` budget / Gemini `thinkingConfig`), checks the tool call, writes snippets, and serves `GET /api/test/models` and `/api/test/snippets`. Agent docs: `internal/api/skill/31_test_chat.md`.
- Tests (`internal/testchat/testchat_test.go`): one per checkbox, plus the failed-test Attempt explanation and model search. `TestSnippetsRunUnchangedAgainstIroha` runs every Shape's curl snippet against testkit, and through a real `sh` + `curl` when both exist (they did here). The Python and TypeScript snippets were not run (SDKs not installed in tests).
- Decision: chats are kept client-side in `localStorage` (`iroha.chats.v1`, newest 30 chats); every turn is also a captured test Request, which is the durable record. Recorded in `docs/agents/architecture.md` ("Ticket 23: test chat").
- Tool-call verdict reaches the UI as a trailing SSE comment (`: iroha-tool-check {json}`) on streams and an `Iroha-Tool-Check` header on JSON answers; the answer itself stays byte for byte the Shape's.
- Checked in headless Chrome (light, dark, phone): each entry point (Provider, Pool, key row, Gateway Key, Replay), streamed reasoning, tool call with follow-up, failed reply with the Attempt list, model search over 400+ models, earlier chats after reload, snippet dialog.
