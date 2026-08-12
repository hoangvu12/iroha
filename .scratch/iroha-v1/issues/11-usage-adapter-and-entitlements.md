# 11 — Usage Adapter and entitlement visibility

**What to build:** The Owner can distinguish unknown generic capacity from authoritative provider-specific credit or plan usage, and that evidence can safely influence Key Health.

**Blocked by:** 06 — Model catalog and scoped Models API; 10 — Scoped retries and durable Key Health.

**Status:** done

- [x] Generic OpenAI-compatible connections expose `reactive_only` usage visibility and report authoritative remaining balance as Unknown.
- [x] Typed Usage Adapters can normalize credit and subscription/coding-plan usage without assuming one Provider billing shape.
- [x] Normalized results include units, Capacity Scope, freshness, reset time, authority/confidence, and raw-provider diagnostic boundaries.
- [x] Confirmed zero remains distinct from Unknown and from a temporarily failed poll.
- [x] Usage is fetched after relevant configuration changes, periodically, and through a manual Refresh action.
- [x] Polling respects Provider limits, backs off, retains the last successful result, and displays the latest error separately.
- [x] Authoritative recovery can reactivate an Exhausted or Cooling Down scope without a paid inference probe.
- [x] UI and mock-adapter tests cover credit, plan windows, shared accounts, reset, stale results, unknown visibility, and recovery.

## Comments

Implemented via subagent: Usage Adapter contract (src/usage/adapter.ts), generic reactive-only adapter (src/usage/generic-adapter.ts), mock credit and plan adapters (src/usage/mock-credit-adapter.ts, src/usage/mock-plan-adapter.ts), UsageService (src/usage/usage-service.ts), HTTP routes (src/http/usage.ts), UsageRepository contract (src/persistence/repository.ts) implemented in both SQLite (src/persistence/sqlite/database.ts) and PostgreSQL (src/persistence/postgres/database.ts), migration 0008 both dialects, integration with ProviderConnectionRegistry.reactivateFromUsage (src/providers/connection-registry.ts), wiring in app.ts and startup.ts.

Tests added: 19 unit tests for the UsageService (test/usage/usage-service.test.ts) covering reactive-only visibility, authoritative credit readings, plan windows, account and connection_model and provider scopes, shared-account reactivation, key-scope reactivation, stale-evidence refusal, rate-limit backoff, stale retention, and the Unknown-vs-confirmed-zero distinction. 13 HTTP tests (test/http/usage.test.ts) covering GET/POST usage, scope rendering, recovery evidence surfacing, 429 on rate-limit, 401 unauthenticated, 404 unknown connection, 409 archived, and full mock-adapter end-to-end coverage. 6 repository conformance cases (test/persistence/repository-conformance.test.ts) for the new usage_snapshots table.

Full suite: 485 pass / 1 skip / 0 fail; typecheck clean.
