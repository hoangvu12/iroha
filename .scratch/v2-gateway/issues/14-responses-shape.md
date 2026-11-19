# 14: OpenAI Responses Shape

**What to build:** Callers can use `/v1/responses` (global and provider-scoped) against Endpoints of any supported Shape, and Endpoints speaking Responses can serve Callers of any Shape, streamed and not, with tools, reasoning and usage carried across.

**Blocked by:** 13

**Status:** done

- [x] Golden tests for Responses to and from every other Shape, including stream events
- [x] Passthrough when the Endpoint speaks Responses

## Comments

Built the Responses codec (`internal/translate/responses.go`) and four golden cases with whole answers and streams: Responses → Chat (tools with sanitised names, reasoning, images, history with function calls), Responses → Anthropic (thinking, images, tools), Chat → Responses and Anthropic → Responses (realistic OpenAI event streams with reasoning summaries and function-call deltas). Host work around RelayKit: answers named `resp_<Request ID>`, zero-valued response fields dropped, usage in Responses form (reasoning tokens fixed where RelayKit drops them), whole-stream usage on two-step conversions, `sequence_number` renumbered, the `content_part` events the SDKs need, `store: false` toward Responses Endpoints, `store` dropped toward Chat, empty assistant messages removed. Stateful fields (`previous_response_id`, ...) toward Chat/Anthropic get 400 `untranslatable_request`.

Gateway: `POST /providers/{handle}/v1/responses` (passthrough byte for byte, model echoed in `response` objects of stream events; translation otherwise), Responses `streamShape` (comment keep-alives; failures as `event: error` with a top-level `error` object, then `response.failed`), usage reading, capture reassembly, served skill `22_responses.md`. The testkit's fake Responses stream now sends OpenAI's full event sequence.

Deferred: the global `/v1/responses` route needs ticket 12 (`serveScoped(w, r, shape.OpenAIResponses)`). Gemini pairs: ticket 15's codec was not merged when this finished (see the merge note below if that changed). Built-in Responses tools (web_search, file_search, MCP) are not translated to other Shapes; RelayKit reports what it drops in `Translation.Diagnostics`, which is still not stored (as in 13).
