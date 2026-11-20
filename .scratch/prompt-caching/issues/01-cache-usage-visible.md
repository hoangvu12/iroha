# 01: Cache usage you can see

**What to build** (research section 5.1, 1.4):

- **Store cache writes.** A `cache_write_tokens` count on Requests and Attempts (migration; follow architecture.md "Add a migration"), filled from Anthropic `cache_creation_input_tokens`, Chat/Responses `cache_write_tokens` (and `prompt_tokens_details.cache_write_tokens`), Qwen `prompt_tokens_details.cache_creation_input_tokens`, Kimi's fields. Keep the 5-minute / 1-hour split if the Provider reports it (one extra column or a small JSON; decide and say why). `input_tokens` keeps meaning all prompt tokens; check `internal/usage/usage.go:174-182` where Anthropic writes are folded into input and make the convention one place (research 3: CLIProxyAPI's `TokenBreakdown`, "subset of input" vs "separate from input" parsers).
- **Read DeepSeek's `prompt_cache_hit_tokens`** when `cached_tokens` is absent, and every other cache-read field section 2 lists that Iroha misses.
- **Fix the streamed Responses ← Chat answer that reports 0 cached tokens**, and the golden test file that expects it (research 1.4).
- **Stats.** `GET /api/requests/stats` takes `upstream_key` and `endpoint` filters and `group_by` (`provider`, `upstream_key`, `model`, `caller`), one row per group with requests, input, cache read, cache write. Exclude test-chat Requests when asked (`exclude_tests`), for clean baselines.
- **UI.** A "Cached" share (cache read ÷ input) in the Requests stats row, and cache read/write on a Request's Details and Attempts. On a Provider's Keys tab, a "Cached, 24 h" column per Upstream Key (from the grouped stats) so the Owner can see which keys get cache hits. Follow `docs/agents/architecture.md` Frontend and the UI tickets' conventions (DataTable, tokens, agent tests).

**Blocked by:** none

**Status:** open

Ticket 02 runs at the same time and also adds a Request column (where the affinity came from) with its own migration: coordinate migration file names by taking the next free number at merge time; if both claim the same, the second to merge renumbers.

- [ ] Cache writes recorded for every Provider family that reports them; DeepSeek and other missed read fields read; one usage convention; Go tests per family (golden or testkit)
- [ ] Streamed Responses ← Chat cached tokens fixed with its golden file
- [ ] Stats grouped and filtered by key, endpoint, model, caller; skill and OpenAPI updated
- [ ] Cached share in the Requests stats row, cache numbers on Details/Attempts, per-key cached column on Keys; web tests incl. agent test; checked in headless Chrome light, dark, phone
