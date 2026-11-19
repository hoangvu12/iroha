# 29: More test tools in the chat, chosen in a popover

**What to build:** Today the test chat's composer has a "Tools" toggle (`pages/chat/ChatPanel.tsx:254-264`) that offers one made-up tool, `get_weather(city)`, and checks the model's call (`tool_check`, `internal/testchat`, `internal/gateway/testrun.go`, skill `31_test_chat.md`). The Owner wants (2026-11-20):

1. **More tools.** Several made-up tools the model can call, each answered by Iroha with a plausible result, so the Owner can test tool calling more fully. Not a copy of OpenRouter's list; for example: `get_weather(city)` (today's), `get_time(timezone)` (real current time), `calculate(expression)` (really computes), `web_search(query)` (made-up results), `fetch_url(url)` (made-up page text, nothing fetched), `lookup_order(order_id)` (made-up record with nested fields). Each has a name, a one-line description and a JSON schema. Works in every Shape the test chat supports. The tool check verdict covers whichever offered tool the model called (name, arguments valid against its schema), and multi-turn tool calls keep working.
2. **API.** `POST /api/test` takes the chosen tools (e.g. `tools: ["get_weather", "calculate"]`); `tool_check: true` keeps working as "get_weather only" so old callers and the snippet endpoint don't break. A `GET` lists the available tools (name, description) for the popover, or the UI keeps the list in step with a test. Served skill and OpenAPI in step; Go tests for each tool's answer and the check.
3. **Popover.** The composer's tools button opens a popover (UI SDK, `ui/popup.ts` motion) like the reference screenshot the Owner shared (OpenRouter's "Server tools" panel): a header with "All on" / "All off", then one row per tool with its icon, name, description and a Switch. The button shows a wrench and the number of active tools as a small badge, no "Tools" text; with none active, just the wrench (accessible name "Tools, 2 on"). Choices persist with the chat settings as `toolCheck` does today. The "Call a tool" starter chip turns tools on if none are.
4. Snippets (`GET /api/test/snippets`) include the chosen tools.

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20. Ticket 23 removes notes from the snippet dialog at the same time; don't touch `SnippetDialog.tsx`.

- [ ] At least five tools, each answered by Iroha, checked in every Shape; Go tests
- [ ] API takes the chosen tools, `tool_check` still works, skill and OpenAPI updated
- [ ] Popover with All on/All off and a Switch per tool; button shows the count; tests incl. agent test
- [ ] Checked in headless Chrome, light, dark and phone width (a real tool call against the testkit's fake Provider)
