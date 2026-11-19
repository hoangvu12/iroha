# 29: More test tools in the chat, chosen in a popover

**What to build:** Today the test chat's composer has a "Tools" toggle (`pages/chat/ChatPanel.tsx:254-264`) that offers one made-up tool, `get_weather(city)`, and checks the model's call (`tool_check`, `internal/testchat`, `internal/gateway/testrun.go`, skill `31_test_chat.md`). The Owner wants (2026-11-20):

1. **More tools.** Several made-up tools the model can call, each answered by Iroha with a plausible result, so the Owner can test tool calling more fully. Not a copy of OpenRouter's list; for example: `get_weather(city)` (today's), `get_time(timezone)` (real current time), `calculate(expression)` (really computes), `web_search(query)` (made-up results), `fetch_url(url)` (made-up page text, nothing fetched), `lookup_order(order_id)` (made-up record with nested fields). Each has a name, a one-line description and a JSON schema. Works in every Shape the test chat supports. The tool check verdict covers whichever offered tool the model called (name, arguments valid against its schema), and multi-turn tool calls keep working.
2. **API.** `POST /api/test` takes the chosen tools (e.g. `tools: ["get_weather", "calculate"]`); `tool_check: true` keeps working as "get_weather only" so old callers and the snippet endpoint don't break. A `GET` lists the available tools (name, description) for the popover, or the UI keeps the list in step with a test. Served skill and OpenAPI in step; Go tests for each tool's answer and the check.
3. **Popover.** The composer's tools button opens a popover (UI SDK, `ui/popup.ts` motion) like the reference screenshot the Owner shared (OpenRouter's "Server tools" panel): a header with "All on" / "All off", then one row per tool with its icon, name, description and a Switch. The button shows a wrench and the number of active tools as a small badge, no "Tools" text; with none active, just the wrench (accessible name "Tools, 2 on"). Choices persist with the chat settings as `toolCheck` does today. The "Call a tool" starter chip turns tools on if none are.
4. Snippets (`GET /api/test/snippets`) include the chosen tools.

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20. Ticket 23 removes notes from the snippet dialog at the same time; don't touch `SnippetDialog.tsx`.

- [x] At least five tools, each answered by Iroha, checked in every Shape; Go tests
- [x] API takes the chosen tools, `tool_check` still works, skill and OpenAPI updated
- [x] Popover with All on/All off and a Switch per tool; button shows the count; tests incl. agent test
- [x] Checked in headless Chrome, light, dark and phone width (a real tool call against the testkit's fake Provider)

## Comments

**Built.** Six test tools in `internal/testchat/tools.go` (`get_weather`, `get_time`, `calculate`, `web_search`, `fetch_url`, `lookup_order`), each a name, one-line description and JSON schema, answered by Iroha in `answers.go`: `get_time` gives the real time from Iroha's clock in any IANA zone (`time/tzdata` embedded), `calculate` really computes (`+ - * / % ^`, parentheses, `sqrt abs round floor ceil min max`, `pi`, `e`), `web_search`/`fetch_url`/`lookup_order` give plausible made-up results (repeatable for the same argument; the order has nested customer, items, shipping, total). Nothing is fetched.
- API: `POST /api/test` takes `tools: [...]`; `tool_check: true` alone still means `["get_weather"]`; unknown names are `400 unknown_tool`. `GET /api/test/tools` lists them (name, description, parameters). `GET /api/test/snippets?tools=a,b`. The check passes when every call names an offered tool with arguments valid against its schema (required present, types), and reports `calls`. A follow-up turn offers the chosen tools plus any test tool earlier turns called. Skill `31_test_chat.md` and the OpenAPI (route docs) updated.
- UI: the composer's Tools toggle is now a wrench with a count badge (`Tools, 2 on` / `Tools, off`) opening a UI SDK Popover on `popupMotionClass`: header "Test tools" with All on / All off, then icon, name, description and a Switch per tool. `Settings.tools` replaced `toolCheck` (saved chats migrate). The Picker's "Check tool calls" switch was removed (one place for tools). "Call a tool" turns every tool on when none is. A reply keeps following up while the model calls tools (up to 5 Requests, was 2). Tool calls in replies show the tool's icon. `SnippetDialog.tsx` untouched (snippets get `tools` through `useSnippets` in `api.ts`).

**Test-first** (`tdd` skill): the tool-list Go test and `pages/chat/tools.test.tsx` were written red first; the other Go tests (each tool's answer through the follow-up turn, the check in every Shape, schema failures, `tool_check` compatibility, snippets) came in the same slice right after the code, so I mutation-checked them (disabling the schema check makes `TestToolCheckFailsCallsOutsideTheOfferOrAgainstTheSchema` fail). Web: 8 tests incl. the agent test and the popup recipe.

**Browser check** (headless Chrome, testkit seed with the fake OpenAI Chat upstream answering a `get_weather` call then text): light and dark desktop, the side panel, phone 390 px light and dark (no sideways scroll). A real round from an Anthropic Messages chat: "Call a tool" with none on turned all 6 on, the model's call went through Iroha, the follow-up carried Iroha's result, Details shows Tool call Passed and the follow-up Request. An old saved chat with `toolCheck: true` loads as "Tools, 1 on". Screenshots: `iroha-v2-notes/v2-ui/shots/29/`. The phone header's description first truncated; it wraps now.

**Not done**: nothing deferred. `src/pages/requests/Feed.test.tsx` (numbered pages) times out (15 s) in the full parallel web run on this machine and passes alone; it fails the same way on v2-ui (7e223cb) without this ticket, so it is load-related and not this ticket's.