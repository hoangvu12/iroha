Status: ready-for-agent

# Provider replaces Provider Connection; per-Upstream-Key base URL override

## Problem Statement

The Owner configures one Provider Connection per endpoint, so a Provider with N endpoints forces N Provider Connections. Round-robin happens within a Provider Connection only — across the brand's endpoints, it does not. The Owner also has to manage "Connection" everywhere in the UI, the admin API, the inference routes, and the Provider Directory, even though what they really mean by it is "the upstream service I'm reaching."

The Owner cannot model "one upstream brand, several endpoints, keys may be bound to different endpoints, the application calls one URL" without either creating a Provider Connection per endpoint and living with N parallel entries, or putting a reverse proxy in front of the Provider and pretending one URL is many. Neither is honest.

## Solution

Rename Provider Connection to Provider and lift the single-base-URL constraint on its Upstream Keys. Each Provider has a default base URL set at creation. Each Upstream Key may declare its own base URL override; when unset, the key uses the Provider's base URL. Round-robin then naturally spreads across the Provider's Upstream Keys, and each key uses the URL it was bound to. The application still sees one URL — `/providers/{providerId}/v1/...` — and the Owner manages N keys with N URLs under one Provider.

The glossary (`CONTEXT.md`) and the decision record (`docs/adr/0006-provider-replaces-connection-with-per-key-base-url.md`) capture the rename and the per-key override. The migration hard-cuts over old URLs and admin paths; no live data exists to preserve.

## User Stories

For the Owner:

1. As the Owner, I want a "Providers" page (not "Provider Connections"), so the Owner-facing model matches the upstream-brand vocabulary.
2. As the Owner, I want to create a Provider with a default base URL, so each Upstream Key I add has a sensible default endpoint to inherit.
3. As the Owner, I want the default base URL to be optional at creation, so I am not forced to invent a placeholder URL.
4. As the Owner, I want the Add Upstream Key form to offer an optional base URL field prefilled with the Provider's default URL, so the common case takes one click and the uncommon case is one field away.
5. As the Owner, I want a blank key base URL field to mean "use the Provider's base URL", so the inheritance is explicit at the form level.
6. As the Owner, I want to edit the default base URL on a Provider, so I can repoint the Provider without rebuilding every key.
7. As the Owner, I want to edit an Upstream Key's base URL override, so I can fix a typo or repoint a single key without affecting the others.
8. As the Owner, I want the Provider detail page to list every Upstream Key with its health, last probe, allowed/denied models, and effective base URL (the override if set, else the Provider's default), so I can audit what each key actually does.
9. As the Owner, I want to add, test, activate, disable, and remove Upstream Keys from the Provider detail page, so the key lifecycle is managed in one place.
10. As the Owner, I want to add, list, rename, and delete Upstream Accounts on a Provider, so billing and capacity grouping stay local to the Provider.
11. As the Owner, I want the model catalog probe to run against the Provider's base URL only, so the catalog is one authoritative list, not a fan-out across N endpoints.
12. As the Owner, I want to archive a Provider, so I can take it out of active use without losing its identity, keys, or history.
13. As the Owner, I want to duplicate a Provider and have every Upstream Key re-encrypted and re-tested, so the duplicate starts in the same state the original started in.
14. As the Owner, I want to purge an archived Provider, so deletion is irreversible but explicit.
15. As the Owner, I want the Provider list page to show one row per Provider with a brand icon and traffic summary, so I can see the full picture at a glance.
16. As the Owner, I want the Provider list page to show archived Providers under a separate section, so the active list stays clean.
17. As the Owner, I want the Provider Directory endpoint to return Providers (not Provider Connections), so the discovery response matches the renamed model.
18. As the Owner, I want the audit log to record `provider.created`, `provider.updated`, `provider.archived`, `provider.duplicated`, `provider.purged`, `key.created`, `key.tested`, `key.activated`, `key.disabled`, `key.removed`, `account.created`, `account.updated`, `account.removed`, so the audit vocabulary matches the renamed model.

For the application calling the Gateway:

19. As an application, I want to call `/providers/{providerId}/v1/chat/completions`, so my OpenAI-shaped client reaches the Gateway through one stable URL per Provider.
20. As an application, I want to call `/providers/{providerId}/v1/responses`, so my Responses-API client reaches the Gateway through the same URL.
21. As an application, I want to call `/providers/{providerId}/v1/models`, so my model-discovery client enumerates the Provider's catalog.
22. As an application, I want a request that fails on one Upstream Key to fail over to another eligible Upstream Key on the same Provider, so I am shielded from transient per-key failures.
23. As an application, I want the Gateway to honor the Capacity Scope rules it already enforces (key, account, provider-and-model, provider, unknown), so cooldown semantics do not silently change with the rename.
24. As an application, I want a request that hits the renamed Provider URL to be answered correctly, so the rename is invisible at the application boundary.
25. As an application, I want a request to the old `/providers/{connectionId}/v1/...` URL to return a clean 404, so I know to update my base URL rather than see a stale successful response.
26. As an application, I want the Provider Directory to be queried with a Gateway Key that scopes to one or more Provider IDs, so discovery is gated by Key Scope.

For Provider Template and Adapter authors:

27. As a Provider Template author, I want my templates to keep seeding the same defaults (base URL, auth header shape, capabilities, known models) into the new Provider entity, so the templates need no change.
28. As an Inference Adapter author, I want the route I bind to identify a Provider (not a Provider Connection), so my adapter logic is unchanged.
29. As a Usage Adapter author, I want the Usage Adapter to identify a Provider (not a Provider Connection), so my entitlement polling is unchanged.

For self-hosters and operators:

30. As a self-hoster, I want a single migration per dialect (SQLite and PostgreSQL) that renames `provider_connections` → `providers`, renames `upstream_keys.connection_id` → `upstream_keys.provider_id`, adds `upstream_keys.base_url`, and rewrites `gateway_keys.scope` Connection IDs to Provider IDs, so an existing install migrates in one step.
31. As a self-hoster, I want the migration to abort if a `gateway_keys.scope` entry references a Provider ID that does not resolve, so a corrupted scope cannot silently drop access.
32. As a self-hoster, I want the migration to be tested on both dialects against a populated fixture, so I am confident it works.
33. As a self-hoster, I want the old admin URL `/api/v1/admin/provider-connections` to return 404 after the rename, so I am forced to update tooling.
34. As a self-hoster, I want the inference URL `/providers/{connectionId}/v1/...` to return 404 after the rename, so I am forced to update client base URLs.
35. As a self-hoster, I want every test in the suite to pass on both SQLite and PostgreSQL, so conformance holds across the rename.

## Implementation Decisions

The Provider rename and the per-key base URL override cascade through every layer that previously spoke "Provider Connection". Each layer's job:

- **Database schema (one migration per dialect).** Rename `provider_connections` to `providers`; rename `upstream_keys.connection_id` to `upstream_keys.provider_id`; rename the foreign-key index on `upstream_accounts` from the connection-id index to a provider-id index; add `upstream_keys.base_url` (nullable text); preserve all existing rows; rewrite `gateway_keys.scope` Connection IDs (`pc_…`) to Provider IDs (`pr_…`) by reading the pre-rename `provider_connections` table and mapping each `pc_*` literal in the JSON scope to its row. The underlying ID values are preserved across the rename so the row identity is stable; only the prefix formatting changes, and the database stores the new prefix as the new value. Abort the migration if any scope entry references an ID that does not resolve.
- **ProviderRepository contract.** Rename `listConnections` → `listProviders`, `getConnection` → `getProvider`, `insertConnection` → `insertProvider`, `updateConnection` → `updateProvider`, `deleteConnection` → `deleteProvider`. Connection-scoped queries (`listKeys`, `listAccounts`) take a Provider ID now. `insertKey` and `updateKey` accept an optional `baseUrl` field. Add `providerDefaultBaseUrl(providerId, keyId)` that returns `key.baseUrl` when set, else `provider.baseUrl`. The `key` view (Owner-facing) includes a derived `effectiveBaseUrl` so the UI does not have to compute the inheritance itself.
- **ProviderConnectionRegistry → ProviderRegistry.** The class is renamed and every public method's name and signature tracks the rename. Behavior is otherwise unchanged: same ID-immutability rules, same encrypted-then-tested-then-active key lifecycle, same archive-first purge, same Owner-disable, same audit vocabulary (with `connection.*` actions renamed to `provider.*`). `addKey` and `updateKeySettings` accept an optional `baseUrl` parameter; when omitted, the key inherits the Provider's base URL. `resolveInference` picks a key round-robin among eligible keys and uses the resolved baseUrl for that call.
- **HTTP inference routes.** `/providers/:connectionId/v1/{chat.completions,responses,models}` → `/providers/:providerId/v1/{...}`. The handler resolves Provider → Upstream Keys → round-robin pick → resolved key baseUrl → upstream call. The old path returns 404 (no redirect).
- **HTTP admin routes.** `/api/v1/admin/provider-connections` → `/api/v1/admin/providers`. All sub-routes (list, inspect, create, edit, archive, duplicate, purge, add-key, remove-key, test-key, activate-key, disable-key, configure-key, create-account, update-account, delete-account) are renamed in their path segments and JSON field names. The old path returns 404 (no redirect).
- **Owner UI.** The "Provider Connections" page becomes a "Providers" page. The new-Provider dialog gains an optional `baseUrl` field. The Provider detail page renders the Provider's default base URL, lists every Upstream Key with its effective base URL, exposes an Add Upstream Key form with an optional `baseUrl` field prefilled with the Provider's default, and surfaces the Provider's Upstream Accounts. Every "Connection" label in the UI is replaced with "Provider" (or removed where the upstream brand name suffices). The Provider icon, traffic summary, and Archived section continue to work with the renamed entity.
- **Audit vocabulary.** Actions `connection.created`, `connection.updated`, `connection.archived`, `connection.duplicated`, `connection.purged` are renamed to `provider.created`, `provider.updated`, `provider.archived`, `provider.duplicated`, `provider.purged`. `key.*` and `account.*` actions are unchanged. Pre-existing audit rows keep their old action names because the audit table is append-only.
- **Glossary.** `CONTEXT.md` is updated to redefine Provider (absorbing Provider Connection), to drop Provider Connection, and to allow Upstream Key to declare an optional base URL. Entries that referenced Provider Connection (`Provider Directory`, `Inference Adapter`, `Provider Template`, `Key Scope`, `Capacity Scope`, `Upstream Account`) are updated to reference Provider.
- **Documented decision.** The rename and the per-key override are recorded in `docs/adr/0006-provider-replaces-connection-with-per-key-base-url.md`. The glossary update is committed alongside the code change.
- **Reuse, not redesign.** The Provider Template list, the Adapter Registry, the Inference Adapter and Usage Adapter registries, the model catalog subsystem, the Usage subsystem, the Gateway Key subsystem, the audit subsystem, and the request-history subsystem are unchanged at the seam; they identify Providers (was: Provider Connections) and continue to do so. No new top-level modules are introduced.

## Testing Decisions

- The highest seam is the HTTP and UI layer. Tests at this seam assert Owner-visible behavior (HTTP responses, JSON bodies, UI render) and do not reach into internal state.
- Existing test directories are reused; no new top-level test directories are created.
  - **Repository conformance** — runs against both SQLite and PostgreSQL via the shared ProviderRepository contract. New cases for `providerDefaultBaseUrl`, per-key `baseUrl` write, and round-trip read of `upstream_keys.base_url`.
  - **Migration conformance** — runs against both dialects against a populated fixture (one Provider, several Upstream Keys with mixed base URL values, several Gateway Keys with non-empty scopes containing `pc_*` references), asserting the post-migration shape, the column rename, the new column presence, and that the scope IDs are rewritten to `pr_*` and unresolvable IDs cause the migration to abort.
  - **Registry** — create, edit, archive, duplicate, purge, add-key with optional base URL, edit-key base URL, resolve-inference picking the right key and right base URL. Mixed-URL round-robin: a Provider with one key at its default URL and one key at its own override URL; the test asserts the resolved call uses the override URL when that key wins.
  - **HTTP admin** — all paths and JSON field names under the renamed admin URL `/api/v1/admin/providers`; new cases for 404 on `/api/v1/admin/provider-connections`.
  - **HTTP inference** — chat completions, responses, models, retries, round-robin, streaming, security cases under the renamed inference URL `/providers/:providerId/v1/...`; new cases verifying 404 on `/providers/:connectionId/v1/...`.
  - **HTTP gateway keys** — Provider Directory returns Providers; Key Scope values are Provider IDs and resolve correctly against the renamed table.
- A good test asserts external behavior only. The round-robin cursor, the in-memory cooldown claim set, and other internal state machine details are not asserted directly.
- All HTTP and registry tests are run against both dialects.
- Provider Template tests, Inference Adapter tests, and Usage Adapter tests are re-run as-is and continue to pass; if any need a Provider-side rename they are updated as part of the Implementation Decisions cascade.

## Out of Scope

- Per-Provider Usage Adapter override. The Usage Adapter continues to identify a Provider; one Usage Adapter per Provider.
- Per-Endpoint Capability overrides. Capabilities stay Provider-scoped.
- Cross-Provider failover. The Gateway does not pick a different Provider when one Provider's keys fail; the Owner scopes each Gateway Key to the Providers it may use.
- Endpoint as a first-class child of Provider (Azure-style deployments). A Provider holds Upstream Keys directly.
- Per-Upstream-Key override of `authHeader`, `authPrefix`, `staticHeaders`, `idempotencyHeader`, `redirectAllowSameOrigin`, `connectionTimeoutMs`, `firstByteTimeoutMs`, `nonStreamingTotalTimeoutMs`, `streamingIdleTimeoutMs`, `totalRetryTimeoutMs`, `retryMaxAttempts`, `retryAmbiguousNetwork`, `allowInsecureHttp`, `capabilities`. All transport, authentication, retry, timeout, capability, and idempotency settings stay Provider-scoped.
- Per-key Inference Adapter or per-key Usage Adapter. One Inference Adapter and one Usage Adapter per Provider.
- Per-Key probe target. The model catalog probe runs against the Provider's base URL once, not against each key's URL.
- Per-Key Capacity Scope dimension. Cooldown scoping keeps the existing levels (key, account, provider_model, provider, unknown).
- Cross-Provider model aliasing. The application sends the exact upstream model name.
- Backward compatibility on URL paths or admin API paths. Old paths return 404.
- Encryption of Provider-level static headers beyond what the schema already does.
- Master-key rotation, encrypted secret export/backup, or encrypted sentinel verification.
- A migration tool for moving data between SQLite and PostgreSQL.
- Anything listed in the iroha-v1 spec's "Out of Scope" section that remains out of scope here.

## Further Notes

- The glossary has been updated in `CONTEXT.md` to redefine Provider and drop Provider Connection; the rename tracks that glossary update.
- The decision record is at `docs/adr/0006-provider-replaces-connection-with-per-key-base-url.md`.
- Provider IDs and the ID-prefix formatting (`pr_…` after rename, `pc_…` before) are decoupled: the migration preserves the underlying ID value and renames the prefix in `gateway_keys.scope` JSON literals; the database stores the new prefix as the new value going forward.
- The renaming of audit actions (`connection.*` → `provider.*`) is the only audit-history-visible consequence of the rename. Pre-existing audit rows keep their old action names because the audit table is append-only.
- The model catalog probe, the connection probe, the key probe, the inference call, the retries, and the cooldown recovery all use the resolved base URL for a given Upstream Key, not the Provider's default base URL. Tests at the HTTP and registry seam verify the resolution.