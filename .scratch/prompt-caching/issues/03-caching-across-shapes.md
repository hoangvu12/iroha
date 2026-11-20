# 03: Caching survives translation between Shapes

**What to build** (research section 5.3, 1.3; read section 3's notes on CLIProxyAPI's `ensureCacheControl`, OmniRoute's `cacheControlPolicy`, Bifrost's `promptcache.go` and LiteLLM's injection hook):

1. **Cache markers when translating to Anthropic Messages** (from Chat, Responses or Gemini). Where the Endpoint accepts it, Anthropic's top-level automatic `cache_control`; otherwise mark the last tool, the last system block and the last message. Never touch a Caller's own markers (keep OpenRouter-style markers a Chat Caller sends instead of dropping them, with their `ttl`); never more than 4 (drop the earliest); fix TTL order (no 1-hour marker after a 5-minute one). A per-Endpoint setting `cache_markers: on | off`, on by default for Anthropic-shaped Endpoints (Owner, 2026-11-20). Respect each Provider's documented handling (research 2.1: DeepSeek ignores markers, Kimi only top-level, Alibaba up to 4): an Endpoint that rejects markers with a 400 must not break; decide between the setting and a Failure-Rule-style retry without markers, and say why. This also covers v1's REQ-109 (clamp to 4).
2. **Conversation fields across Shapes.** Map `user`/`prompt_cache_key`/`safety_identifier` ↔ Anthropic `metadata.user_id` (Claude Code's JSON form is a session, see ticket 02). On OpenAI-format Endpoints that get no `prompt_cache_key`, send one derived from ticket 02's affinity value (`UUIDv5(provider, model, session)` as CLIProxyAPI does; hashed if over 64 characters; never from a plain user id), gated per Endpoint (`send_prompt_cache_key`, default on for OpenAI-shaped Endpoints, off where a Provider rejects unknown fields).
3. **Anthropic → Chat** keeps the system prompt's marker for Endpoints that honour markers (RelayKit's `OpenRouterDialect` per Endpoint, or move the marker in Iroha's chat `prepareRequest`); strips markers for Endpoints that reject them.
4. **Refuse Gemini `cachedContent` in translation** with 400 `untranslatable_request`, as `previous_response_id` already is (`responses.go:25`), with a clear hint.

Same-Shape passthrough doesn't change. Go tests: golden files per direction (marker injection, Caller markers kept, clamp, TTL order, fields mapped, derived key), gateway tests through testkit's fake Providers, the 400 refusal. Update the served skill (what Iroha adds when translating, how to turn it off) and conformance rows REQ-51/58/93/95/109.

**Blocked by:** 02 (the affinity value for the derived `prompt_cache_key`)

**Status:** open

- [ ] Markers added when translating to Anthropic, Caller markers kept, clamp and TTL order, per-Endpoint setting; Go golden and gateway tests
- [ ] Conversation fields mapped across Shapes; derived `prompt_cache_key` gated per Endpoint; Go tests
- [ ] Anthropic → Chat system marker kept where honoured; Gemini `cachedContent` refused in translation; Go tests
- [ ] Endpoint settings in the UI (Endpoint sheet); skill, OpenAPI, conformance updated; checked in headless Chrome light, dark, phone
