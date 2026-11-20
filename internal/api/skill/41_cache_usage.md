## Prompt cache usage

Every Request and Attempt records its token `usage` in one convention, whatever the Provider's own: `input` is every prompt token, and `cache_read` (served from the Provider's prompt cache) and `cache_write` (written to it) are parts of it. `cache_write_long` is the part of the writes kept for the Provider's longer lifetime (Anthropic's 1 h, OpenAI's 12 h), which costs more; it is 0 when the Provider reports no split. Requests recorded before Iroha read cache writes show 0 there (and their Anthropic writes are inside `input`).

What is read, per answer Shape:

- **Anthropic Messages**: `cache_read_input_tokens`, `cache_creation_input_tokens` and `cache_creation.ephemeral_1h_input_tokens`; Anthropic's `input_tokens` excludes both, so `input` = `input_tokens` + read + write.
- **OpenAI Chat** (and the OpenAI-compatible APIs of DeepSeek, Qwen, Kimi, OpenRouter...): reads from `prompt_tokens_details.cached_tokens`, DeepSeek's `prompt_cache_hit_tokens` or a top-level `cached_tokens`; writes from `prompt_tokens_details.cache_write_tokens`, Qwen's `prompt_tokens_details.cache_creation_input_tokens` or a top-level `cache_write_tokens`. Names for the same count are never added: the largest wins.
- **OpenAI Responses**: `input_tokens_details.cached_tokens` and `.cache_write_tokens`.
- **Gemini**: `cachedContentTokenCount` (Gemini reports no writes).

**How well caching works.** `GET /api/requests/stats` answers `cache_hits` (Requests that read anything from the cache) and `tokens.cache_read` / `tokens.cache_write`; the cached share is `cache_read / input`. Add `group_by` (`provider`, `upstream_key`, `model`, `caller`, repeatable to combine) for one row per group in `groups`, each with `requests`, `cache_hits` and `tokens`, most Requests first. Leave test Requests (sent from the test chat, also those sent as a Gateway Key) out with `exclude_tests=true`; the same filter works on `GET /api/requests`. (`caller_kind=gateway_key` also still works.) Examples:

- Which keys of a Provider get cache hits: `GET /api/requests/stats?provider=acme&group_by=upstream_key&since=24h&exclude_tests=true` (the Keys tab's "Cached, 24 h" column reads this).
- A baseline per Provider and model: `GET /api/requests/stats?group_by=provider&group_by=model&since=168h&exclude_tests=true`.
- One key or Endpoint only: add `upstream_key=<name or ID>` (with `provider=`, since key names are unique per Provider) or `endpoint=<name or ID>`; the same filters work on `GET /api/requests`.

A key's cache is shared only within the Provider's account (or organisation), so a conversation whose turns land on keys of different accounts reads nothing from the cache.
