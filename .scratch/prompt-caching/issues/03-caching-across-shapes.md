# 03: Caching survives translation between Shapes

**What to build** (research section 5.3, 1.3; read section 3's notes on CLIProxyAPI's `ensureCacheControl`, OmniRoute's `cacheControlPolicy`, Bifrost's `promptcache.go` and LiteLLM's injection hook):

1. **Cache markers when translating to Anthropic Messages** (from Chat, Responses or Gemini). Where the Endpoint accepts it, Anthropic's top-level automatic `cache_control`; otherwise mark the last tool, the last system block and the last message. Never touch a Caller's own markers (keep OpenRouter-style markers a Chat Caller sends instead of dropping them, with their `ttl`); never more than 4 (drop the earliest); fix TTL order (no 1-hour marker after a 5-minute one). A per-Endpoint setting `cache_markers: on | off`, on by default for Anthropic-shaped Endpoints (Owner, 2026-11-20). Respect each Provider's documented handling (research 2.1: DeepSeek ignores markers, Kimi only top-level, Alibaba up to 4): an Endpoint that rejects markers with a 400 must not break; decide between the setting and a Failure-Rule-style retry without markers, and say why. This also covers v1's REQ-109 (clamp to 4).
2. **Conversation fields across Shapes.** Map `user`/`prompt_cache_key`/`safety_identifier` ↔ Anthropic `metadata.user_id` (Claude Code's JSON form is a session, see ticket 02). On OpenAI-format Endpoints that get no `prompt_cache_key`, send one derived from ticket 02's affinity value (`UUIDv5(provider, model, session)` as CLIProxyAPI does; hashed if over 64 characters; never from a plain user id), gated per Endpoint (`send_prompt_cache_key`, default on for OpenAI-shaped Endpoints, off where a Provider rejects unknown fields).
3. **Anthropic → Chat** keeps the system prompt's marker for Endpoints that honour markers (RelayKit's `OpenRouterDialect` per Endpoint, or move the marker in Iroha's chat `prepareRequest`); strips markers for Endpoints that reject them.
4. **Refuse Gemini `cachedContent` in translation** with 400 `untranslatable_request`, as `previous_response_id` already is (`responses.go:25`), with a clear hint.

Same-Shape passthrough doesn't change. Go tests: golden files per direction (marker injection, Caller markers kept, clamp, TTL order, fields mapped, derived key), gateway tests through testkit's fake Providers, the 400 refusal. Update the served skill (what Iroha adds when translating, how to turn it off) and conformance rows REQ-51/58/93/95/109.

**Blocked by:** 02 (the affinity value for the derived `prompt_cache_key`)

**Status:** done

- [x] Markers added when translating to Anthropic, Caller markers kept, clamp and TTL order, per-Endpoint setting; Go golden and gateway tests
- [x] Conversation fields mapped across Shapes; derived `prompt_cache_key` gated per Endpoint; Go tests
- [x] Anthropic → Chat system marker kept where honoured; Gemini `cachedContent` refused in translation; Go tests
- [x] Endpoint settings in the UI (Endpoint sheet); skill, OpenAPI, conformance updated; checked in headless Chrome light, dark, phone

## Comments

**Built** (architecture.md, "Prompt caching 03"):

- `internal/caching` (new, pure): `For(shape, url, cache_markers, send_prompt_cache_key)` gives what an Endpoint's translated requests get, from its two settings (`""` Iroha's default, `on`, `off`; migration `45_01`) and what each Provider documents, known by host: Anthropic's own API gets the automatic top-level `cache_control`; Kimi/Moonshot one top-level marker only; DeepSeek nothing added (it ignores markers); others the last tool, system block and message. Toward OpenAI Chat, OpenRouter and Alibaba hosts (or `on`) keep the system prompt's markers. The derived `prompt_cache_key` is on by default except on hosts that refuse unknown fields (Google's, Mistral's OpenAI APIs). The Endpoint's read-only `caching` (`markers`, `prompt_cache_key`, `summary`) comes from the same call.
- `internal/translate/cache.go`: the Caller's markers (OpenRouter style, `ttl` kept) are placed on the blocks with the same text; at most 4 (earliest dropped), and a 1 h marker after a 5 min one becomes 5 min. `user` > `safety_identifier` > `prompt_cache_key` → `metadata.user_id`; a plain Anthropic `metadata.user_id` → Chat `user` (Claude Code's JSON and `_session_` forms are sessions and are left out). The derived key is `caching.PromptCacheKey(x.affinityKey(p, model))`: a v5 UUID (36 characters) over ticket 02's affinity value, never from a plain user id, never replacing the Caller's. Gemini `cachedContent` in translation → 400 `untranslatable_request` with a hint.
- Cache writes reach Callers of translated answers through ticket 01's `usage.Reader`: Chat/Responses `cache_write_tokens` in the details, Anthropic `cache_creation_input_tokens` with `input_tokens` the uncached part (REQ-95's row says so). One existing golden file changed by that alone (`chat-to-anthropic-tools-images-reasoning`: `cache_write_tokens: 7`).
- Endpoint sheet: the two settings as Selects in Edit, and facts (both settings, "Prompt cache" = the summary; hidden when an older server sends no `caching`). Skill `21_shapes_caching.md`; conformance REQ-51/58/93/95 updated, REQ-109 added; OpenAPI from the struct tags (asserted in `TestCachingSettingsAreEndpointFields`).

**Decision, a 400 for markers or fields:** both. The settings and host defaults avoid known refusals up front; and an Endpoint answering 400/422 naming a field Iroha added (`cache_control`, `metadata`, `user`, `prompt_cache_key`) is asked again at once on the same key without any addition, and gets none for the rest of the Request (the first Attempt `retry_elsewhere` with the reason; key state unchanged). Why: an unknown OpenAI-compatible or Anthropic-compatible Endpoint can only be found out by sending, and a setting alone would make Requests that work today fail until the Owner notices; a Failure Rule judges keys, and this is not the key's fault. The cost is one extra Attempt on such an Endpoint, which `off` removes.

**Test-first**: each slice started from a failing test (caching table, golden files and `cache_test.go`, gateway tests, then `EndpointSheet.test.tsx`). Same-Shape passthrough is byte for byte with both settings `on`: `gateway TestSameShapePassthroughStaysByteForByteWithCachingOn`, one subtest per Shape.

**Checks**: `go build ./... && go vet ./... && go test ./...` pass (35 packages, 781 tests and subtests, 0 failures); `gofmt -l` clean on touched files; `npm --prefix web run build` passes, `npm --prefix web test` 80 files, 480 tests pass. Headless Chrome: Endpoint sheet facts light and dark, phone 390 px, Edit with the Selects light, dark, phone dark and the open Select on a phone (screenshots in the notes folder, `prompt-caching/shots/03/`).

**Deferred / worth knowing**:

- A Caller's marker on a non-text Chat part (an image, a tool result) can't be matched to a block by text and is left out; Iroha's own markers are then added only if none of the Caller's were placed.
- Toward OpenAI Responses from Anthropic only `prompt_cache_key` is added (RelayKit already copies `metadata`); no `user` mapping there.
- Host lists are code (like normalisers), not settings; a Provider that changes its handling needs a code change or the Endpoint's `on`/`off`.
- Markers within the 4 that RelayKit splits differently from the Caller's parts (a list-content system prompt stays two blocks) count as separate markers, so the clamp may drop one more than the Caller expected.
