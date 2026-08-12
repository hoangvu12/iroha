# Iroha version-one design

## Purpose and boundary

Iroha is a single-owner, self-hosted gateway for OpenAI-compatible inference providers. It is configured through a browser UI and presents explicit provider-scoped endpoints while automatically selecting healthy upstream keys.

Iroha is independent of nyanis. It may reuse verified provider facts and visual ideas, but it neither reads nyanis's database nor routes discovered credentials.

Version one supports Chat Completions and Responses, including streaming, tool calls, structured output, cancellation, and OpenAI-shaped errors. Embeddings, images, audio, moderations, files, batches, and vector stores are outside the initial boundary.

## System shape

- Bun is the production runtime.
- Elysia serves inference routes, management and discovery APIs, generated OpenAPI documentation, health endpoints, and the built frontend.
- The frontend is initialized from scratch with Vite, React, TypeScript, and shadcn/ui.
- Drizzle provides separate SQLite and PostgreSQL schemas and migration tracks behind one repository contract.
- One process owns HTTP traffic and bounded background work. Horizontal coordination is out of scope.
- The repository exposes normal Bun install, development, build, start, test, and migration-generation commands. It prescribes no Docker or Nixpacks artifact.

## Runtime topology

```text
OpenAI client
  -> Gateway Key authentication
  -> Provider Connection selected by URL
  -> request/capability validation
  -> eligible Upstream Key selection
  -> retry and Key Health engine
  -> Inference Adapter
  -> upstream provider

Owner browser
  -> Owner session
  -> admin API
  -> database-backed control plane

Background scheduler
  -> model synchronization
  -> Usage Adapter polling
  -> cooldown recovery
  -> retention/session cleanup
```

## URL and authentication boundaries

### Inference

```text
/providers/{connection_id}/v1/chat/completions
/providers/{connection_id}/v1/responses
/providers/{connection_id}/v1/models
```

`connection_id` is immutable and unique. It identifies one configured account or server, not merely a provider brand. The request's `model` value is forwarded unchanged.

Inference uses `Authorization: Bearer <Gateway Key>`. Iroha consumes this header, strips it, and injects the selected Upstream Key according to the Inference Adapter. Hop-by-hop and proxy-control headers are stripped. Safe tracing and idempotency headers are forwarded only through an allow-list. Upstream authentication and secret-bearing response headers are never returned.

There is no unscoped `/v1` inference route in version one.

### Discovery

```text
GET /api/v1/directory/providers
```

Discovery requires a Gateway Key and returns only Provider Connections and models allowed by that key's Key Scope. It includes connection ID, display name, scoped inference URL, exact model IDs, and declared capabilities. It never includes base URLs, upstream secrets, balances, or internal health details.

### Administration

```text
/api/v1/admin/*
```

Administration requires the Owner's browser session. Version one does not issue admin automation tokens. Elysia route schemas generate an OpenAPI specification and interactive `/docs` for discovery and administration; the OpenAI passthrough surface is documented through conformance tests and a capability matrix instead of duplicating the full OpenAI specification.

## Control-plane records

### Provider Connection

A Provider Connection contains an immutable ID, editable display name, Provider Template, Inference Adapter, Usage Adapter mode, base URL, enabled/archive state, model catalog, capability defaults, Upstream Accounts, Upstream Keys, and advanced transport/retry settings.

The default form shows only template/custom choice, ID, display name, base URL, and keys. Authentication overrides, encrypted static headers, model paths, capabilities, redirects, timeouts, and retry settings live under Advanced.

Deletion is archive-first: disable the connection, remove it from active Gateway Key scopes, and preserve historical references. Permanent purge is an explicit destructive action.

### Provider Template and adapters

Iroha ships a Generic OpenAI-compatible option and built-in templates for OpenAI, OpenRouter, MiniMax, and verified OpenAI-compatible endpoints ported from nyanis. Templates contain defaults but no accounts or secrets.

Most providers require only a data-only Provider Template. Code-backed Inference or Usage Adapters are used for custom authentication, capability behavior, structured failure classification, or entitlement polling. The UI cannot upload executable plugins.

### Upstream Account and keys

An optional Upstream Account groups keys sharing billing or capacity. The UI explains that an account-wide limit makes every grouped key ineligible. Independent keys need no group.

Each Upstream Key is encrypted at rest, revealed only when initially submitted by the Owner, and may carry allowed/excluded model rules. New keys are saved as Unverified, tested with a low-cost adapter-defined operation where possible, activated on success, and retained with their failure reason after an inconclusive test. The Owner may explicitly activate or retest them.

### Gateway Keys

Gateway Keys use a public lookup ID plus a high-entropy secret, approximately `sk-iroha_<id>_<secret>`. Only a cryptographic hash of the usable secret is stored, and plaintext is shown once.

Version-one lifecycle includes name, create, one-time reveal, revoke, last-used time, allowed Provider Connections, and optional allowed-model lists. Budgets, request/token rate limits, and monetary accounting are deferred.

## Models and capabilities

Each Provider Connection maintains a cached model catalog combining the last successful `/models` synchronization, template knowledge, Owner additions, Owner exclusions, and capability overrides. The UI shows each model's origin and catalog freshness.

Model refresh runs after connection changes, periodically, and on manual request. A failed refresh retains the last successful catalog, marks it stale, alerts the Owner, and does not disable inference.

`GET /providers/{connection_id}/v1/models` returns an OpenAI-shaped list containing exact model IDs allowed by the caller's Gateway Key. Internal origin and capability metadata remain in the custom directory API.

Provider-scoped requests for models absent from the cache are forwarded by default because catalogs can be incomplete. Explicit Gateway Key allow-lists and Owner exclusions still apply. Active keys are eligible for unknown models unless explicitly excluded; a model-specific denial affects that key/model pair rather than globally invalidating the key.

Capabilities exist as adapter-supplied connection defaults plus per-model Owner overrides. Automatic paid capability probes are not used.

## Selection, capacity, and retry behavior

### Eligibility and round-robin

The engine filters keys by enabled state, Key Health, Upstream Account state, model eligibility, and request-local exclusions. It then selects among eligible keys by round-robin. The cursor is in memory and may reset on restart; health state is durable.

Per-key/connection concurrency limits and overload queues are deferred.

### Capacity scope

Adapters normalize capacity limits as key-scoped, account-scoped, connection-and-model-scoped, provider-wide, or unknown. Known scope determines which candidates become ineligible. For unknown `429` scope, Iroha tries at most one alternate key before cooling the broader connection to avoid stampeding keys that may share quota.

### Persistent Key Health

Visible states are Active, Cooling Down, Invalid Authentication, Exhausted, Disabled by Owner, and Unverified. Iroha persists state, reason, last success/failure, and next retry time. An ambiguous `403` is target-specific unless an adapter proves the whole credential invalid.

After cooldown expiry, a known Usage Adapter may authoritatively reactivate capacity. Otherwise exactly one real request becomes the controlled trial while other traffic continues to skip that key. Success returns it to Active; repeated failure extends the cooldown. The UI also provides a manual Test action. Iroha does not generate paid background inference probes.

### Retry classification

```text
401                     invalidate key; rotate immediately
adapter-confirmed quota mark exhausted at known scope; rotate immediately
403                     try at most one alternate; do not globally invalidate by default
429                     honor bounded reset/backoff; rotate one alternate; apply known scope
explicit retryable 5xx  retry same key with bounded backoff
validation 4xx          return without retry
ambiguous timeout/reset disabled by default; configurable per connection
```

Retries stop on success, exhausted eligible candidates, `max_attempts`, or the total retry time budget. Defaults are globally configurable with Provider Connection overrides; the agreed starting maximum is four attempts. One request does not retry the same permanently failed key.

Iroha never retries after downstream response bytes have been emitted. It avoids retrying operations not known to be idempotent unless the adapter declares and preserves a supported idempotency key. Caller-supplied idempotency values are preserved; Iroha generates one only for explicitly safe adapters.

When no key is eligible, Iroha returns HTTP 503 with an OpenAI-shaped error, stable code `upstream_credentials_unavailable`, request ID, and `Retry-After` when recovery time is known.

## Usage and entitlement

The generic adapter has `reactive_only` usage visibility. It may learn from inference statuses, usage payloads, and rate-limit headers but always reports authoritative remaining balance as Unknown.

Known Usage Adapters may retrieve credit balance, coding-plan usage, subscription windows, or reset time from documented provider APIs. Each result records units, scope, freshness, and whether it is authoritative. Polling occurs after configuration changes, periodically with a conservative default, and manually. It respects upstream limits, backs off, retains the last successful value, and never converts Unknown into zero.

## Request and response handling

For supported OpenAI endpoints, Iroha validates the routing-critical envelope and preserves unknown JSON fields so provider extensions and newer OpenAI fields continue to work. Adapters own required transformations.

Errors retain a safe meaningful upstream status where appropriate, use an OpenAI-shaped envelope, and include a stable Iroha routing code. Upstream text is sanitized. Retry trails and key identifiers remain in metadata logs, not public error bodies.

Every request receives `x-iroha-request-id`; a safe valid caller value may be preserved. Client disconnect or cancellation immediately aborts the active upstream request and stops retries.

Transport settings provide global defaults and connection overrides for connection timeout, time to first byte, non-streaming total timeout, streaming idle timeout, and total retry budget. HTTPS is required by default. The Owner may explicitly permit insecure HTTP on a connection with a persistent warning. Redirects are rejected by default; same-origin following may be explicitly enabled. Cross-origin redirects are never followed with credentials.

Cross-origin browser inference is disabled by default. The Owner may allow specific origins globally or per Gateway Key. Wildcard origins are not combined with credentials. Administration remains same-origin.

## Identity and secret handling

The first Owner is created through `/setup` using the required `IROHA_SETUP_TOKEN`. Once an Owner exists, setup is permanently closed and `/setup` redirects to login. Setup cannot replace the Owner.

An optional persistent `IROHA_RECOVERY_TOKEN` enables browser-based password reset for hosting environments without convenient shell access. Recovery is throttled, audited, and invalidates all Owner sessions. The same configured token remains a reusable alternate root credential until the operator rotates or removes it.

Owner passwords are hashed. Sessions use secure HTTP-only same-site cookies, sliding expiry, listing/revocation, logout-all, CSRF protection, and throttled login/recovery attempts.

`IROHA_MASTER_KEY` is required and stable across restarts. It encrypts Upstream Keys and secret static headers. It is configured only through the environment and documented in `.env.example`; there is no UI backup or master-key rotation workflow in version one. A dedicated encrypted sentinel check is also deferred.

## Persistence and background work

`DATABASE_URL` is always required. `file:` selects SQLite; `postgres://` or `postgresql://` selects PostgreSQL. Unsupported schemes fail at startup. The application selects the matching Drizzle driver and migration track. Database choice is deployment-time; changing the URL does not migrate data.

Pending migrations apply automatically before the server listens. Migration failure stops startup. SQLite deployments display the resolved file path and a persistent-volume warning.

Bounded non-overlapping background jobs perform model sync, Usage Adapter polling, cooldown recovery, request-log retention cleanup, and expired-session cleanup. Each records its last outcome for the UI.

## Logs, audit, and observability

Inference history stores metadata only: request ID, timestamp, connection, model, selected key ID/name, status, latency, retry trail, and token usage when supplied. It never stores prompts, responses, or secret values. Retention is configurable and defaults to 30 days; disabled retention is supported.

Owner configuration changes are audited indefinitely unless explicitly cleared, without secret values. The UI exposes request filters, retry/skip reasoning, Key Health and cooldowns, model/usage synchronization history, and audit history.

An optional authenticated Prometheus-style metrics endpoint may expose bounded-cardinality request, latency, failure, retry, and health counts. It contains no secrets or request IDs.

## UI information architecture and visual direction

Primary navigation is Overview, Providers, Gateway Keys, Requests, Audit, and Settings. A Provider Connection has Overview, Upstream Keys, Models, Usage, Logs, and Settings views.

The Overview is a continuous operations workspace, not a grid of generic cards. It leads with attention-required rows and direct recovery actions, followed by compact inline request summaries, one quiet request-volume trend, one key-health distribution visualization, and a recent-failures table. Typography, whitespace, and dividers provide hierarchy; bordered containers are reserved for interactive tables and charts.

The frontend starts with a fresh shadcn initialization, then recreates the confirmed nyanis visual language and selectively ports useful chart primitives. It supports light, dark, and system themes. Desktop is primary; mobile remains functional for setup, inspection, logs, disabling keys, and recovery.

## Operations

`/health/live` reports that the process is running. `/health/ready` reports that configuration is valid, the database is migrated, and Iroha can accept traffic. Upstream provider outages do not make Iroha unready.

Shutdown stops new inference, stops background claims, permits active work for a configurable grace period, aborts remaining upstream requests after the deadline, and closes database connections.

Timestamps are stored and emitted in UTC and displayed in the browser timezone.

## Verification

Required tests use deterministic mock upstreams; real-provider tests are out of scope. The suite includes routing and health unit tests, Chat/Responses integration tests including streaming and cancellation, official OpenAI JavaScript SDK conformance tests, SQLite/PostgreSQL repository conformance, browser flows for setup/provider/Gateway Key/recovery, migration tests, and systematic secret-redaction tests.

## Version-one acceptance

Version one is complete when the Owner can:

1. Start Iroha against explicit SQLite or PostgreSQL configuration.
2. Complete secure first-run setup.
3. Configure a Provider Connection with multiple keys and optional shared accounts.
4. Create a scoped Gateway Key.
5. use Chat Completions and Responses, including streaming, through a provider-scoped URL.
6. Continue safely through eligible key failures and understand the final outcome.
7. Discover permitted Provider Connections and exact models.
8. Inspect metadata logs, usage visibility, and persistent Key Health.
9. Upgrade through automatic migrations.
