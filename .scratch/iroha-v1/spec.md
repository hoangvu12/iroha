Status: ready-for-agent

# Iroha v1

## Problem Statement

The Owner uses multiple OpenAI-compatible AI Providers, often with several Upstream Keys per account, and needs a single self-hosted way to use them from ordinary OpenAI clients. Today the Owner must manage different base URLs, credentials, model catalogs, quota states, plan usage, and failure behavior independently. When a key becomes invalid, exhausted, or rate-limited, applications fail even when another eligible key is available. Provider and model-name overlap also makes implicit routing unsafe.

The Owner needs explicit Provider Connection selection, automatic but explainable key selection and recovery, secure Gateway Keys for applications, and an occasional-use management UI that surfaces failures without storing prompts or responses. The system must be deployable as a normal Bun application with either SQLite or PostgreSQL and must not depend on nyanis or discovered third-party credentials.

## Solution

Build Iroha as a single-owner, self-hosted OpenAI-compatible Gateway. Each configured Provider Connection receives an immutable ID and a provider-scoped OpenAI base URL. Applications keep exact upstream model IDs and authenticate with scoped Gateway Keys. Iroha selects an eligible Upstream Key round-robin, classifies failures at their actual Capacity Scope, persists meaningful Key Health, and performs bounded retries without retrying after streamed output begins.

Provide a database-backed management UI and admin API for Provider Connections, Upstream Accounts, Upstream Keys, model catalogs, Usage Adapters, Gateway Keys, request metadata, audit history, and global settings. Use typed Inference and Usage Adapters for provider-specific behavior and data-only Provider Templates for ordinary compatible Providers. Support Chat Completions, Responses, Models, streaming, tools, structured output, cancellation, OpenAI-shaped errors, and authenticated Provider Directory discovery.

## User Stories

1. As the Owner, I want to run one self-hosted Gateway, so that my applications can reach multiple Providers through one service.
2. As the Owner, I want to select SQLite or PostgreSQL with `DATABASE_URL`, so that I can choose a simple local database or a managed database.
3. As the Owner, I want startup to reject unsupported database schemes, so that a configuration typo cannot silently select the wrong storage behavior.
4. As the Owner, I want pending migrations applied before the server accepts traffic, so that upgrades do not run against a stale schema.
5. As the Owner, I want all currently missing required configuration reported together, so that deployment does not require repeated restart-and-fix cycles.
6. As the Owner, I want a setup token to protect first-run registration, so that a stranger cannot claim a newly exposed installation.
7. As the Owner, I want setup permanently closed after my account exists, so that the setup flow cannot replace me.
8. As the Owner, I want normal username-and-password login, so that I do not use an environment secret for daily access.
9. As the Owner, I want optional browser-based recovery protected by an environment token, so that I can reset access on hosting panels without a shell.
10. As the Owner, I want recovery to revoke existing sessions, so that a compromised session cannot survive a password reset.
11. As the Owner, I want to list and revoke my sessions, so that I can remove access from devices I no longer trust.
12. As the Owner, I want upstream secrets encrypted at rest, so that copying only the database does not immediately reveal Provider credentials.
13. As the Owner, I want Iroha to require a stable master key, so that encrypted Upstream Keys remain usable across restarts.
14. As the Owner, I want to create a Provider Connection from a known template, so that common Provider defaults are prefilled.
15. As the Owner, I want to create a custom OpenAI-compatible Provider Connection, so that I can use compatible services Iroha does not know by brand.
16. As the Owner, I want each Provider Connection to have an immutable ID and editable display name, so that client URLs remain stable while labels can improve.
17. As the Owner, I want to duplicate a Provider Connection under a new ID, so that I can create another account or server without mutating an existing client contract.
18. As the Owner, I want only essential fields in the default Provider form, so that routine setup is not overwhelmed by advanced transport settings.
19. As the Owner, I want advanced authentication, headers, model paths, capabilities, redirects, timeouts, and retries available separately, so that unusual compatible Providers remain configurable.
20. As the Owner, I want HTTPS required by default, so that Upstream Keys are not accidentally sent over plaintext connections.
21. As the Owner, I want to explicitly allow insecure HTTP for a private or local Provider Connection, so that local vLLM-style servers remain usable.
22. As the Owner, I want a persistent warning on insecure connections, so that the security exception stays visible.
23. As the Owner, I want redirects rejected by default and same-origin redirects optionally allowed, so that Upstream Keys cannot leak across origins.
24. As the Owner, I want to archive a Provider Connection before permanent purge, so that an accidental deletion does not erase diagnostic history.
25. As the Owner, I want multiple Upstream Keys on one Provider Connection, so that traffic can use all capacity I own.
26. As the Owner, I want new Upstream Keys saved as Unverified before validation, so that a temporary validation failure does not force me to re-enter a hidden secret.
27. As the Owner, I want a low-cost adapter-defined key test, so that I can establish whether a key is usable.
28. As the Owner, I want to activate an inconclusively tested key manually, so that an unavailable validation endpoint does not block inference.
29. As the Owner, I want per-key model allow and exclude rules, so that Iroha does not send a model to a credential that cannot use it.
30. As the Owner, I want learned model-specific denials to affect only that key/model pair, so that one permission failure does not disable the whole key.
31. As the Owner, I want to group keys into an Upstream Account, so that Iroha knows when keys share billing or quota.
32. As the Owner, I want the UI to explain Upstream Accounts in plain language, so that I understand why grouping changes eligibility.
33. As the Owner, I want independent keys to remain ungrouped by default, so that simple setups require no account modeling.
34. As the Owner, I want Active keys selected round-robin, so that normal traffic is distributed predictably.
35. As the Owner, I want round-robin to consider only keys eligible for the requested model and current Capacity Scope, so that known-bad attempts are avoided.
36. As the Owner, I want Key Health persisted across restarts, so that restarting does not spray traffic through known invalid or cooling keys.
37. As the Owner, I want to see whether a key is Unverified, Active, Cooling Down, Invalid Authentication, Exhausted, or Disabled, so that routing behavior is explainable.
38. As the Owner, I want the last success, failure reason, and recovery time visible, so that I can decide whether intervention is needed.
39. As the Owner, I want a manual Test action, so that I can retry a repaired key on demand.
40. As the Owner, I want expired cooldowns recovered with one controlled real request, so that Iroha does not restore a failing key to full traffic immediately.
41. As the Owner, I want authoritative Usage Adapter evidence to reactivate capacity when available, so that recovery need not wait for a paid inference request.
42. As the Owner, I want no automatic paid background inference probes, so that health checking does not consume unexpected quota.
43. As the Owner, I want key, account, connection-and-model, provider-wide, and unknown Capacity Scopes distinguished, so that Iroha skips the correct resources.
44. As the Owner, I want an unknown rate-limit scope to try at most one alternate key, so that Iroha does not stampede keys that share account capacity.
45. As the Owner, I want invalid credentials rotated immediately without backoff, so that another eligible key can serve the request.
46. As the Owner, I want known exhausted credentials skipped until recovery, so that the Gateway does not repeatedly call a depleted account.
47. As the Owner, I want ambiguous `403` responses treated conservatively, so that a model permission denial does not globally invalidate a key.
48. As the Owner, I want explicit retryable upstream server errors retried with bounded backoff, so that short outages can recover.
49. As the Owner, I want ambiguous connection resets and timeouts not retried by default, so that I avoid duplicate inference charges.
50. As the Owner, I want ambiguous network retries configurable by Provider Connection, so that I can favor availability where duplicate work is acceptable.
51. As the Owner, I want validation errors returned without retries, so that one bad request is not multiplied across my keys.
52. As the Owner, I want global retry defaults and Provider Connection overrides, so that unusual Providers can use appropriate limits.
53. As the Owner, I want retry attempts and total retry time bounded, so that failover cannot create unbounded latency or cost.
54. As the Owner, I want non-idempotent requests protected from unsafe retries, so that Iroha does not duplicate stored upstream resources.
55. As the Owner, I want caller idempotency values preserved, so that supported Providers can deduplicate attempts.
56. As the Owner, I want generated idempotency values only for adapters that declare them safe, so that Iroha does not invent unsupported guarantees.
57. As an application developer, I want to choose a Provider Connection in the base URL, so that routing is explicit even when Providers share model names.
58. As an application developer, I want the exact upstream model ID forwarded unchanged, so that I do not manage Iroha-specific aliases.
59. As an application developer, I want ordinary OpenAI Chat Completions support, so that existing OpenAI clients can use Iroha.
60. As an application developer, I want ordinary OpenAI Responses support, so that newer OpenAI client workflows can use Iroha.
61. As an application developer, I want streaming for Chat Completions and Responses, so that tokens and events arrive incrementally.
62. As an application developer, I want tool calls and structured output preserved, so that compatible model features continue to work.
63. As an application developer, I want unknown supported-request JSON fields forwarded, so that Provider extensions and newer fields do not require an immediate Iroha release.
64. As an application developer, I want cancellation to abort the active upstream request, so that abandoned work stops consuming quota.
65. As an application developer, I want Iroha never to retry after streamed bytes reach me, so that one response cannot contain mixed attempts.
66. As an application developer, I want OpenAI-shaped errors with stable Iroha codes, so that my SDK can handle failures consistently.
67. As an application developer, I want a request ID in every response, so that I can correlate a failure with Owner-visible metadata.
68. As an application developer, I want a useful `Retry-After` when no credential can recover before a known time, so that my client can wait appropriately.
69. As an application developer, I want provider-scoped Models responses, so that I can discover exact models on the connection I selected.
70. As an application developer, I want unknown cached models forwarded by default, so that a stale or incomplete catalog does not block valid inference.
71. As an application developer, I want my Gateway Key's model restrictions enforced even for unknown catalog entries, so that access policy remains authoritative.
72. As the Owner, I want model catalogs synchronized after configuration changes, periodically, and manually, so that discovery stays useful.
73. As the Owner, I want the last good model catalog retained after synchronization failures, so that discovery remains available during transient errors.
74. As the Owner, I want catalog provenance and staleness visible, so that I know whether a model came from the Provider, a template, or my override.
75. As the Owner, I want Provider Connection capability defaults and model-specific overrides, so that Responses, tools, and structured output are represented accurately.
76. As the Owner, I want no automatic paid capability probes, so that capability discovery cannot create surprise usage.
77. As the Owner, I want known Usage Adapters for credit balance and coding-plan or subscription usage, so that I can see authoritative capacity where Providers expose it.
78. As the Owner, I want custom Providers to show authoritative balance as Unknown, so that missing billing integration is never mistaken for zero balance.
79. As the Owner, I want usage results to include scope, units, freshness, and authority, so that I can interpret them correctly.
80. As the Owner, I want usage polling after changes, periodically, and manually, so that capacity information recovers without constant Provider calls.
81. As the Owner, I want usage polling to respect Provider limits and retain its last good result, so that the poller does not create another outage.
82. As the Owner, I want to generate Gateway Keys for my applications, so that applications never receive Upstream Keys.
83. As the Owner, I want Gateway Key plaintext revealed only once, so that Iroha does not retain usable downstream secrets.
84. As the Owner, I want to name, revoke, and inspect last use of Gateway Keys, so that application access remains manageable.
85. As the Owner, I want a Gateway Key restricted to Provider Connections and optional models, so that each application has only the access it needs.
86. As an application developer, I want authenticated Provider Directory discovery, so that my application can list only the connections and models it may use.
87. As the Owner, I want Provider Directory responses to omit base URLs, balances, secrets, and internal health, so that discovery does not leak control-plane data.
88. As the Owner, I want cross-origin inference disabled by default, so that browser use requires deliberate authorization.
89. As the Owner, I want explicit CORS origins globally or per Gateway Key, so that approved browser applications can call Iroha safely.
90. As the Owner, I want the management UI and API same-origin only, so that administrative actions have a smaller browser attack surface.
91. As the Owner, I want request metadata without prompts or responses, so that I can diagnose routing while preserving inference privacy.
92. As the Owner, I want metadata to include connection, model, selected key identity, latency, status, usage, and retry trail, so that failures are explainable.
93. As the Owner, I want request-history retention configurable and disableable, so that I control storage and privacy tradeoffs.
94. As the Owner, I want configuration changes audited without secret values, so that I can reconstruct operational changes.
95. As the Owner, I want audit history retained until I explicitly clear it, so that low-volume administrative evidence remains available.
96. As the Owner, I want model sync, usage polling, cooldown recovery, retention cleanup, and session cleanup to report their last outcome, so that failed background work is visible.
97. As the Owner, I want liveness and readiness endpoints, so that a hosting platform can manage the Iroha process.
98. As the Owner, I want Provider outages excluded from readiness, so that an upstream outage does not trigger restart loops.
99. As the Owner, I want graceful shutdown, so that deployments stop new work, drain active requests within a deadline, and close storage cleanly.
100. As the Owner, I want UTC persisted and my browser timezone displayed, so that logs remain comparable and readable.
101. As the Owner, I want an optional authenticated metrics endpoint, so that I can monitor bounded-cardinality traffic and health outside the UI.
102. As the Owner, I want an exception-first Overview, so that the few visits I make lead directly to action.
103. As the Owner, I want attention rows, compact summaries, one request trend, one health distribution, and recent failures rather than a grid of generic cards, so that the UI feels like an operations workspace.
104. As the Owner, I want Providers, Gateway Keys, Requests, Audit, and Settings as clear primary areas, so that occasional tasks are easy to find.
105. As the Owner, I want connection-level views for keys, models, usage, logs, and settings, so that related operations stay local.
106. As the Owner, I want light, dark, and system themes, so that the UI fits my working environment.
107. As the Owner, I want desktop-focused editing and functional mobile workflows, so that I can inspect or repair Iroha from my phone when necessary.
108. As a developer, I want generated interactive OpenAPI documentation for discovery and admin APIs, so that custom Iroha endpoints are inspectable.
109. As a developer, I want deterministic tests that require no real Provider keys, so that the suite is safe and reproducible.
110. As a maintainer, I want SQLite and PostgreSQL to pass the same repository contract, so that supported database behavior does not drift.
111. As a maintainer, I want the official OpenAI JavaScript SDK exercised against Iroha, so that compatibility is established at the client boundary.
112. As a maintainer, I want secret-redaction coverage across errors, logs, audit, and responses, so that adding diagnostics cannot expose credentials.

## Implementation Decisions

- Iroha is a standalone single-context system and has no runtime or database dependency on nyanis.
- Version one is a single process and single Owner. Horizontal replication, distributed scheduling, and tenancy are excluded.
- Bun is the official runtime. Elysia owns HTTP routing, typed route schemas, generated OpenAPI documentation, health endpoints, and static frontend serving.
- The management frontend uses a fresh Vite, React, TypeScript, and shadcn initialization. It recreates nyanis's Geist typography, neutral OKLCH palette, compact density, blue active accent, Lucide iconography, table behavior, status language, and useful chart primitives without copying nyanis's dashboard composition.
- The Overview uses a continuous divider-led operations layout. It reserves bordered surfaces for interactive tables and purposeful charts rather than wrapping every statistic in a card.
- Drizzle backs a database repository boundary with separate SQLite and PostgreSQL schemas and migration histories. Database-specific types do not escape persistence modules.
- `DATABASE_URL` and `IROHA_MASTER_KEY` are always required. `IROHA_SETUP_TOKEN` is required only before an Owner exists. Recovery token, host, and port are optional.
- Startup detects SQLite from `file:` and PostgreSQL from `postgres://` or `postgresql://`, rejects other schemes, reports all current configuration errors together, and applies migrations before listening.
- SQLite and PostgreSQL are deployment-time choices. Changing the database URL does not migrate existing data.
- Provider selection is explicit through `/providers/{connection_id}/v1/*`; there is no unscoped `/v1` inference route.
- Provider Connection IDs are immutable. Display name, base URL, settings, and enabled/archive state are editable. Duplicate creates a new identity.
- The supported OpenAI surface is Models, Chat Completions, and Responses with their streaming forms, tools, structured output, cancellation, and error behavior.
- `/api/v1/directory/providers` is authenticated with a Gateway Key and filtered through Key Scope. `/api/v1/admin/*` is authenticated with the Owner session. Version one has no admin automation tokens.
- The generated OpenAPI document covers discovery and admin APIs. The OpenAI surface is governed by SDK conformance tests and an explicit capability matrix rather than a copied OpenAI schema.
- The first Provider Templates include Generic OpenAI-compatible, OpenAI, OpenRouter, MiniMax, and verified data-only OpenAI-compatible defaults informed by nyanis.
- Provider Templates are data. Typed Inference Adapters own behavior and typed Usage Adapters own authoritative entitlement polling. The UI cannot upload executable plugins.
- The generic Inference Adapter supports safe configurable header authentication and encrypted static headers but never arbitrary authentication code.
- The generic Usage Adapter is reactive-only and reports authoritative remaining balance as Unknown.
- Upstream Keys and secret headers are encrypted with the master key. Gateway Keys are high-entropy credentials stored as public lookup identity plus cryptographic secret hash and shown once.
- No encrypted sentinel, master-key rotation flow, secret backup UI, budgets, request/token rate limits, or monetary accounting is included in version one.
- Upstream Accounts optionally group keys that share billing or capacity. Capacity Scope can be key, account, connection-and-model, provider-wide, or unknown.
- Key selection is round-robin after eligibility filtering. The cursor is in memory; durable Key Health is persisted.
- Persistent Key Health includes Unverified, Active, Cooling Down, Invalid Authentication, Exhausted, and Disabled by Owner, with target-specific denial state where necessary.
- Cooldown recovery uses authoritative Usage Adapter evidence when available or one controlled real request after expiry. Background paid inference probes are forbidden.
- Retry behavior is error- and scope-specific. Explicit credential failures rotate, unknown `403` remains conservative, unknown `429` tries at most one alternate, explicit retryable server responses reuse the same key with backoff, validation errors do not retry, and ambiguous network failures are disabled by default.
- Global retry settings support Provider Connection overrides. Attempts and total retry time are bounded; the initial maximum-attempt setting is four.
- Iroha never retries after downstream bytes are emitted and protects non-idempotent operations unless an adapter declares safe idempotency behavior.
- When no key is eligible, Iroha returns HTTP 503, OpenAI-shaped error code `upstream_credentials_unavailable`, request ID, and a meaningful `Retry-After` when known.
- Cached model catalogs merge upstream synchronization, template knowledge, Owner additions/exclusions, and capability overrides with visible provenance and freshness.
- Unknown cached models are forwarded on provider-scoped routes unless Key Scope or explicit exclusion forbids them.
- Requests validate the routing-critical envelope and preserve unknown JSON fields. The caller's Gateway Key authorization is removed and replaced by adapter-owned upstream authentication.
- Hop-by-hop, proxy-control, credential-bearing, and unsafe forwarding headers are filtered. Redirects are rejected by default; only explicitly enabled same-origin redirects may be followed.
- HTTPS is the default. Insecure HTTP is an explicit per-connection exception with a persistent warning. Callers can never choose arbitrary upstream URLs.
- CORS is off by default for inference and allow-list driven when enabled. Admin remains same-origin.
- Request metadata excludes prompts and responses. Audit and logging exclude secrets. Retention is configurable with a 30-day request-history default.
- Background jobs are bounded and non-overlapping and record outcomes. They cover model sync, Usage Adapter polling, cooldown recovery, request retention, and session cleanup.
- Health endpoints distinguish process liveness from readiness. Provider outages do not make Iroha unready.
- Shutdown drains within a configured grace period, aborts work after the deadline, and closes database resources.
- The repository supplies normal Bun development, build, start, test, and migration-generation commands, with no Dockerfile, Nixpacks configuration, or required real-provider test harness.

## Testing Decisions

- Tests assert external behavior and stable contracts rather than private function structure. Internal collaborators are replaceable only at the application composition boundary.
- The primary seam is the fully assembled Elysia application's Web `fetch` interface. Tests use a real test repository and an injected deterministic mock upstream transport.
- Official OpenAI JavaScript SDK calls run against the assembled HTTP application to cover Models, Chat Completions, Responses, streaming, tools, structured output, OpenAI-shaped errors, cancellation, and unknown-field preservation.
- Mock upstream scenarios cover success, malformed responses, delayed headers, stalled streams, disconnects, timeouts, cancellation, `400`, `401`, ambiguous `403`, confirmed quota exhaustion, key/account/unknown `429`, retryable `5xx`, redirects, and secret-bearing upstream messages.
- High-level HTTP tests cover Gateway Key authentication and scope, provider-scoped routing, header boundaries, CORS, idempotency, retry limits, no-eligible-key responses, request IDs, metadata, and privacy.
- A repository conformance suite runs the same behavior against SQLite and PostgreSQL, including transactional changes, health persistence, scheduling claims, retention, audit, and session behavior.
- Migration tests begin from every released schema version and verify automatic forward migration on both dialects.
- Browser tests cover protected first-run setup, login, recovery, session revocation, Provider Connection creation/edit/archive, Upstream Account explanation, key creation/test/health actions, model and usage views, Gateway Key creation/scoping/revocation, request/audit inspection, themes, and functional mobile flows.
- Narrow deterministic domain tests are permitted for state-machine transition matrices, Capacity Scope propagation, cooldown timing, bounded retry calculation, encryption and hashing, redaction, and abort behavior where an HTTP setup would obscure rather than prove the rule.
- Time, randomness, cryptography, and upstream transport are injected at the composition boundary. Production defaults are not patched globally in tests.
- No required test calls a real Provider or uses a real Provider credential.
- There is no incumbent Iroha test prior art. The closest evidence is nyanis's protocol-focused mock transport and registry tests, but Iroha tests must target its own public behavior and vocabulary.

## Out of Scope

- Anthropic-compatible public endpoints or automatic translation from Anthropic requests.
- Embeddings, images, audio, moderation, files, batches, vector stores, and other OpenAI endpoints beyond Models, Chat Completions, and Responses.
- An unscoped inference route, automatic cross-Provider model routing, virtual model aliases, or model substitution.
- Cross-Provider fallback to a different Provider Connection.
- Multiple Owners, public registration, organizations, tenants, roles, or hosted SaaS billing.
- Gateway Key budgets, request/token rate limits, monetary budget enforcement, or pricing catalogs.
- Per-key or per-connection concurrency limits and overload queues.
- Horizontal replicas, distributed locks, shared runtime caches, leader election, or multi-region operation.
- Admin API tokens and external administrative automation.
- Runtime-uploaded code, scripts, or adapter plugins.
- Automatic capability probes that can incur inference cost.
- Automatic paid background health probes.
- Real-provider integration tests or CI credentials.
- Dockerfiles, Nixpacks configuration, or a prescribed deployment artifact.
- Automatic migration of an installation between SQLite and PostgreSQL.
- Master-key rotation, encrypted secret export/backup, or encrypted sentinel verification.
- Full prompt or response logging.
- Hard accessibility certification, although semantic controls, keyboard use, focus, labels, responsive operation, and reduced motion remain engineering requirements.
- A runtime dependency on nyanis, direct nyanis database reads, or use of nyanis-discovered credentials.

## Further Notes

- `CONTEXT.md` is the canonical domain glossary. In particular, Provider, Provider Connection, Upstream Account, Upstream Key, Gateway Key, Key Scope, Capacity Scope, Inference Adapter, Usage Adapter, and Provider Template are distinct concepts.
- Existing ADRs govern provider-scoped routing, database authority, persistent scoped Key Health, and typed adapters. Implementation work must surface any proposed contradiction rather than silently changing those decisions.
- The architecture design, configuration reference, adapter guide, and primary-source gateway comparison remain supporting detail. This spec is the tracker-native implementation contract.
- The UI is an occasional-use developer tool. Its hierarchy should emphasize actionable exceptions and diagnostic trails, not decorative monitoring.
- Provider and Usage Adapter claims must remain honest: Unknown balance is not zero, a model catalog can be stale, and compatibility is endpoint- and capability-specific.
