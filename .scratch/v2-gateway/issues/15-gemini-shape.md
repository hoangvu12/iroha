# 15: Gemini Shape

**What to build:** Callers can use Gemini `generateContent` and `streamGenerateContent` (model in the URL path; `x-goog-api-key` header or `key` query parameter accepted) against Endpoints of any supported Shape, and Gemini Endpoints can serve Callers of any Shape, with tools, images, reasoning and usage carried across.

**Blocked by:** 13

**Status:** done

- [x] Golden tests for Gemini to and from every other Shape, streams included
- [x] Gemini Caller auth styles accepted and stripped before forwarding
- [x] Qualified and Pool model names work in the Gemini URL path

## Comments

- Done on `agent/t15`. Codec `internal/translate/gemini.go` (answers to a Gemini Caller go through Chat, `translate/hop.go`, so thought parts and full usage survive); golden pairs with Chat, Anthropic and Responses, both ways, buffered and streamed. Route `POST /providers/{handle}/v1beta/models/{model...}` (`gateway/gemini.go`) with passthrough (model in the upstream URL, `modelVersion` echoed), Google's error envelope, an empty-text chunk as keep-alive, usage (`usage.Reader`) and capture reassembly (`requests/capture_gemini.go`). Caller auth: `x-goog-api-key` and `?key=` in `gatewaykeys.Credential`; upstream URLs are built from the Endpoint and op only, so neither is forwarded (tested).
- Qualified and Pool names: the route takes everything between `models/` and the last colon as the model, slashes included (`readGeminiTarget`), tested on the provider-scoped route. Mounting the global `/v1beta/models/...` route and splitting `handle/model` there is left to ticket 12 (and Pools to 18), which can reuse `readBody`/`readGeminiTarget` unchanged.
- Deferred: Gemini Callers always get server-sent events (as with `?alt=sse`, what the Google SDKs ask for); the JSON-array stream that Gemini sends without `alt=sse` is not offered. `countTokens`, `embedContent` and other methods answer 404 `operation_not_supported`.
