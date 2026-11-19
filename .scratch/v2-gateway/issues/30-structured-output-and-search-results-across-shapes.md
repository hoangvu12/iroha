# 30: Structured output and `search_result` blocks across Shapes

**What to build:** Two translation losses found by ticket 26 (both in `internal/translate`, through codec hooks; RelayKit maps neither):

1. Structured output is silently dropped between Chat and Anthropic: Chat `response_format` (`json_schema`, `json_object`) is not mapped to Anthropic `output_config.format`, and Anthropic `output_config.format` / `output_format` is not mapped to `response_format` (catalog REQ-45, REQ-59). Carry it both ways (`noteRequest` keeps the Caller's format, the request fix-up writes the target's: OpenAI needs `json_schema.name`; Anthropic accepts a subset of JSON Schema). Decide whether schema keywords the target cannot take are stripped or refused with 400 `untranslatable_request`. Check Responses (`text.format`) and Gemini (`responseSchema`) on the same pass.
2. An Anthropic request holding a `search_result` block (top level or inside `tool_result`) cannot be decoded into RelayKit's request DTO (its `source` is a string there), so toward any other Shape the Caller gets 400 `untranslatable_request` (catalog REQ-57: v1 dropped the block). Rewrite the raw request before decoding: either drop the block like v1 or turn its content into text (keeps RAG context; preferred unless it breaks citations).

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Golden cases both ways (Chat ↔ Anthropic) with a JSON schema, whole and streamed
- [ ] A `search_result` block (top level and in a `tool_result`) toward Chat no longer refuses the Request; test asserts what reaches the upstream
- [ ] `.scratch/v2-gateway/conformance.md` rows REQ-45, REQ-57, REQ-59 updated
