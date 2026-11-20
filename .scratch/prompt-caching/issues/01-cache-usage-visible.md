# 01: Cache usage you can see

**What to build** (research section 5.1, 1.4):

- **Store cache writes.** A `cache_write_tokens` count on Requests and Attempts (migration; follow architecture.md "Add a migration"), filled from Anthropic `cache_creation_input_tokens`, Chat/Responses `cache_write_tokens` (and `prompt_tokens_details.cache_write_tokens`), Qwen `prompt_tokens_details.cache_creation_input_tokens`, Kimi's fields. Keep the 5-minute / 1-hour split if the Provider reports it (one extra column or a small JSON; decide and say why). `input_tokens` keeps meaning all prompt tokens; check `internal/usage/usage.go:174-182` where Anthropic writes are folded into input and make the convention one place (research 3: CLIProxyAPI's `TokenBreakdown`, "subset of input" vs "separate from input" parsers).
- **Read DeepSeek's `prompt_cache_hit_tokens`** when `cached_tokens` is absent, and every other cache-read field section 2 lists that Iroha misses.
- **Fix the streamed Responses ← Chat answer that reports 0 cached tokens**, and the golden test file that expects it (research 1.4).
- **Stats.** `GET /api/requests/stats` takes `upstream_key` and `endpoint` filters and `group_by` (`provider`, `upstream_key`, `model`, `caller`), one row per group with requests, input, cache read, cache write. Exclude test-chat Requests when asked (`exclude_tests`), for clean baselines.
- **UI.** A "Cached" share (cache read ÷ input) in the Requests stats row, and cache read/write on a Request's Details and Attempts. On a Provider's Keys tab, a "Cached, 24 h" column per Upstream Key (from the grouped stats) so the Owner can see which keys get cache hits. Follow `docs/agents/architecture.md` Frontend and the UI tickets' conventions (DataTable, tokens, agent tests).

**Blocked by:** none

**Status:** done

Ticket 02 runs at the same time and also adds a Request column (where the affinity came from) with its own migration: coordinate migration file names by taking the next free number at merge time; if both claim the same, the second to merge renumbers.

- [x] Cache writes recorded for every Provider family that reports them; DeepSeek and other missed read fields read; one usage convention; Go tests per family (golden or testkit)
- [x] Streamed Responses ← Chat cached tokens fixed with its golden file
- [x] Stats grouped and filtered by key, endpoint, model, caller; skill and OpenAPI updated
- [x] Cached share in the Requests stats row, cache numbers on Details/Attempts, per-key cached column on Keys; web tests incl. agent test; checked in headless Chrome light, dark, phone

## Comments

**Built** (branch `agent/pc01`):

- **One usage convention** in `internal/usage`: `input` is every prompt token, `cache_read` and `cache_write` are parts of it. Two functions make it from a Provider's counts: `subset` (prompt count includes the cache: OpenAI Chat and Responses, Gemini, DeepSeek, Qwen, Kimi) and `separate` (Anthropic). The old fold-in at `usage.go:174-182` is now `separate`. Several names for one count are never added: the largest wins, as RelayKit's billing does.
- **Fields read**: Anthropic `cache_creation_input_tokens` and `cache_creation.ephemeral_1h_input_tokens`; Chat and Responses `cache_write_tokens` (nested in the details or top-level) and `cache_write_tokens_details.ttl_12h_tokens`; Qwen `prompt_tokens_details.cache_creation_input_tokens` and `cache_creation`; DeepSeek `prompt_cache_hit_tokens`; Moonshot's older top-level `cached_tokens`. Kimi's documented fields are the OpenAI ones (`cached_tokens`, `cache_write_tokens`), covered by the Chat reader.
- **The 5 min / 1 h split**: one extra column, `cache_write_long_tokens` (JSON `cache_write_long`): the part of the writes kept for the longer lifetime. Why: every Provider that reports a split has exactly two lifetimes, a normal one and a dearer long one (Anthropic and Kimi 5 min / 1 h, OpenAI GPT-5.6+ 30 min / 12 h), so one number covers them all and the short part is `cache_write - cache_write_long`. A column, unlike JSON, lets stats sum it in SQL. Migration `43_01_cache_writes.sql` (next free number at the time; ticket 02 may need to renumber).
- **Streamed Responses <- Chat** answer: `cached_tokens` is now the upstream's (64 in the golden file, was 0). Cause: `translate.Stream.End` gave the merged usage back to RelayKit's Chat -> Responses step, which converts it again from the Chat names only. `End` copies the details across first. The golden test now checks that every Responses stream closes with the whole answer's usage.
- **Stats**: `upstream_key` and `endpoint` filters (name or ID; also on `GET /api/requests`), `cache_hits` (warm turns), `tokens.cache_write(_long)`, repeatable `group_by` (`provider`, `upstream_key`, `model`, `caller`) answering `groups`. Skill `41_cache_usage.md` and one line each in `40_history.md` and `22_responses.md`; OpenAPI comes from the route.
- **UI**: "Cached" in the Requests stats row (cache read / input, numbers on hover), "Cache write" and "Long-lived cache write" on Details, "Cache read" (`n of m input`) and "Cache write" on a successful Attempt, the Keys tab's sortable "Cached, 24 h" column.

**Decisions to know:**

- **No `exclude_tests` parameter.** `caller_kind=gateway_key` already leaves test Requests out, and a second way to say it would be two ways to do one thing. The skill and the stats description name it for clean baselines, and the Keys column uses it.
- **Phones** keep the stats row's three cells (Requests, Succeeded, Median), as they already left out Tokens; Cached is desktop only. On phones the Keys tab's two-line rows don't show the cached column either.
- **Old rows**: Requests recorded before this show `cache_write` 0, and their Anthropic writes are already inside `input`. They can't be backfilled.

**Test-first:** each slice started red. Usage reader table test (`usage`), Gateway recording through testkit (Anthropic buffered with a TTL split, Qwen stream, DeepSeek), grouped and filtered stats through testkit, the golden invariant (red on exactly `responses-to-chat-tools-reasoning`), and web tests for the stats row, Details, Attempts and the Keys column. The agent tests on Keys were written after the column, so they never ran red.

**Checks:** `go build ./... && go vet ./... && go test ./...` pass (687 tests incl. subtests); `gofmt -l` is clean; `npm --prefix web run build` and `npm --prefix web test` pass (474 tests, 78 files). Headless Chrome, light, dark and 390 px: Requests, a Request's Details and Attempts, the Keys tab, sorted by Cached. Shots are in `iroha-v2-notes/prompt-caching/shots/01/`. That check found "Median first token" truncated by the seventh cell at 1440 px, fixed with tighter desktop padding.

**Deferred:** the one-week baseline is the Owner's to collect once this is deployed (`GET /api/requests/stats?group_by=provider&group_by=model&since=168h&caller_kind=gateway_key`). Showing `cache_write_tokens` to Callers in translated answers is left to ticket 03 (caching across Shapes): only Iroha's own record changed here, besides the streamed `cached_tokens` fix.
