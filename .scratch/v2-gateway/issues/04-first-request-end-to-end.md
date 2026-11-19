# 04: First Request end to end (OpenAI Chat passthrough)

**What to build:** Through the admin API an agent creates a Provider with one OpenAI Chat Endpoint, adds Upstream Keys, and creates a Gateway Key. A Caller with that Gateway Key sends streamed and non-streamed OpenAI Chat requests to `/providers/<handle>/v1/chat/completions` and gets the upstream answer passed through, with the requested model name echoed. The Request and its Attempt are recorded with caller, route, Shape, model, key, status, timings and token usage (streams included), readable through the admin API.

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] Provider handles are unique, immutable and validated
- [ ] Gateway Keys and Upstream Keys are readable through the API
- [ ] Caller auth accepted via Bearer, `x-api-key` and `api-key`; Caller credentials never reach the upstream
- [ ] Upstream keys chosen round-robin
- [ ] Streams flow chunk by chunk; usage is captured for streams
- [ ] Request and Attempt records readable via the requests API, with route and Shape recorded
- [ ] Unknown or out-of-scope Provider gets the uniform refusal
