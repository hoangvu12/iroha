# Iroha v2

Status: ready-for-agent

## Problem Statement

The Owner runs Iroha v1, a self-hosted Gateway in front of many AI inference services, used by their own agents (Pi, OpenCode, Zeron fleets, CLIProxyAPI), a Discord bot and friends. Over three months every new provider or situation was bolted onto v1 as another special case, and it became a mess the Owner no longer trusts:

- Requests fail and nobody can tell whether the Provider or Iroha is at fault. Bun's idle limit, Cloudflare's 100-second cutoff and a retry loop that could walk 100+ keys interact, and Callers see bodiless 502s and "terminated".
- Models vanish "randomly". Whether a key can serve a model is decided by five overlapping mechanisms (Gateway Key scope, catalog provenance, per-key allow- and deny-lists, per-key discovered lists, per-key rewrites). A hand-added model became unroutable; the fix took three ADRs in one week and still needed a direct database edit. A model was hidden because external metadata could not prove it chats, and a 1M-context model was reported as 128k.
- Key status is opaque. The UI showed 5 invalid keys while 13 were answering 401. Health, capacity scopes, evidence and escalation windows are hard to reason about.
- Agents operate Iroha through about thirty one-off scripts, some of which reveal production keys. A forgotten scheduled task was silently deleting keys. Test calls are all logged as "Owner session".
- Gateway Keys are stored as hashes, so a lost key means issuing a new one.
- Deploys are a manual SSH ritual with a password typed into chats; the server is not even a git checkout.
- The UI is large (charts alone are 18.5k lines for an Overview page the Owner never uses), while the three pages the Owner does use (Providers, Gateway Keys, Requests) have weak spots: the Upstream Keys list is not a real table, the new Gateway Key dialog is poor, and the Requests page lacks context.
- Only 23 hours of history are kept, the route a request came in on is not recorded, and token usage is missing for almost every streamed request.

## Solution

A from-scratch rewrite, Iroha v2: one Go binary with SQLite and an embedded React UI, designed around a small domain model (see `GLOSSARY.md` and `docs/adr/`):

- Callers use any of four Shapes (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini) against any Provider. Iroha passes bytes through when the Endpoint speaks the caller's Shape and translates through one canonical form otherwise.
- A Provider has Endpoints (URL + Shape); Upstream Keys work on all or some of them. Model Pools give cross-Provider failover under one stable model name. Which key cannot serve which model is learned as an expiring Model Gap, never configured.
- Every Upstream Key is always in exactly one visible Key State (active, disabled, invalid, cooling) with the reason it got there.
- Provider quirks are Failure Rules: data, editable by agents at runtime.
- Each Request has a hard budget (3 Attempts, 60 s to first byte by default) and explains itself: every Attempt, the rule it matched, and a one-line summary.
- Agents are the primary operators: one HTTP admin API, described by an OpenAPI document and a skill the server serves itself, with dry runs, bulk operations, safe repeats, an audit trail and revert. Rich logs are readable through the API.
- Keys are stored readable. History retention is configurable (30 days by default).
- The UI is three redesigned pages: Providers (focus on the Upstream Keys table and a test chat), Gateway Keys (focus on the new-key dialog), Requests (maximum context).
- One deploy script, over SSH keys, with automatic rollback.

## User Stories

### Calling the Gateway

1. As a Caller, I want to send OpenAI Chat Completions requests to Iroha, so that OpenAI-compatible tools work unchanged.
2. As a Caller, I want to send OpenAI Responses requests, so that clients built on the Responses API work.
3. As a Caller, I want to send Anthropic Messages requests, so that Claude-style clients such as CLIProxyAPI and Claude Code work.
4. As a Caller, I want to send Gemini requests, so that Gemini-native clients work.
5. As a Caller, I want any Shape I use to reach any Provider regardless of the Shapes that Provider speaks, so that my choice of client never limits my choice of model.
6. As a Caller, I want my request passed through untouched when the Provider speaks my Shape, so that nothing is lost in translation.
7. As a Caller, I want to name a model as `provider/model` on the global routes, so that one base URL reaches every Provider I am allowed to use.
8. As a Caller, I want to name a Model Pool on the global routes, so that I get automatic failover across Providers under one stable name.
9. As a Caller, I want provider-scoped routes (`/providers/<handle>/v1/...`) with bare model names, so that existing configurations keep working.
10. As a Caller, I want everything after the first slash of a qualified model ID treated as the exact upstream model ID, so that aggregator IDs containing slashes work.
11. As a Caller, I want to authenticate with `Authorization: Bearer`, `x-api-key`, `api-key`, `x-goog-api-key` or the Gemini `key` query parameter, so that every client's default header works.
12. As a Caller, I want my own credentials never forwarded upstream, so that my Gateway Key cannot leak to a Provider.
13. As a Caller, I want streaming in every Shape, so that agents see tokens as they arrive.
14. As a Caller, I want tool calls, images, reasoning and structured output carried across Shapes, so that agents work the same through Iroha as directly.
15. As a Caller, I want reasoning effort settings translated between Shapes, so that reasoning levels work through Iroha.
16. As a Caller, I want the response to name the model I asked for, so that clients matching on model names do not get confused.
17. As a Caller, I want a model that is not on the Provider's list still forwarded, so that new releases and aggregator aliases work without configuration.
18. As a Caller, I want a clear error when every Attempt fails, listing what happened at each Attempt, so that I can tell whether to retry.
19. As a Caller, I want a request either to start answering or to fail within the time budget, so that Cloudflare never cuts me off with a 524.
20. As a Caller, I want long silences in a stream kept alive, so that intermediaries do not close my connection while a model is thinking.
21. As a Caller, I want errors that happen after streaming began delivered as an error event in my Shape, so that my client reports them properly.
22. As a Caller, I want to be refused with a uniform answer when I name a Provider, Pool or model outside my Gateway Key's scope, so that I cannot probe what exists.
23. As a Caller, I want `/v1/models` to list exactly the Pools and `provider/model` IDs my Gateway Key may use, so that my client shows the right choices.
24. As a Caller, I want each listed model to carry its context window, max output, input modalities, reasoning support and a chat flag, so that clients such as Pi and OpenCode configure themselves correctly.
25. As a Caller, I want every model marked as able to chat unless it is known not to, so that clients filtering on chat support do not hide working models.
26. As a Caller, I want `/v1/models` to answer quickly even with thousands of models, so that clients with short timeouts do not drop Iroha.
27. As a Caller, I want in-flight requests to finish when Iroha restarts, so that deploys do not cut my streams.

### Providers, Endpoints and Upstream Keys

28. As the Owner, I want to create a Provider with a unique, immutable handle, so that Callers can address it stably.
29. As the Owner, I want to give a Provider several Endpoints, each one URL speaking one Shape, so that regions, plan-specific URLs and Anthropic-compatible URLs of the same service live in one Provider.
30. As the Owner, I want each Endpoint to have its own auth style (bearer, `x-api-key`, a custom header, a query parameter, or none) and static headers, so that every provider's authentication works.
31. As the Owner, I want an Endpoint to rename models where its URL spells them differently, so that Callers use one name.
32. As the Owner, I want to restrict an Upstream Key to some Endpoints, so that plan-specific keys are only sent where they work.
33. As the Owner, I want to add Upstream Keys without secrets for Endpoints that need none, so that keyless services work.
34. As the Owner, I want to paste many Upstream Keys at once, one per line, so that adding keys is fast.
35. As the Owner, I want the Upstream Keys of a Provider in a real data table with sorting, filtering and search on every column, so that I can find the key I need.
36. As the Owner, I want to select many Upstream Keys and test, enable, disable, delete, restrict to Endpoints, clear Model Gaps or copy them in one action, so that managing dozens of keys is quick.
37. As the Owner, I want to read and copy any Upstream Key, so that I never have to dig for a secret.
38. As the Owner, I want each Upstream Key to show exactly one Key State and the reason it entered it, so that I always know why a key is not receiving traffic.
39. As the Owner, I want a key answering 401 or 403 for account reasons marked invalid until a test passes, so that dead keys stop wasting Attempts.
40. As the Owner, I want a key answering 429 or a quota error marked cooling until a known time, either for the whole key or for one model, so that one model's limit does not take the key down for all models.
41. As the Owner, I want cooling to escalate from one model to the whole key when the same key is refused for several distinct models in a short window, so that a key-wide limit is recognised.
42. As the Owner, I want cooling to honour reset times the Provider reports, so that keys come back exactly when they can.
43. As the Owner, I want a key refused a specific model to get a Model Gap for that model instead of a state change, so that it keeps serving its other models.
44. As the Owner, I want Model Gaps to clear themselves after 24 hours, when the key's model list shows the model, or when the key is tested or edited, so that a plan upgrade is picked up without my help.
45. As the Owner, I want to see and clear Model Gaps, so that I can override what Iroha learned.
46. As the Owner, I want a key test to make a tiny real chat call, so that a dead account answering 200 on `/models` is not reported healthy.
47. As the Owner, I want nothing in the background ever to delete or disable a key, so that keys only change from real traffic or explicit actions.
48. As the Owner, I want to disable, enable and archive Providers, so that I can retire a Provider without losing its configuration or handle.
49. As the Owner, I want per-Provider overrides of the Attempt budget and the time to first byte, so that slow Providers get more room while every Request stays under the edge cutoff.
50. As the Owner, I want the Providers list to be a simple searchable list of names, so that I can jump to the Provider I want.

### Models

51. As the Owner, I want each Provider's model list discovered from its Endpoints, so that new models appear without my help.
52. As the Owner, I want an Endpoint to have its own discovery URL or none, so that providers with odd or missing `/models` routes work.
53. As the Owner, I want to choose whether a Provider's models are discovered once for the Provider or per key, so that providers whose keys see different models are handled and providers with many identical keys are not hammered.
54. As the Owner, I want per-key discovered lists only to put known carriers first and never exclude a key, so that under-reporting providers keep their hidden capacity.
55. As the Owner, I want to add a model by hand and have it stay until I remove it, so that a refresh never silently deletes my addition.
56. As the Owner, I want to hide any model, including one never discovered, so that I control what Callers see.
57. As the Owner, I want to mark a Provider strict so that unlisted models are refused before any Attempt, so that typos fail fast where I prefer it.
58. As the Owner, I want to reset a Provider's discovered models without recreating the Provider, so that a polluted list can be cleaned without breaking Gateway Key scopes.
59. As the Owner, I want model metadata taken from my override first, then the Provider's own list, then models.dev, so that the best available facts win.
60. As the Owner, I want models.dev matching to be exact or near-exact only (dot-versus-dash versions, a bare name with a single numbered release), so that a model never inherits a sibling's limits.
61. As the Owner, I want models.dev looked up by the Provider's brand rather than its handle, so that relay-style handles still get facts.
62. As the Owner, I want metadata never to decide whether a model is listed or routable, so that missing metadata never hides a model.
63. As the Owner, I want to override any model's metadata, so that I can fix a wrong context window myself.

### Model Pools

64. As the Owner, I want to create a Model Pool with a name and an ordered list of Provider models, so that Callers get automatic cross-Provider failover.
65. As the Owner, I want a Pool request to try the first Provider's keys and then move down the list within the Request's budget, so that failover is automatic but bounded.
66. As the Owner, I want to reorder a Pool's members, so that I can change preference without touching Callers.
67. As the Owner, I want Pool names to be stable even as members change, so that clients caching model lists keep working.
114. As the Owner, I want to see where a request for a Pool or a Provider's model would go right now (members and Endpoints in order, ready keys, and every skipped key with its reason such as "cooling, 40 s left" or "Model Gap"), without sending anything, so that I know how traffic will flow before it arrives.
115. As an agent, I want the same route preview through the admin API, so that I can check routing after a change.
116. As the Owner, I want every Provider to show a logo found from its logo domain, which I can change, so that Providers are recognisable at a glance.
117. As the Owner, I want every Model Pool to show the logo of its model's maker, guessed from the model name and changeable, drawn differently from Provider logos, so that Pools and Providers are never confused.

### Gateway Keys

68. As the Owner, I want to issue a Gateway Key to a Caller with a name, so that every Request is attributed to it.
69. As the Owner, I want to restrict a Gateway Key to chosen Providers and Pools, and optionally chosen models within each, so that friends only use what I share.
70. As the Owner, I want to read and copy any Gateway Key at any time, so that I never need to re-issue a key someone lost.
71. As the Owner, I want to revoke a Gateway Key, so that I can cut off a Caller.
72. As the Owner, I want a clear, well-designed dialog for creating a Gateway Key and choosing its scope, so that issuing a key is quick and correct.
73. As the Owner, I want to see when each Gateway Key was last used and how many Requests it made recently, so that I know who is active.
74. As the Owner, I want to turn on full prompt and response capture per Gateway Key, so that I can debug my own clients without storing friends' conversations.

### Requests, Attempts and logs

75. As the Owner, I want every Request recorded with its caller, route, Shape in and out, requested model, serving Provider, Endpoint and wire model, status, time to first token, total time, token usage and Attempt count, so that I have full context.
76. As the Owner, I want token usage recorded for streamed Requests too, so that usage numbers are real.
77. As the Owner, I want each Attempt recorded with its Endpoint, key, status, matched Failure Rule, action taken and the upstream error body and headers on failure, so that every failure explains itself.
78. As the Owner, I want a one-line summary for every Request with more than one Attempt, so that I can read what happened at a glance.
79. As the Owner, I want a live Requests feed with filters by caller, Provider or Pool, model, status and time, so that I can watch traffic and find problems.
80. As the Owner, I want test Requests attributed to a "Test" caller, so that tests never masquerade as someone else.
81. As the Owner, I want history retention configurable, defaulting to 30 days, so that I can investigate last week's failures.
82. As the Owner, I want captured prompts kept for a configurable short time, defaulting to 3 days, so that capture does not grow without bound.
111. As the Owner, I want a stats row above the Requests feed (Requests, succeeded, retried, median duration, median time to first token, tokens) for the current filters, so that I see the shape of traffic at a glance.
112. As the Owner, I want to hide and show Requests columns, with failed rows tinted and retried Requests marked, so that the feed stays readable while carrying every fact.
113. As the Owner, I want a Request's route drawn as a top-to-bottom chain of Attempt cards, each connection labelled with why Iroha moved on, with the selected card's details beside it, so that I can follow what happened at a glance.

### Testing models

83. As the Owner, I want one shared test chat panel on the right, openable from any page (sidebar and a keyboard shortcut) and expandable to full page, where the composer's model button sets model, Provider, Upstream Key (any or one), Endpoint, Shape, reasoning level and a tool-call check, so that I can try exactly the path a Caller would take without leaving what I am looking at.
84. As the Owner, I want the chat to give me a ready-to-copy snippet in curl, Python and TypeScript for the current settings, so that I can wire up a client quickly.
85. As the Owner, I want to hold a multi-turn streamed chat in that panel, with a collapsed details block under each reply (serving key, timings, tokens, tool-call result), so that I can test real conversations rather than a single "hello".
86. As the Owner, I want Test buttons on Providers, Model Pools, key rows, past Requests and Gateway Keys that open the chat already filled in (that Provider, that Pool, that key, a replay of that prompt, or sending as that Gateway Key with its scope), so that I never set it up by hand.
87. As the Owner, I want a failed test to show the same Attempt explanation as the Requests page, so that I see why it failed.
109. As the Owner, I want a chat sent as a Gateway Key recorded under "Test (as <key name>)", using that key's scope but never counted as that Caller's own traffic, so that tests never inflate a friend's usage.
110. As the Owner, I want earlier test chats listed so that I can reopen one, so that a useful test is not lost.

### Agents operating Iroha

88. As an agent, I want to read a skill document served by the running Iroha, so that my instructions always match the deployed version.
89. As an agent, I want a complete OpenAPI description of the admin API, so that I never guess routes.
90. As an agent, I want to address Providers, Endpoints, keys, Pools, Gateway Keys and rules by handle or name, so that I do not need to look up IDs first.
91. As an agent, I want every change to accept a dry run that reports exactly what would change, so that I can check before acting.
92. As an agent, I want bulk versions of changes with per-item results, so that one call handles forty keys and partial failure is visible.
93. As an agent, I want creates to be safe to repeat (create-or-update by name), so that re-running my work does not make duplicates.
94. As an agent, I want errors to say what to do next, so that I can recover without a human.
95. As an agent, I want to read Iroha's structured logs through the API with filters by time, level, Request, Provider and kind, so that I can diagnose problems without SSH.
96. As an agent, I want to read a Request's full explanation through the API, so that I can turn a new failure into a Failure Rule.
97. As an agent, I want to add or override Failure Rules through the API, with a dry run against recent failed Attempts, effective without a restart, so that I can handle a new provider quirk immediately.
98. As an agent, I want a Provider summary (key-state counts, cooling until, Model Gaps), so that I can answer "what is wrong with this Provider" in one call.
99. As an agent, I want to trigger a model refresh and a key test through the API, so that I never need a one-off script on the server.
100. As the Owner, I want every change recorded as an Audit Entry naming the Admin Token or session that made it, so that I know which agent did what.
101. As the Owner, I want to revert any Audit Entry, so that I can undo an agent's mistake.
102. As the Owner, I want to create named Admin Tokens with full access, read them and revoke them, so that each agent has its own identity.

### Running Iroha

103. As the Owner, I want Iroha to be one binary with the UI and a SQLite file beside it, so that it runs anywhere with nothing else installed.
104. As the Owner, I want to log in to the UI with a password and stay signed in for 30 days, so that I am not bothered.
105. As the Owner, I want a deploy script that builds, copies, backs up the database, swaps the binary, restarts the service, checks health and rolls back on failure over SSH keys, so that an agent can deploy safely.
106. As the Owner, I want liveness and readiness endpoints, so that the deploy script and monitoring can check Iroha.
107. As the Owner, I want background work limited to a daily, staggered model refresh and an hourly retention cleanup, each logged, so that nothing surprising runs.
108. As the Owner, I want to import my v1 Providers, Upstream Keys and Gateway Key definitions into v2 through the admin API, re-issuing each Gateway Key once, so that cutover is quick.

## Implementation Decisions

### Domain model (see `GLOSSARY.md`)
- Owner, Caller, Gateway Key, Admin Token, Gateway, Provider, Endpoint, Shape, Model Pool, Upstream Key, Key State, Cooling, Model Gap, Failure Rule, Request, Attempt, Audit Entry. No Upstream Accounts, no Management Key scopes, no Provider Templates as runtime entities.
- Provider: handle (unique, immutable, reserved even when archived), display name, enabled/archived, strict flag, discovery mode (none / per Provider / per key), models.dev brand, budget overrides.
- Endpoint: belongs to one Provider; URL (including any version path), Shape, auth style (bearer, `x-api-key`, custom header name, query parameter, none), static headers, optional discovery URL or "no discovery", optional model renames (Caller-facing name to wire name).
- Upstream Key: belongs to one Provider; name, secret (may be empty), optional restriction to a subset of Endpoints, Key State with reason and timestamps.
- Key State: `active`, `disabled` (Owner), `invalid` (account refusal; cleared by a passing test or a secret change), `cooling` until T, scoped to the key or to one key-and-model pair. Escalation from pair to key when one key is refused for 3 distinct models within 5 minutes, or on account-level signals.
- Model Gap: key, model, reason, created, expires (created + 24 h). Cleared on key test, key edit, the key's discovered list including the model, or by hand.
- Model list entry per Provider: model ID, discovered (flag, with which keys or Endpoints listed it), added by Owner (flag), hidden (flag), reported metadata, external metadata, Owner overrides. Discovery never touches the Owner flag; an entry is removed only when no flag keeps it.
- Model Pool: name (no slash, unique across Pools), ordered members of (Provider, model), optional budget override.
- Gateway Key: name, readable secret, scope (all, or a set of Providers and Pools, each optionally narrowed to models), capture flag, revoked.
- Admin Token: name, readable secret, revoked. Full access.
- Secrets (Gateway Keys, Upstream Keys, Admin Tokens) are stored readable (ADR-0006).

### Request handling
- Routes: global `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`, Gemini `/v1beta/models/{model}:generateContent` and `:streamGenerateContent`; provider-scoped equivalents under `/providers/<handle>/`. The route and Shape are recorded on every Request.
- Model addressing: a global model is either a Pool name or `handle/model` split at the first slash. An unqualified name that is not a Pool is refused with a hint. Out-of-scope or unknown Providers, Pools and models get one uniform refusal.
- Candidate planning is one deep module: given the Request (caller scope, Shape, model or Pool) plus configuration, Key States, Model Gaps, discovered lists and the clock, it yields an ordered list of (Provider, Endpoint, key, wire model). Order: Pool member order; within a Provider, Endpoints speaking the caller's Shape first, then active keys that are known carriers, then other active keys, round-robin within each tier. Excluded: disabled and invalid keys, keys cooling for the key or the key-and-model pair, keys with a live Model Gap, keys not allowed on that Endpoint. If nothing remains, the Request fails immediately with an error that distinguishes "nothing can ever serve this" from "everything is cooling until T".
- Budget: default 3 Attempts and 60 s to first upstream byte per Request (across Pool members), overridable per Provider and per Pool, never above a hard ceiling of 95 s. An Attempt that exhausted its time is not replayed on the same key.
- Streaming: if no upstream byte has arrived after a short wait, Iroha commits the response (status and headers) and sends keep-alive comments; after commitment, failures are sent as an error event in the Caller's Shape. Before commitment, failures return a proper HTTP status with the Attempt summary.
- Shapes (ADR-0004): passthrough when the Endpoint speaks the Caller's Shape (only model name, auth and headers change; per-Attempt model rename after the Endpoint is chosen); otherwise translate request and response, including streams, through one canonical form via a third-party library behind one interface (RelayKit or Bifrost core, picked by golden tests).
- Response normalisers, in Go, for behaviour that rewrites content: moving `<think>` text into reasoning, flattening non-standard content blocks, dropping fields a Provider rejects on replayed turns (such as Anthropic message IDs to OpenAI-shaped or Mistral endpoints). Applied on both passthrough and translated paths and on streamed error bodies.
- The response's model field echoes the Caller's requested name; the served model is recorded on the Attempt.
- Caller credentials are stripped before forwarding; Endpoint auth is applied per its auth style; keyless Endpoints send no auth header.
- Token usage is extracted from every Shape, streamed or not (requesting usage in streams where the upstream needs it).
- Graceful drain on shutdown.

### Failure handling (ADR-0005)
- Every failed Attempt is classified by Failure Rules: match on Provider (or global), status, error code, body text and headers; outcome is one of `invalid`, `cooling key`, `cooling key+model`, `model gap`, `retry elsewhere`, `fail request`, with optional cooling duration or a reset time extracted from the response.
- Built-in rules ship in the binary and cover every provider quirk in `docs/research/v1-case-catalog.md`. Owner rules override built-ins by name. Generic fallbacks: 401/403 auth → invalid; 429 → cooling key+model with `Retry-After`; 5xx and network → retry elsewhere; 400 → fail request.
- Rules are managed through the admin API with a dry run that replays recent failed Attempts and reports matches.
- Cooling without a known reset time defaults to 60 s and doubles on repeats up to 1 hour.

### Models and metadata
- Discovery per Endpoint (or per key when the Provider is per-key), accepting `data` or `models` arrays; failures keep the previous list and are logged.
- Metadata precedence: Owner override, Provider-reported (normalising common field aliases, OpenRouter's nested fields, numeric strings), models.dev (exact, dot-versus-dash, bare name with a single numbered release; looked up by the Provider's models.dev brand; cached; failure leaves fields blank).
- `/v1/models` entries carry context window, max input, max output, input and output modalities, reasoning support and levels where known, and `chat:"ok"` unless known not to chat. Served from one batched read.

### Admin API (ADR-0007)
- REST under `/api/`, JSON, Admin Token bearer or Owner session. Resources: providers, endpoints, keys, models, pools, gateway keys, admin tokens, rules, requests, logs, audit, settings, jobs, test.
- Addressing by handle or name everywhere, IDs also accepted.
- Every mutating call accepts `dry_run`; bulk endpoints return per-item results; creates are create-or-update by name.
- Errors carry a machine code, a message and a hint naming the next action.
- Every mutation writes an Audit Entry (actor, before, after); `revert` restores the before-state.
- `GET /skill.md` serves the agent skill; `GET /api/openapi.json` serves the description. Both are generated or checked from the same route definitions so they cannot drift.
- Provider summary endpoint: key-state counts, cooling-until times, Model Gaps, recent failure rate.
- Route preview endpoint: for a Pool or `provider/model` (optionally as a Gateway Key), runs candidate planning without sending and returns members, Endpoints and keys in order, with each excluded key's reason and until-time.
- Test endpoint backing the chat: sends a Request as the Test caller, optionally pinned to one key or Endpoint, optionally "as" a Gateway Key (its scope applies; recorded as "Test (as <name>)" and excluded from that key's usage).

### Logs and history
- Structured log events for every Attempt, rule match, Key State change, Model Gap, discovery run, job run, configuration change, startup and shutdown; written to stdout and to a queryable store; read through the logs API with filters.
- Request and Attempt history, failure bodies and headers always; full prompt and response capture only for Gateway Keys with capture on.
- Retention settings per kind (history and logs default 30 days, captures default 3 days), enforced by an hourly job.

### Background jobs
- Daily model refresh per Provider, start times spread across the day. Hourly retention cleanup. Nothing else. No job changes or deletes keys.

### UI
- React single-page app embedded in the binary, consuming only the public admin API. The design to build is `.scratch/v2-gateway/design/v2-clean/` (calm style: one line per row, few columns, one main button, no dot-chained text); earlier sets in `design/` and `design/v2-directions/` are superseded.
- Shell: sidebar with the Iroha banner art and avatar, a health status, Providers / Gateway Keys / Requests / Chat with keyboard shortcuts, and the Owner row.
- Providers: list with logos and Model Pools (Pools drawn with maker-logo tiles). Provider detail tabs: Keys (primary data table, bulk actions, paste keys), Endpoints, Models, Rules, Settings (name, logo domain, enabled). Model Pool detail: Route (live route preview) and Members (order, on/off).
- Shared test chat: a right-side panel available on every page, expandable to full page, not modal, no tabs; settings behind the composer's model button; filled in by Test buttons; earlier chats in a dropdown.
- Gateway Keys: list, a create dialog (name; Everything or Only some Providers and Pools, each Provider narrowable to models) and a key page holding settings such as prompt capture and a danger zone.
- Requests: stats row for the current filters, live feed with configurable columns, a drawer with Details, Attempts and Captured tabs stepping with arrow keys, and a full-page Route view (chain of Attempt cards).
- Settings: Admin Tokens and Audit Entries (with revert), reached from the Owner row.
- Confirmation: only delete and revoke ask first (revoke requires typing the name); disable, enable and clearing Model Gaps act at once and offer Undo through Audit revert.
- Phone: the sidebar becomes a bottom tab bar; Settings sits behind the avatar.
- Logos: Providers by logo domain (Owner-editable); Pools by the model maker inferred from the model name (Owner-editable). Fetched through Iroha, never hot-linked from the browser to third parties.
- Owner login with a password; sessions last 30 days.

### Operations
- One binary for Linux, SQLite file beside it, systemd unit, liveness and readiness endpoints.
- Deploy script over SSH keys: build, copy, back up the database, swap, restart, health check, automatic rollback. No source checkout on the server.

### Migration from v1
- Done by an agent through the v2 admin API. Providers and Upstream Keys are imported (v1 per-key base URLs become Endpoints with keys restricted to them). Gateway Keys are recreated with the same names and scopes and new secrets, which the Owner hands out once. Upstream Accounts, request history, audit history and Management Keys are not imported.

## Testing Decisions

- One seam: the running server over HTTP. Tests start Iroha in-process on a temporary SQLite file, drive it only through its public HTTP routes (inference, admin, UI-facing), and stand up programmable fake upstream servers per Shape that script responses, errors, delays and streams. Time is injected so cooling, Model Gap expiry and budgets are testable without sleeping.
- Tests assert external behaviour: what the Caller receives, what the fake upstream received, and what the admin API reports (Key States, Model Gaps, Requests, Attempts, logs, Audit Entries). No tests of internal functions unless a module is deep and pure (candidate planning, Failure Rule matching, metadata precedence), where table tests of its public interface are welcome.
- Shape translation gets golden tests: recorded request and response pairs (including streams, tools, images, reasoning) per Shape pair, used both to choose the translation library and to guard regressions.
- Conformance: every essential behaviour and provider quirk in `docs/research/v1-case-catalog.md` is mapped to a test or marked not applicable with a reason in a checklist kept beside the spec.
- Prior art: v1's HTTP-seam tests (`test/support/app.ts` on branch `main`) show the style; its fixtures describe many provider responses worth porting.
- UI: no DOM unit tests; behaviour lives behind the API. A small browser smoke test of the three pages is optional.

## Out of Scope

- A CLI or MCP server (may be added later as thin clients).
- Postgres or any second database.
- Balance or usage polling of Providers (DeepAI, MiniMax, Z.ai and others).
- Gateway Key rate or token limits.
- CORS origins on Gateway Keys.
- Overview page and charts (beyond the Requests stats row).
- Upstream Accounts and Management Key scopes.
- Multiple Owners or tenants.
- Any pipeline for gathering Upstream Keys from third parties; Iroha only holds keys the Owner is entitled to use.
- Importing v1 request history.

## Further Notes

- The network path (Cloudflare's 100-second cutoff, packet loss from the Owner's ISP, a changing home IP) is the largest recurring pain and is outside Iroha's control; v2 only mitigates it through budgets and keep-alives.
- The Owner should change the server password that was pasted into chats and switch to SSH keys before the deploy script is used.
- Research: `docs/research/language-and-prior-art.md`, `docs/research/v1-case-catalog.md`, `docs/research/history-other-devices.md`.
