# 30: Structured output and `search_result` blocks across Shapes

**What to build:** Two translation losses found by ticket 26 (both in `internal/translate`, through codec hooks; RelayKit maps neither):

1. Structured output is silently dropped between Chat and Anthropic: Chat `response_format` (`json_schema`, `json_object`) is not mapped to Anthropic `output_config.format`, and Anthropic `output_config.format` / `output_format` is not mapped to `response_format` (catalog REQ-45, REQ-59). Carry it both ways (`noteRequest` keeps the Caller's format, the request fix-up writes the target's: OpenAI needs `json_schema.name`; Anthropic accepts a subset of JSON Schema). Decide whether schema keywords the target cannot take are stripped or refused with 400 `untranslatable_request`. Check Responses (`text.format`) and Gemini (`responseSchema`) on the same pass.
2. An Anthropic request holding a `search_result` block (top level or inside `tool_result`) cannot be decoded into RelayKit's request DTO (its `source` is a string there), so toward any other Shape the Caller gets 400 `untranslatable_request` (catalog REQ-57: v1 dropped the block). Rewrite the raw request before decoding: either drop the block like v1 or turn its content into text (keeps RAG context; preferred unless it breaks citations).

**Blocked by:** none

**Status:** done

- [x] Golden cases both ways (Chat ↔ Anthropic) with a JSON schema, whole and streamed
- [x] A `search_result` block (top level and in a `tool_result`) toward Chat no longer refuses the Request; test asserts what reaches the upstream
- [x] `.scratch/v2-gateway/conformance.md` rows REQ-45, REQ-57, REQ-59 updated

## Comments

- Built `translate/format.go`: codec hooks `readFormat` (Caller) and `writeFormat` (Endpoint) carry a JSON schema or JSON mode between every pair of Shapes, not only Chat ↔ Anthropic (RelayKit also dropped it from Gemini and to/from Anthropic for Responses). Chat, Responses and Anthropic Endpoints get Iroha's own format with the schema's properties in the Caller's order (RelayKit's went through a map and came out sorted, which changes the order models fill fields in). Gemini Endpoints keep RelayKit's `responseSchema` when it wrote one; otherwise `responseJsonSchema`. A Gemini Caller's `responseSchema` (OpenAPI types, `nullable`, `propertyOrdering`) is converted to JSON Schema.
- Decision: keywords Anthropic cannot take are stripped, not refused: moved into the description as Anthropic's SDKs do, every object gets `additionalProperties: false`, `oneOf` becomes `anyOf`; a `schema_keyword_moved` diagnostic notes it. `json_object` toward Anthropic is dropped with an `unsupported_response_format` diagnostic (no JSON mode there). A schema toward OpenAI with no name is named `response`; no `strict` is invented.
- `search_result` blocks become text ("Search result: <title>\nSource: <source>\n\n<content>") via a new codec hook `rewrite` on the raw body (only `messages` re-encoded). Citations of search results exist only in Anthropic answers, so nothing is lost on other Shapes.
- Not done: tool parameter schemas still reach Endpoints with keys sorted (the general `toMap` re-encoding); only the structured-output schema keeps its order.
