# 02: Keep a conversation on one Upstream Key

**What to build** (research section 5.2; read section 3's CLIProxyAPI, Bifrost, OmniRoute and LiteLLM entries for the details this follows):

- **Conversation identity.** First source that applies: `Iroha-Session` header (the `iroha-` prefix is already stripped before forwarding, `attempt.go:55`); `x-claude-code-session-id`; the session inside Claude Code's `metadata.user_id` (JSON form and legacy `_session_` form); Codex `session_id`/`session-id`/`thread-id`; `x-session-id`; OpenCode `x-session-affinity`; body `session_id`; `prompt_cache_key`; else a hash of the system prompt/instructions, tool names and first user message (first few KB; never an empty prefix). Plain `user` is not a session. The value is combined with Gateway Key ID, Provider and model before use, so Callers can't steer each other. Work in every Shape.
- **Key order.** Within each group `planTier` already forms (`planner.go:318-330`: Endpoints of the Caller's Shape first, healthy before back-from-cooling, carriers first, exclusions unchanged), replace the round-robin order with rendezvous (highest random weight) hashing of the affinity value over the usable keys. Requests without an affinity value keep round-robin (there always is one, via the prefix hash, unless the prompt is empty). A key cooling/invalid/disabled/removed drops out, so its conversations move to their own second key; they return when it recovers. Pools keep member order; affinity applies inside each member. The route preview takes an optional affinity value.
- **Setting.** Per Provider: `affinity: on | off`, on by default for every Provider (Owner, 2026-11-20). Plus a global experiment switch `affinity_experiment: off | half` (default off): with `half`, conversations whose affinity hash falls in one bucket get affinity, the others round-robin, so ticket 01's stats can compare the two over a week. Record on each Request where the affinity came from (`header`, `claude_code`, `codex`, `opencode`, `session_id`, `prompt_cache_key`, `prefix`, `none`), whether affinity applied (or the experiment bucket), and whether the preferred key served. Show it on the Request's Details ("Key chosen for this conversation (Claude Code session)"), and filter Requests stats by it so the experiment's two halves can be compared.
- **Rate limits.** A 429 already cools the key; keep that. Measure per-key 429s before/after; bounded load (skip a preferred key with more than k in flight) only if tests or the experiment show a need: leave a note, don't build it speculatively.
- Docs: architecture.md subsection, served skill (how Callers can send `Iroha-Session`, what Iroha reads), glossary term, ticket 26 "key order" note updated.

**Blocked by:** none

**Status:** open

Ticket 01 runs at the same time and adds a Request column too (migration numbering: the second to merge renumbers). Ticket 03 builds on the affinity value (a derived `prompt_cache_key`); expose it from one function in the gateway package for 03 to call.

- [ ] Affinity value from every source listed, scoped by Gateway Key, Provider and model; Go tests per source and for Callers not steering each other
- [ ] Rendezvous order inside planTier's groups; deterministic second key on cooling and return after; round-robin without a value; Pools; Go tests incl. load still spread across many conversations
- [ ] Per-Provider setting (default on), experiment switch, per-Request source/bucket/preferred-served; stats filter; skill, OpenAPI, glossary
- [ ] UI: the setting on Provider Settings, the reason on Request Details; web tests; checked in headless Chrome light, dark, phone
