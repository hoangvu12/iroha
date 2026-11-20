# 02: Keep a conversation on one Upstream Key

**What to build** (research section 5.2; read section 3's CLIProxyAPI, Bifrost, OmniRoute and LiteLLM entries for the details this follows):

- **Conversation identity.** First source that applies: `Iroha-Session` header (the `iroha-` prefix is already stripped before forwarding, `attempt.go:55`); `x-claude-code-session-id`; the session inside Claude Code's `metadata.user_id` (JSON form and legacy `_session_` form); Codex `session_id`/`session-id`/`thread-id`; `x-session-id`; OpenCode `x-session-affinity`; body `session_id`; `prompt_cache_key`; else a hash of the system prompt/instructions, tool names and first user message (first few KB; never an empty prefix). Plain `user` is not a session. The value is combined with Gateway Key ID, Provider and model before use, so Callers can't steer each other. Work in every Shape.
- **Key order.** Within each group `planTier` already forms (`planner.go:318-330`: Endpoints of the Caller's Shape first, healthy before back-from-cooling, carriers first, exclusions unchanged), replace the round-robin order with rendezvous (highest random weight) hashing of the affinity value over the usable keys. Requests without an affinity value keep round-robin (there always is one, via the prefix hash, unless the prompt is empty). A key cooling/invalid/disabled/removed drops out, so its conversations move to their own second key; they return when it recovers. Pools keep member order; affinity applies inside each member. The route preview takes an optional affinity value.
- **Setting.** Per Provider: `affinity: on | off`, on by default for every Provider (Owner, 2026-11-20). Plus a global experiment switch `affinity_experiment: off | half` (default off): with `half`, conversations whose affinity hash falls in one bucket get affinity, the others round-robin, so ticket 01's stats can compare the two over a week. Record on each Request where the affinity came from (`header`, `claude_code`, `codex`, `opencode`, `session_id`, `prompt_cache_key`, `prefix`, `none`), whether affinity applied (or the experiment bucket), and whether the preferred key served. Show it on the Request's Details ("Key chosen for this conversation (Claude Code session)"), and filter Requests stats by it so the experiment's two halves can be compared.
- **Rate limits.** A 429 already cools the key; keep that. Measure per-key 429s before/after; bounded load (skip a preferred key with more than k in flight) only if tests or the experiment show a need: leave a note, don't build it speculatively.
- Docs: architecture.md subsection, served skill (how Callers can send `Iroha-Session`, what Iroha reads), glossary term, ticket 26 "key order" note updated.

**Blocked by:** none

**Status:** done

Ticket 01 runs at the same time and adds a Request column too (migration numbering: the second to merge renumbers). Ticket 03 builds on the affinity value (a derived `prompt_cache_key`); expose it from one function in the gateway package for 03 to call.

- [x] Affinity value from every source listed, scoped by Gateway Key, Provider and model; Go tests per source and for Callers not steering each other
- [x] Rendezvous order inside planTier's groups; deterministic second key on cooling and return after; round-robin without a value; Pools; Go tests incl. load still spread across many conversations
- [x] Per-Provider setting (default on), experiment switch, per-Request source/bucket/preferred-served; stats filter; skill, OpenAPI, glossary
- [x] UI: the setting on Provider Settings, the reason on Request Details; web tests; checked in headless Chrome light, dark, phone

## Comments

**Built** (branch `agent/pc02`):

- **Identity**, in the new pure package `internal/affinity`: `Identify(header, body)` takes the first source in the ticket's order and gives `Conversation{Source, ID}`. The prefix hash reads the system prompt or instructions, the tool names and the first user message, each cut at 4 KB, in every Shape (Chat, Responses, Anthropic, Gemini). An empty prompt is `none`, never an empty prefix. Session values are hashed without their source, so one session sent in two places is one conversation. `.For(callerScope)` scopes the conversation to the Gateway Key (test sends get their own scope), and `affinity.Key(conversation, providerID, model)` is the per-Provider value. It costs about 2 ms per 1 MB body (benchmarked, benchmark not kept).
- **Key order**: `planner.keyOrder` ranks the keys by rendezvous hashing (`sha256(affinityKey/keyID)`, descending) where round-robin used to pick a start. `planTier`'s exclusions and its stable groups (Shape tiers, healthy before back-from-cooling, carriers first) are unchanged, so affinity only orders keys inside a group. Requests with affinity don't advance the round-robin Counter. Pools keep member order, and each member ranks its own keys with its own model.
- **One function for ticket 03**: `(*exchange).affinityKey(p, model)` in `internal/gateway/affinity.go`. It ignores the Provider switch and the experiment, and is unused until 03.
- **Settings**: Provider `affinity: on | off` (default on, migration `44_01_conversation_affinity.sql`, renumbered after 01 took 43), audited like the other Provider fields. The global switch is named `affinity.experiment: off | half`, following the dotted names of the other settings (`retention.history_days`), not `affinity_experiment`. `internal/settings` gained a `Choice` kind for it, next to integers.
- **Recording**: each Request stores `affinity.source`, `affinity.mode` (`on`, `off`, `control`, `none`) and `affinity.preferred_served` (whether the plan's first candidate answered). `GET /api/requests` and `/stats` take `affinity` and `affinity_source` filters, in 01's filter style. Compare the experiment's halves with `affinity=on` vs `affinity=control`, plus `caller_kind=gateway_key`.
- **Route preview**: `?affinity=<session>` previews a conversation as if it were sent in `Iroha-Session` (scoped to `as`). Without it the preview shows round-robin. Each member says `key_order: affinity | round_robin`.
- **UI**: a "Keep each conversation on one key" switch in an "Upstream Keys" card on Provider Settings, and a "Key choice" line on Request Details ("Key chosen for this conversation (Claude Code session)", "This conversation's key couldn't serve; its next key was tried (...)", "Keys in turn: ..."). Requests from before show nothing.
- **Docs**: skill `20_gateway_affinity.md` (how Callers send `Iroha-Session`, what Iroha reads, the settings, the Request fields, the preview); a `20_gateway.md` line; glossary **Conversation Affinity**; architecture.md "Prompt caching 02" plus the package map, the inference path step 2 and the ticket 26 and 10 lines; conformance notes PRV-03 and FAIL-105. OpenAPI comes from the routes.

**Decisions to know:**

- **Return after cooling**: a key back from cooling stays behind healthy keys until it succeeds (unchanged FAIL-103/104). So a conversation goes back to its first key after that key's next success (a key test, or when the healthy keys fail), not the moment the cooling ends.
- **Existing tests now pin round-robin.** Affinity is on by default, so gateway tests that assert a round-robin key order turn affinity off (`roundRobin(t, srv, handle)`) or send an empty prompt. Provider IDs are random, so with affinity on a conversation's order would differ between runs. I ran the suite with `-count=4` and `-count=6` and nothing flaked.
- The settings list test now checks only the `retention.` settings, as it counted every setting.

**Test-first:** the Go work went red then green per slice: identity sources, scoping and the experiment bucket (`affinity`); stable order, second key and return, groups, tiers and exclusions, Pools, and load spread (12 keys, 24 000 conversations, each within 15% of even) (`planner`); then through testkit: one key per conversation, the same second key on cooling, Callers not sharing a session, affinity off, the experiment and its stats filter, and the preview (`gateway`). The web tests (the agent turning the switch off, the reason texts, Details) were written alongside the components, so they never ran red.

**Checks:** `go build ./... && go vet ./... && go test ./...` pass (729 tests incl. subtests, 34 packages); `gofmt -l` is clean; `npm --prefix web run build` and `npm --prefix web test` pass (478 tests, 80 files). Headless Chrome, light, dark and 390 px: Provider Settings with affinity on and off, and Request Details for a Claude Code session, the next key after a 429, and a Provider with affinity off. Shots are in `iroha-v2-notes/prompt-caching/shots/02/`. That check found the Key choice sentence cut off by an ellipsis; the Requests `Fact` now has a `wide` form that spans both columns and wraps.

**Deferred:**

- **Bounded load** (skip a preferred key with more than k in flight) is not built, as the ticket says. architecture.md says when to add it: if per-key 429s rise with `affinity=on` against `control`.
- **No UI filter** on the Requests feed for `affinity` and `affinity_source`. The API filters exist, and 01's new filters have no UI either.
- **Measuring per-key 429s** before and after needs deployed traffic: turn on `affinity.experiment=half` for a week and group stats by `upstream_key` with each `affinity` value.
