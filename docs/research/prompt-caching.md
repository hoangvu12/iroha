# Prompt caching in Iroha v2: are we handling it well?

Researched 2026-11-20. Sources:

- **Iroha's code**, read-only, in `C:\Users\ADMIN\Desktop\nguyenvu\iroha-v2` on branch `v2-integration` at `af199ae`. I first read it in the `v2-ui` checkout at `602c002`. That checkout is gone, and its content is now part of `v2-integration`. I re-checked every reference below at `af199ae`, and file paths are relative to that repository.
- **RelayKit `v0.3.7`**, Iroha's translator, read from the Go module cache.
- **The Providers' own documentation**, fetched 2026-11-20. Prices and TTLs are as of that day.
- **The source code of nine other gateways**, read at a pinned commit (section 3 links each file). None was run.

Nothing was sent to production, to any Provider, or over SSH.

RelayKit's request conversions were checked with a small throwaway program outside the repo; section 1.3 states what it showed.

## Summary

- **Iroha rarely sends a conversation's next turn to the same Upstream Key, so it rarely gets cache discounts on Providers with many keys.** Keys are taken in turn for every Request, regardless of which conversation it belongs to. With 28 keys the next turn lands on the same key about 1 time in 28; with 58 keys, about 1 in 58.
  - **When this costs money:** every Provider that documents its cache scope keeps it per organisation or account, never across accounts. So the loss is real whenever a Provider's keys come from different accounts, as relay and reseller keys do. Iroha cannot tell which Providers are like that.
  - **When it doesn't:** if all keys sit in one account, rotating them is harmless.
- **Model Pools are fine.** A Pool always tries its first member and only moves down the list when that member fails, so it does not scatter a conversation across Providers.
- **When the Caller and the Endpoint use the same format, Iroha passes every caching field through untouched.** Claude Code talking to an Anthropic-format Endpoint keeps all its cache markers.
- **When Iroha has to translate, caching mostly disappears.** OpenAI-format and Gemini Callers get no caching at all on Anthropic-format Endpoints. The fields that tell a Provider which conversation a request belongs to are dropped too.
- **Two silent context losses.** Neither raises an error:
  - A Gemini request that refers to a stored cache (`cachedContent`) loses that context when translated.
  - On OpenAI's Responses API, reasoning carried over from earlier turns is dropped when the next turn goes to a key from another OpenAI organisation, which rotation causes. Codex traffic is affected.
- **You can't see how well caching works today.** Cache writes, which several Providers now charge extra for, are not recorded. Cache hits are stored per Request but can't be broken down by key, and the Requests page doesn't total them.
- **Other gateways already solve this, and the fix is well understood.** CLIProxyAPI, LiteLLM, Bifrost, OmniRoute and OpenRouter all keep a conversation on one key, identified by the session id that Claude Code, Codex and OpenCode already send, with a hash of the prompt's start as a fallback. Several also add cache markers when translating to Anthropic format.
- **Recommended order:**
  1. Measure: record cache writes and show the cached share per Provider, key and model.
  2. Keep each conversation on one key, with a fixed second choice when that key is cooling.
  3. Fix caching across formats.

  These are tickets A, B and C in section 6.

---

## 1. What Iroha does today

### 1.1 Routing: which key a conversation's next turn lands on

- **Round-robin, one counter per Provider.** `planner.Plan` takes the first key from a counter for the Provider: `start := int(rot.Next(p.ID) % uint64(n))` (`internal/planner/planner.go:229`).
  - The counter lives in memory, advances once per Request, and resets when Iroha restarts (`planner.go:415-431`).
  - The Gateway holds one counter for all traffic (`internal/gateway/gateway.go:93`, used at `gateway.go:255`).
  - Nothing about the Request (Caller, Gateway Key, model, conversation) affects which key comes first.
- **Two later re-orderings, neither about conversations** (`planner.go:318-330`). Keys back from a cooling go last, and keys whose own model list names the model ("carriers") go first.
- **Consequence:** with *n* usable keys and other traffic in between, consecutive turns share a key about 1 time in *n*. Even a Caller alone on a Provider walks the keys in order, so turn 2 never lands on turn 1's key unless *n* = 1.
- **Pools are ordered failover, not load spreading.**
  - A Pool's members become Providers in member order (`internal/gateway/pool.go:14-19`, `pool.go:50-79`), and the planner lists the first member's candidates first (`planner.go:7-8`, `213-245`).
  - The Request reaches member 2 only when member 1's candidates fail or are excluded within the budget (`internal/gateway/budget.go:109-211`).
  - Side effect: every Pool Request advances the counter of every member planned, not only the member that serves (`planner.go:213-229`).
- **Retries and cooling.** The budget loop tries candidates in plan order, and a 429 cools the key or the key-and-model pair (`budget.go:116-209`). A retry therefore lands on whichever key the rotation gives next, also cold.
- **Iroha has no notion of an account.** The spec removed Upstream Accounts (`.scratch/v2-gateway/spec.md:181`, `273`), so Iroha cannot know which keys share a cache.
  - The cutover notes record 144 Endpoints for 20 Providers, and "9 relay Providers" with per-key model lists (`.scratch/v2-gateway/cutover/README.md:10-12`, `43`).
  - Keys behind different relays are certainly different upstream accounts.

### 1.2 Passthrough (the Caller's Shape is the Endpoint's Shape)

- **The body goes upstream unchanged** except the model name and, on Chat streams, `stream_options.include_usage` (`internal/gateway/attempt.go:109-132`, `175-187`).
  - So every caching field reaches the Provider: `cache_control` (Anthropic); `prompt_cache_key`, `prompt_cache_retention`, `prompt_cache_options`, `user` and `safety_identifier` (OpenAI); `cachedContent` (Gemini); `previous_response_id` (Responses).
  - Conformance REQ-32 covers this ("body byte-identical incl. cache_control", `.scratch/v2-gateway/conformance.md:199`).
- **Request normalisers don't touch caching.** On Chat Endpoints they only drop a replayed message `id` (`internal/normalise/normalise.go:87-91`, `141-162`).
- **Caller headers are forwarded** except credentials, hop-by-hop headers and the `iroha-`, `x-forwarded-` and `cf-` prefixes (`attempt.go:43-68`).
  - So Claude Code's `x-claude-code-session-id` and its `anthropic-beta` header (which it needs for the 1-hour TTL, 2.1) reach Anthropic-format Endpoints.
  - Iroha itself never looks at session headers.
- **Claude Code's rules for gateways are met on this path.** Claude Code's gateway page asks gateways to "forward `cache_control` unchanged wherever it appears, and don't convert block-form `system` or message content to plain strings" (https://code.claude.com/docs/en/llm-gateway-protocol).

### 1.3 Translation (the Caller's Shape differs from the Endpoint's)

Translation is RelayKit's (`internal/translate/translate.go:5-6`, `146-181`).

- Iroha passes RelayKit no dialect options beyond Claude's default `max_tokens` and Gemini's thought-signature bypass (`translate.go:159-164`).
- Iroha's own per-Shape fix-ups rename tools and set stream usage; they never add or remove caching fields (`internal/translate/chat.go:24-56`, `internal/translate/anthropic.go:27-54`).

What reaches the Provider, checked with the test program and the golden files in `internal/translate/testdata/golden/`:

| Caller → Endpoint | `cache_control` | Conversation and user fields | Evidence |
|---|---|---|---|
| Anthropic → Chat | System: **dropped**, flattened to a string. Tools: dropped. Message text blocks: **kept**, as a non-standard `cache_control` on Chat content parts, `ttl` included. | `metadata.user_id` dropped; no `prompt_cache_key` or `user` derived | RelayKit `relayconvert/internal/claude_messages/to_oai_chat_req.go:120-152` (system markers kept only with `OpenRouterDialect`, which Iroha never sets), `:182-189`; golden `anthropic-to-chat-tools-images-thinking.golden:3-9`; test program |
| Anthropic → Responses | Dropped (Responses has no such field) | `metadata` copied; no `prompt_cache_key` | RelayKit `claude_messages/to_oai_responses_req.go:47`; test program |
| Anthropic → Gemini | Dropped | – | golden `anthropic-to-gemini-text-thinking.*` |
| Chat → Anthropic | **Never added.** A Caller's own markers on content parts are **dropped**. | `user`, `prompt_cache_key`, `safety_identifier` dropped; no `metadata.user_id` | RelayKit `oai_chat/to_claude_messages_req.go` reads none of them; golden `chat-to-anthropic-text.golden:1-34` (its input had `"user"`); test program |
| Responses → Anthropic | Never added | `prompt_cache_key`, `user`, `safety_identifier` dropped | test program |
| Gemini → Anthropic | Never added | – | golden `gemini-to-anthropic-text.*` |
| Chat → Responses | n/a | `prompt_cache_key`, `user`, `metadata` kept; `prompt_cache_retention`, `safety_identifier` dropped | RelayKit `oai_chat/to_oai_responses_req.go:404-428`; test program |
| Responses → Chat | n/a | `prompt_cache_key`, `prompt_cache_retention`, `user`, `safety_identifier`, `metadata` kept | RelayKit `oai_responses/to_oai_chat_req.go:77-81`, `112-116`; test program |
| Gemini → any other | – | **`cachedContent` silently dropped.** The cached context it names is simply missing from the translated request. | RelayKit's Gemini request type has the field (`dto/gemini.go:22`) but no converter reads it; test program |
| Responses → any other | – | `previous_response_id` is refused with 400 `untranslatable_request` (correct: the state lives at the Provider) | `internal/gateway/responses.go:24-25` |

### 1.4 Usage: what is recorded and shown

- **Usage is read from the Provider's own answer**, in the Endpoint's Shape, before translation (`internal/usage/usage.go:1-5`). It is stored as four numbers: `Input`, `Output`, `CacheRead`, `Reasoning` (`usage.go:16-21`).
- **Cache writes are not recorded.**
  - Anthropic's `cache_creation_input_tokens` is read (`usage.go:159-164`) but only added into `Input` (`usage.go:174-182`).
  - There is no column for writes (`internal/store/migrations/04_03_requests.sql:31-34`, `59-62`).
  - The write counts that OpenAI GPT-5.6+, Kimi, Qwen and OpenRouter report on Chat and Responses (`cache_write_tokens`, `cache_creation_input_tokens`, see section 2) are not read at all.
- **Chat cache reads come from one field only**, `prompt_tokens_details.cached_tokens` (`usage.go:120-153`). DeepSeek reports `prompt_cache_hit_tokens` (2.4); Iroha records 0 for DeepSeek unless the response also fills `cached_tokens`.
- Responses usage is read from `input_tokens_details.cached_tokens` (`internal/usage/responses.go:7-56`), Gemini's from `cachedContentTokenCount` (`usage.go:91-109`).
- **Usage is stored per Request and per Attempt**, with the Provider, Endpoint and Upstream Key names beside it (`internal/requests/requests.go:140-156`, `200-207`).
- **Visibility is limited.**
  - `GET /api/requests/stats` sums `cache_read` under any filter of caller, Provider, Pool, model, status and time (`internal/requests/stats.go:24-43`, `internal/requests/filter.go:44-53`).
  - It has no Upstream Key filter and no grouping: one row of sums per call.
  - The UI's stats row shows only total tokens (`web/src/pages/requests/Feed.tsx:227`). "Cache read" appears only per Request, in the drawer (`web/src/pages/requests/Details.tsx:91`).
  - So the cached share per Provider, key or model needs SQL today.
- **A bug the Caller can see.** A Responses Caller served by a Chat Endpoint gets `cached_tokens: 0` in the streamed `response.completed`, although the upstream reported 64 and the buffered answer says 64.
  - Evidence: `internal/translate/testdata/golden/responses-to-chat-tools-reasoning.golden:138` vs `:206`, with input `responses-to-chat-tools-reasoning.in.json:58`.
  - The golden file locks the bug in. Iroha's own record is unaffected, because it reads the upstream answer.
- **Translated usage is correct within what each Shape can express.**
  - Chat Callers on Anthropic get `prompt_tokens` = input + cache read + cache write, and `cached_tokens` = read (REQ-93, `conformance.md:258`).
  - Anthropic Callers on Chat get `input_tokens` = prompt − cached, and `cache_read_input_tokens` = cached (REQ-95, `conformance.md:260`).

---

## 2. What each Provider does

Taken from each Provider's own documentation, fetched 2026-11-20. Most pages were read through a fetch tool that summarises, so quotes are close but not always verbatim. "Not documented" means the Provider's page doesn't say.

| Provider | Automatic or explicit | Cache shared within | Minimum prefix | TTL | Read / write price vs normal input | Hints that route to a warm cache |
|---|---|---|---|---|---|---|
| Anthropic | Explicit `cache_control` (max 4), or one top-level `cache_control` that moves forward automatically | Organisation; on the Claude API also per workspace | 512–4,096 tokens by model | 5 min (refreshed on each hit) or 1 h | read 0.1x (0.05x/0.025x on newest); write 1.25x (5 min), 2x (1 h) | none |
| OpenAI | Automatic; GPT-5.6+ also explicit breakpoints | Organisation and processing region | 1,024 (5.6+) | older models: in-memory 5–10 min up to 1 h, or 24 h; 5.6+: 30 min or 12 h | older: discount up to 95%, no write charge; 5.6+: read 0.1x, write 1.25x (30 min) / 2.5x (12 h) | `prompt_cache_key`; about 15 requests/min per prefix and key before overflow |
| Gemini API | Implicit (2.5+); explicit `cachedContents` (not on Gemini 4) | Not documented | 2,048–4,096 implicit | implicit not documented; explicit 1 h by default | about 0.1x; explicit also bills storage per hour | none |
| Vertex Gemini | Same | GCP project | 2,048–6,144 | implicit ≤ 24 h | 90% discount | none |
| DeepSeek | Automatic, on disk | Account / "user"; `user_id` isolates further | "cache prefix units" (64 tokens in 2024) | hours to days | about 1/30 to 1/50; no write premium | `user_id` (`metadata.user_id` on its Anthropic API) |
| Qwen / Model Studio | Implicit always on; explicit `cache_control` (max 4) | Account, per model | 1,024 (512 for some) | explicit 5 min; implicit not stated | implicit read 0.2x; explicit read 0.1x, write 1.25x | none |
| MiniMax | Automatic (OpenAI and Anthropic formats) | Not documented | 512 | Not documented | read 0.1x; no write price listed | none |
| Z.ai | Automatic | Not documented | Not documented | Not documented | read about 0.19x per the price table ("50%" in the guide text) | none documented; OpenRouter sends Z.ai a "session affinity key" |
| Moonshot / Kimi | Automatic only (explicit breakpoints get 400) | Organisation | Undocumented block size | 5 min or 1 h, renewed on hit | read 0.1x; write 1x (5 min) / 2x (1 h) | `prompt_cache_key` ("required" on the Kimi Code Plan) |
| OpenRouter | Passes each Provider's mechanism through | Its own sticky routing: per account, model and conversation | per Provider | sticky 60 min idle | per Provider; `cache_discount` reported | `session_id` / `x-session-id`, then `prompt_cache_key` |

### 2.1 Anthropic

Sources: https://platform.claude.com/docs/en/build-with-claude/prompt-caching · https://platform.claude.com/docs/en/about-claude/pricing

- **Two ways to cache.**
  - Explicit: put `cache_control` on up to 4 blocks; each breakpoint looks back 20 block positions.
  - Automatic: one top-level `cache_control: {"type":"ephemeral"}` "applies the cache breakpoint to the last cacheable block and moves it forward as conversations grow".
  - The automatic marker uses one of the 4 slots, so 4 explicit markers plus a top-level one gives a 400.
  - Top-level `cache_control` gives a 400 on Bedrock.
- **Scope**, quoted: "Organization isolation: Different organizations never share caches", and "Workspace isolation: On the Claude API … caches are also isolated between workspaces". API keys themselves are not mentioned.
- **Minimum prefix:** 512 tokens on the current 5.x models, up to 4,096 on older ones. A shorter prompt is simply not cached; there is no error.
- **TTL:** 5 minutes, refreshed free on every hit; or `"ttl":"1h"`. Longer TTLs must come before shorter ones in the prompt.
- **Usage fields:** `cache_creation_input_tokens`, `cache_read_input_tokens`, and `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`. `input_tokens` counts only the tokens after the last breakpoint. When streaming, these arrive in `message_start`.
- **Claude Code** (https://code.claude.com/docs/en/prompt-caching, https://code.claude.com/docs/en/llm-gateway-protocol):
  - It sets markers itself, on `system` blocks and `messages` entries.
  - It uses the 1-hour TTL on subscriptions or when the user opts in; the gateway must then forward `anthropic-beta`.
  - Its session signal is the header **`x-claude-code-session-id`**, plus `x-claude-code-agent-id` and `-parent-agent-id`. What it puts in `metadata.user_id` is not documented. Gateways (CLIProxyAPI, LiteLLM) parse a session id out of it, so it carries one in practice.
- **Other vendors' Anthropic-compatible endpoints:**

| Vendor | `cache_control` handling |
|---|---|
| DeepSeek | Ignored; `cache_creation_input_tokens` is always 0 |
| Kimi | Only the top-level form, used to pick the TTL |
| Alibaba (Qwen) | Block-level markers honoured, max 4 |
| MiniMax | Docs describe only automatic caching |
| Z.ai | Not documented |

### 2.2 OpenAI (Chat Completions and Responses)

Sources: https://developers.openai.com/api/docs/guides/prompt-caching · https://developers.openai.com/api/docs/guides/reasoning?api-mode=responses

- **Caching is automatic.** Requests are routed "within an organization and processing region" by "a hash of the initial tokens", and caches "are not shared across organizations".
- **`prompt_cache_key`:** "Keys influence routing; they do not pin requests to a machine." The guide advises "about 15 requests per minute in total across all prefixes using each key".
- **The `user` field** "is being replaced by `safety_identifier` and `prompt_cache_key`".
- **Retention:** `prompt_cache_retention` (in-memory or 24 h) is now marked deprecated. GPT-5.6+ uses `prompt_cache_options.ttl`, 30 minutes or 12 hours, and charges for writes (1.25x or 2.5x).
- **Usage fields:** Chat reports `usage.prompt_tokens_details.cached_tokens` and `cache_write_tokens`. Responses reports `usage.input_tokens_details.cached_tokens`, `cache_write_tokens` and `cache_write_tokens_details`.
- **Reasoning from another organisation is dropped.** Encrypted reasoning items reused from a different organisation are dropped (reason `organization_mismatch`), "as one of our safeguards against distillation".
  - So a Responses conversation that Iroha rotates across keys from different organisations loses its earlier reasoning on every switch.
  - Whether `previous_response_id` works across organisations is not documented.

### 2.3 Gemini

Sources: https://aistudio.google.com/docs/caching · https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview

- **Implicit caching** is "enabled by default for all Gemini 2.5 and newer models", with "no cost saving guarantee".
- **Explicit caching** (`cachedContents`) is a beta resource, not supported on Gemini 4, with a TTL of 1 hour by default and storage billed per token-hour.
- **Scope:** on Vertex, "Google Cloud uses your project number to isolate cached data". On the Gemini API, whether the cache belongs to the key or the project is not documented.
- **Usage field:** `usageMetadata.cachedContentTokenCount`, counted inside `promptTokenCount`.

### 2.4 DeepSeek

Sources: https://api-docs.deepseek.com/guides/kv_cache · https://api-docs.deepseek.com/quick_start/rate_limit/

- **Caching is automatic, on disk**, and kept "a few hours to a few days".
- **Usage fields:** `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens` (`cache_read_input_tokens` on its Anthropic API).
- **Scope:** concurrency limits are "calculated at the account level, regardless of which API Key is used", and "`user_id` is used to isolate KVCache for users".

### 2.5 Qwen / Alibaba Model Studio

Source: https://www.alibabacloud.com/help/en/model-studio/context-cache

- **Implicit caching** is always on.
- **Explicit caching:** `cache_control` on content blocks, in the OpenAI-compatible, DashScope and Anthropic-compatible APIs, max 4 markers, 5-minute TTL. A request uses either implicit or explicit, not both.
- **Scope:** "isolated at the account level", and "isolated between models".
- **Usage fields:** `prompt_tokens_details.cached_tokens` and `prompt_tokens_details.cache_creation_input_tokens`.

### 2.6 MiniMax, Z.ai, Moonshot/Kimi

- **MiniMax** (https://platform.minimax.io/docs/api-reference/text-prompt-caching.md)
  - Caching is automatic on both the OpenAI and Anthropic APIs.
  - Usage: `cache_read_input_tokens` on the Anthropic API, `prompt_tokens_details.cached_tokens` on the OpenAI one.
  - Scope and TTL are not documented.
  - `cache_control` is not mentioned in current docs. Secondary sources say older docs had it for M2.x; I could not confirm that.
- **Z.ai** (https://docs.z.ai/guides/capabilities/cache)
  - Caching is automatic; usage is reported in `prompt_tokens_details.cached_tokens`.
  - Scope, TTL and how its Anthropic endpoint treats `cache_control` are not documented.
- **Kimi** (https://platform.kimi.ai/docs/guide/context-caching)
  - Caching is automatic, and the cache "is isolated per organization".
  - `prompt_cache_key` is recommended (required on the Kimi Code Plan).
  - Chat usage: `prompt_tokens_details.cached_tokens` and `.cache_write_tokens`.

### 2.7 OpenRouter

Source: https://openrouter.ai/docs/guides/best-practices/prompt-caching

- **It keeps a conversation on one provider:** "provider sticky routing to route your subsequent requests to the same provider endpoint after a cached request".
- Stickiness is tracked "at the account level, per model, and per conversation", and "expire[s] after 60 minutes of inactivity".
- **How it identifies a conversation:** a hash of the first system message and the first non-system message. A `session_id` (body field or `x-session-id` header) replaces the hash; failing both, `prompt_cache_key`.
- **When pinning starts:** with a session id, on the first success. With the hash, only after a cache hit.
- **It applies only where reads are cheaper than normal input.** A manual `provider.order` turns it off, and an error from the pinned provider releases the pin.

### 2.8 What this means for Iroha

- **No cache is shared across accounts**, at any Provider that documents its cache scope. Rotating one conversation over keys from N accounts means up to N cold starts.
  - Where writes carry a premium (Anthropic, OpenAI GPT-5.6+, Kimi 1 h, Qwen explicit), each cold start also costs extra.
- **Within one account, key rotation does no harm** where the cache is org or account wide: OpenAI, Anthropic (same workspace), Kimi, Qwen, DeepSeek.
- **Unknown cache scope:** the Gemini API, MiniMax and Z.ai.
- **Which of the Owner's keys share an account is unknowable from docs.** For example, whether the 28 keys of one reseller are 28 accounts. One experiment answers it per Provider: send the same long prompt through key A, then key B, and check B's cached-token count. Affinity (section 5) makes the answer matter less: keeping a conversation on one key is never worse for caching.
- **OpenAI needs stickiness even within one organisation.** Its cache sits on the machines that served the prefix, and `prompt_cache_key` steers requests there.

---

## 3. How other gateways handle it

Read from source at the commit given; "docs" marks a claim not verified in code.
| Gateway (commit) | Keeps a conversation on one key? | How a session is identified | When the key fails | Adds `cache_control` when translating to Anthropic? | Cache usage recorded |
|---|---|---|---|---|---|
| CLIProxyAPI, Go (`6faa8d2`) | Yes, opt-in (`routing.session-affinity`), per credential | `x-claude-code-session-id` → session inside `metadata.user_id` → Codex `session_id` headers → `x-session-id` → `x-session-affinity` → `prompt_cache_key` → … → hash of system + first user (+ first assistant) | Re-picks by round-robin and re-binds (not deterministic); in `quota` mode re-binds only on 401/402/403/429 | Yes, for translated Callers: last system block, last message, clamped to 4, TTL order fixed; derives `metadata.user_id` and `prompt_cache_key` | read and write, with TTL buckets, per credential |
| OmniRoute, TS (`ab180e3`) | Yes, three layers, including rendezvous hashing over accounts | session headers → `prompt_cache_key` → hash of the prompt's start | The hashed layer moves to the next account and returns when the first recovers; the pin layer is overwritten | Yes: system (1 h), last tool, last assistant; client markers kept | read and write per connection |
| claude-code-router (`da96d5d`) | No (fixed priority makes it sticky by accident) | – | 60 s cooldown, next credential | No; translation drops markers | read and write per credential |
| LiteLLM (`6001ce6`) | Yes: prompt-prefix routing plus session, `previous_response_id` and caller pins | Hash chain of blocks up to the last marker, 20-position lookback; or `x-litellm-session-id`, `x-claude-code-session-id`, Codex `session-id`, `x-session-id` | Pins skip deployments already tried in this request; optional re-pin on failover | Opt-in auto mode (system + last message), cap 4; maps `user` → `metadata.user_id`, Claude Code session → `prompt_cache_key` | read and write, per TTL |
| new-api (`3a407cc`) | Per channel, not per key (keys inside a channel still rotate) | Rules: `prompt_cache_key` for `/v1/responses`, `metadata.user_id` for `/v1/messages` | Strict mode by default: no retry when the pinned channel fails | No | read and write ratios; per-session hit statistics |
| one-api (`8df4a26`) | No | – | – | No; drops markers | none |
| Bifrost, Go (`783c682`) | Yes, provider and key binding | `x-bf-session-id`, then `x-claude-code-session-id`, `x-session-affinity`, `x-session-id`, `session-id`, `thread-id`; hashed with virtual key and user | Binding deleted when the bound key fails; first success binds (set-if-absent, 1 h TTL) | Opt-in per provider; skipped if the client sent any marker; clamp drops earliest; `metadata.user_id` ↔ `user`/`prompt_cache_key` | read and write (5 min / 1 h) per key |
| Portkey (`669825c`) | No in open source ("sticky" exists only in hosted docs) | – | – | Passes markers through but rebuilds them without `ttl` (1 h becomes 5 min) | read only |
| Helicone (`9254d10`) | No | – | – | Adds one 5-minute marker on the last block when none was sent | read and write (5 min / 1 h) per request |
| OpenRouter (docs) | Yes, per provider, 60 min idle | `session_id` / `x-session-id` → `prompt_cache_key` → hash of first system + first non-system message | Falls back to next provider; pin not updated on error | Passes markers through; translates between `cache_control` and `prompt_cache_breakpoint` | read, write, `cache_discount` |

Key links (all at the commits above):

- **CLIProxyAPI**
  - Session sources: [`sdk/cliproxy/auth/selector.go#L2488-L2502`](https://github.com/router-for-me/CLIProxyAPI/blob/6faa8d20b2673404cff70a2f2d9537ae0d0e684d/sdk/cliproxy/auth/selector.go#L2488-L2502)
  - Re-bind modes: [`selector.go#L1456-L1469`](https://github.com/router-for-me/CLIProxyAPI/blob/6faa8d20b2673404cff70a2f2d9537ae0d0e684d/sdk/cliproxy/auth/selector.go#L1456-L1469)
  - Breakpoint injection and clamp: [`claude_executor_cloaking.go#L2835-L2877`](https://github.com/router-for-me/CLIProxyAPI/blob/6faa8d20b2673404cff70a2f2d9537ae0d0e684d/internal/runtime/executor/claude_executor_cloaking.go#L2835-L2877), [`#L4143-L4219`](https://github.com/router-for-me/CLIProxyAPI/blob/6faa8d20b2673404cff70a2f2d9537ae0d0e684d/internal/runtime/executor/claude_executor_cloaking.go#L4143-L4219)
  - `metadata.user_id` derivation: [`translator/common/claude_user_id.go#L19-L90`](https://github.com/router-for-me/CLIProxyAPI/blob/6faa8d20b2673404cff70a2f2d9537ae0d0e684d/internal/translator/common/claude_user_id.go#L19-L90)
  - `prompt_cache_key` for OpenAI-compatible providers: [`openai_compat_executor.go#L1092-L1141`](https://github.com/router-for-me/CLIProxyAPI/blob/6faa8d20b2673404cff70a2f2d9537ae0d0e684d/internal/runtime/executor/openai_compat_executor.go#L1092-L1141)
  - Usage type: [`sdk/cliproxy/usage/accounting.go#L90-L163`](https://github.com/router-for-me/CLIProxyAPI/blob/6faa8d20b2673404cff70a2f2d9537ae0d0e684d/sdk/cliproxy/usage/accounting.go#L90-L163)
- **OmniRoute**
  - Rendezvous hashing: [`open-sse/services/combo/promptCacheAffinity.ts#L79-L146`](https://github.com/cheaper-inference/OmniRoute/blob/ab180e32fcdf1f78c96f98a617e17c86e34bf5aa/open-sse/services/combo/promptCacheAffinity.ts#L79-L146)
  - Why it never re-derives client markers (re-deriving them cost about 200k cache-write tokens per turn): [`open-sse/utils/cacheControlPolicy.ts#L80-L216`](https://github.com/cheaper-inference/OmniRoute/blob/ab180e32fcdf1f78c96f98a617e17c86e34bf5aa/open-sse/utils/cacheControlPolicy.ts#L80-L216)
  - Defect: with no system message its `prompt_cache_key` hashes the empty string, so all such requests share one key: [`chatCore/upstreamBody.ts#L322-L348`](https://github.com/cheaper-inference/OmniRoute/blob/ab180e32fcdf1f78c96f98a617e17c86e34bf5aa/open-sse/handlers/chatCore/upstreamBody.ts#L322-L348)
- **LiteLLM**
  - Prefix routing: [`litellm/router_utils/prompt_caching_cache.py#L228-L484`](https://github.com/BerriAI/litellm/blob/6001ce63fb8e99c1e95fd6509db80f3dfb0c2e09/litellm/router_utils/prompt_caching_cache.py#L228-L484)
  - Session and `previous_response_id` pins: [`deployment_affinity_check.py#L392-L532`](https://github.com/BerriAI/litellm/blob/6001ce63fb8e99c1e95fd6509db80f3dfb0c2e09/litellm/router_utils/pre_call_checks/deployment_affinity_check.py#L392-L532)
  - Why a plain user id is not used as the session (it would merge one person's parallel sessions): [`litellm/llms/anthropic/messages/utils.py#L95-L116`](https://github.com/BerriAI/litellm/blob/6001ce63fb8e99c1e95fd6509db80f3dfb0c2e09/litellm/llms/anthropic/messages/utils.py#L95-L116)
- **Bifrost**
  - Binding lifecycle: [`core/sessionaffinity.go#L185-L259`](https://github.com/maximhq/bifrost/blob/783c682951a1c4d6a07a677779e0becab8bbbe2c/core/sessionaffinity.go#L185-L259)
  - Injection rules: [`core/providers/utils/promptcache.go#L28-L131`](https://github.com/maximhq/bifrost/blob/783c682951a1c4d6a07a677779e0becab8bbbe2c/core/providers/utils/promptcache.go#L28-L131)
  - Clamp: [`core/providers/anthropic/utils.go#L1841-L1896`](https://github.com/maximhq/bifrost/blob/783c682951a1c4d6a07a677779e0becab8bbbe2c/core/providers/anthropic/utils.go#L1841-L1896)
- **new-api**
  - Channel affinity rules: [`setting/operation_setting/channel_affinity_setting.go#L117-L155`](https://github.com/QuantumNous/new-api/blob/3a407cc9b064fe79a4ffac4146b2690c465dc929/setting/operation_setting/channel_affinity_setting.go#L117-L155)
  - Per-session hit statistics: [`service/channel_affinity.go#L849-L920`](https://github.com/QuantumNous/new-api/blob/3a407cc9b064fe79a4ffac4146b2690c465dc929/service/channel_affinity.go#L849-L920)

What they agree on:

- The session id comes from what the coding tools already send. A hash of the prompt's start is the fallback.
- The binding is scoped by caller.
- Client markers are never touched; translated or marker-free requests get injected markers, clamped to 4.
- Reads and writes are stored separately, per key.

None of them uses `previous_response_id` for affinity except LiteLLM, which encodes the deployment into the response id.

---

## 4. What is wrong or missing in Iroha

Most valuable first.

1. **Key rotation throws away caches wherever a Provider's keys span accounts** (relays, resellers, pooled accounts).
   - Turn N+1 of a conversation almost never lands on turn N's key (1.1), and accounts never share caches (2.8).
   - This is the Owner's main traffic: long agent conversations from Pi, OpenCode, Zeron fleets, and Claude Code via CLIProxyAPI.
   - Even within one OpenAI organisation, no `prompt_cache_key` is sent to steer requests to warm machines (2.2).
2. **Reasoning is silently lost on Responses Endpoints when keys span OpenAI organisations.** Encrypted reasoning items from another organisation are dropped (2.2). This affects Codex-style `store:false` traffic.
3. **Retries and cooling send a conversation to a random next key**, rather than a predictable second key whose cache the next turn would then find warm.
4. **OpenAI-format and Gemini Callers get no caching on Anthropic-format Endpoints** (1.3). Anthropic caching is opt-in (2.1), so every turn there is billed at the full input price.
5. **Conversation fields are lost in translation.** `prompt_cache_key`/`user` never become `metadata.user_id`, and a Claude Code session never becomes a `prompt_cache_key` for OpenAI-format Endpoints, Kimi and DeepSeek (2.2, 2.4, 2.6).
6. **Anthropic → Chat drops the system prompt's marker but keeps the message markers** (1.3). For Endpoints that need explicit markers (Qwen explicit cache, OpenRouter in front of Claude), the most valuable breakpoint is the one lost. A strict validator could also reject the stray `cache_control` on content parts; this is untested.
7. **Cache writes are invisible, and cache hits are hard to see per key** (1.4). DeepSeek reads always record 0 unless its answer also fills `cached_tokens`. Without these numbers no fix can be measured.
8. **A Gemini `cachedContent` reference is silently dropped when translated** (1.3). It should be refused, as `previous_response_id` is.
9. **The streamed Responses ← Chat answer reports `cached_tokens: 0`** (1.4).

## 5. Recommended design

### 5.1 Measure first (small; do it before anything else)

- **Store cache writes.**
  - Add `cache_write_tokens` to Requests and Attempts, filled from:
    - Anthropic `cache_creation_input_tokens`;
    - Chat/Responses `cache_write_tokens`;
    - Qwen `prompt_tokens_details.cache_creation_input_tokens`.
  - `input` keeps meaning all prompt tokens.
  - Optionally split 5-minute and 1-hour writes, as CLIProxyAPI, Bifrost and Helicone do.
- **Read DeepSeek's `prompt_cache_hit_tokens`** when `cached_tokens` is absent.
- **Make `GET /api/requests/stats` groupable.** Add `upstream_key` and `endpoint` filters and a `group_by` (`provider`, `upstream_key`, `model`, `caller`), returning one row per group with requests, input, cache read and cache write.
- **Show a "Cached" figure** (cache read ÷ input) in the Requests stats row.
- **Baseline.** Per Provider and model, counting only Requests above the Provider's minimum prefix (section 2), take two numbers:
  - cache-read share = Σ cache read ÷ Σ input;
  - warm-turn rate = share of Requests with any cache read.

  Collect a week of this before changing routing.
- **One experiment per relay Provider** (2.8): send the same long prompt through key A, then key B. It tells the Owner whether that Provider's keys share a cache at all.

### 5.2 Conversation affinity in the planner (the big one)

The idea: instead of "where does round-robin start", ask "which key does this conversation prefer". This applies only to Requests that carry an affinity value; everything else keeps round-robin.

**What identifies a conversation.** The first source that applies wins; this is the order CLIProxyAPI, LiteLLM and Bifrost converged on.

1. An explicit Caller header, `Iroha-Session`. The `iroha-` prefix is already stripped before forwarding (`attempt.go:55`).
2. `x-claude-code-session-id`. Subagents inherit the parent's key, because they send the same session id.
3. The session id inside Claude Code's `metadata.user_id`.
4. Codex's `session_id`/`session-id` and `thread-id` headers; `x-session-id`; OpenCode's `x-session-affinity`; a body `session_id`.
5. `prompt_cache_key`.
6. Fallback: a hash of the system prompt or instructions, the tool names, and the first user message, taking only the first few KB.
   - This stays stable across turns, because agents append to the conversation; they don't rewrite its start.
   - It changes after compaction, which is fine: the prefix changed, so the cache is cold anyway.
   - Never hash an empty prefix (OmniRoute's defect).

Each value is combined with the Gateway Key ID, Provider and model, so Callers can never steer each other (Bifrost does the same). **Plain `user` is not a session:** it would merge one person's parallel conversations onto one key (LiteLLM's reasoning).

**How a key is picked: rendezvous (highest random weight) hashing**, as OmniRoute does. Score every usable key with `h(affinity, key.ID)` and order the keys by score.

- **Stateless:** same conversation, same first key, every time. Nothing is stored, and restarts don't change it.
- **Deterministic second choice:** when the first key is cooling, invalid, disabled or removed, only its conversations move, and each moves to its own second key. The next turn finds the cache warm there, which fixes problem 3 of section 4. When the key recovers, they move back, at the cost of one cold turn.
- **CLIProxyAPI's "re-bind only on quota" comes for free.** A transient 5xx retried within one Request doesn't change the next turn's first key.
- **Load still spreads** over keys as it does today, as long as there are many concurrent conversations. One very busy conversation does sit on one key; that is the point.

**Fitting it into the existing ordering.** Affinity replaces only the round-robin order within each group of `planTier` (`planner.go:318-330`):

- Endpoints of the Caller's Shape still come first.
- Healthy keys still come before keys back from cooling.
- Carriers still come before non-carriers.
- The exclusions stay as they are.

**Per-key rate limits.**

- A 429 already cools the key (`budget.go:195-202`), and the conversation then moves to its second key for the cooling. Cost: at most one failed Attempt per cooling.
- If per-key 429s rise after the change, add bounded load: skip the preferred key while it has more than *k* Requests in flight. This is "consistent hashing with bounded loads", https://arxiv.org/abs/1608.01350.

**Pools.** Keep member order (Pools are failover, 1.1) and apply affinity inside each member.

**Settings and explanation.**

- A per-Provider setting `affinity: on | off`, on by default. Reads are cheaper than normal input at every Provider in section 2, which is OpenRouter's condition for stickiness.
- Record on each Request where the affinity came from (header, Claude Code, Codex, `prompt_cache_key`, prefix hash, none) and whether the preferred key served. That lets the Requests page explain "why this key".
- The route preview takes an optional affinity value.

**`previous_response_id` and Gemini `cachedContent`** need the exact key that created the state. Rendezvous hashing covers them only when the conversation already carries an affinity value. Exact support means recording the upstream response id with its key; that is lower priority.

**Trade-offs in one line each:**

- Header: exact, but Callers must send it.
- Coding-tool session ids: free for Claude Code, Codex and OpenCode, absent for others.
- Prefix hash: works for everyone, costs hashing a few KB per Request, and can group two conversations that start identically. That is harmless: they share a prefix, so sharing the cache helps both.

### 5.3 Translation fixes

1. **Add caching when translating to Anthropic Messages** (from Chat, Responses or Gemini).
   - Where the Endpoint accepts it, prefer Anthropic's top-level automatic `cache_control` (2.1): one field, and Anthropic moves the breakpoint itself.
   - Otherwise mark the last tool, the last system block and the last message, never more than 4. This also covers REQ-109's clamp.
   - Never touch a Caller's own markers. Keep a Caller's OpenRouter-style markers instead of dropping them, and keep any `ttl` (Portkey loses it).
   - Clamp by dropping the earliest markers, and fix the TTL order (no 1-hour marker after a 5-minute one).
   - Make it a per-Endpoint setting, on by default for Anthropic-format Endpoints, because the traffic is multi-turn.
   - The cost is the write premium (1.25x) on prompts that are never reused. Measure it with `cache_write_tokens`.
2. **Carry conversation fields across Shapes.**
   - Map `user`/`prompt_cache_key` to `metadata.user_id`, and the reverse.
   - On OpenAI-format Endpoints (OpenAI, Kimi, OpenRouter) that receive no `prompt_cache_key`, set one derived from the affinity value: CLIProxyAPI uses `UUIDv5(provider, model, session)`, hashed if over 64 characters. Derive it only from a real session or prefix, never from a plain user id.
   - Gate this per Endpoint, because some OpenAI-compatible servers reject unknown fields.
3. **Anthropic → Chat.** Keep the system prompt's marker for Endpoints that honour markers. Either set RelayKit's `OpenRouterDialect` per Endpoint, or move the marker in Iroha's chat `prepareRequest`. Strip markers for Endpoints that reject them. Add a gateway test per Provider family that matters.
4. **Refuse Gemini `cachedContent` in translation** with 400 `untranslatable_request`, as `previous_response_id` already is (`responses.go:25`).
5. **Fix the streamed Responses ← Chat `cached_tokens`** and correct the golden file.

### 5.4 Measuring the benefit

- **Before and after**, per Provider and model: cache-read share and warm-turn rate (5.1), over the same weekday hours, excluding Test Callers.
- **Watch the side effects:** Requests per key (is load still spread?) and the 429 rate per Provider before and after.
- **For Anthropic-format Endpoints served by translation:** cache writes vs cache reads. With 5-minute pricing (write 1.25x, read 0.1x), a single read pays for the write premium.
- **A cheap A/B:** hash the affinity value into two buckets, turn affinity on for one for a week, and compare the two on the same Providers.

---

## 6. Proposed tickets

**A. Cache usage you can see** (small; prerequisite for B and C)

- Add `cache_write_tokens` to Requests and Attempts, read from:
  - Anthropic `cache_creation_input_tokens`;
  - Chat/Responses `cache_write_tokens`;
  - Qwen `cache_creation_input_tokens`.
- Read DeepSeek's `prompt_cache_hit_tokens`.
- In `GET /api/requests/stats`: `upstream_key`/`endpoint` filters and `group_by`.
- A "Cached" share in the stats row.
- Fix the streamed Responses ← Chat `cached_tokens` and its golden file.
- Done when the Owner can read the cached share per Provider, key and model, and has a one-week baseline.

**B. Conversation affinity** (the main win)

- Extract the affinity value in the order of 5.2: `Iroha-Session`, Claude Code, Codex/OpenCode headers, `prompt_cache_key`, prefix hash. Combine it with Gateway Key, Provider and model.
- Rendezvous hashing inside `planTier`'s groups; per-Provider `affinity` setting.
- Record the affinity source on the Request, and take an affinity value in the route preview.
- Table tests in `planner`, plus a gateway test: two turns of one conversation land on one key, and a cooled key moves the conversation to the same second key every time.
- Done when the warm-turn rate on multi-key Providers rises against ticket A's baseline without a rise in 429s.

**C. Caching across Shapes**

- Top-level or breakpoint `cache_control` injection when translating to Anthropic, per Endpoint: clamp to 4, keep `ttl`, never touch the Caller's own markers.
- Map `metadata.user_id` ↔ `user`/`prompt_cache_key`; derived `prompt_cache_key` per Endpoint.
- Keep the system marker on Anthropic → Chat where it is honoured.
- Refuse Gemini `cachedContent` in translation.
- Golden tests per Shape pair.
