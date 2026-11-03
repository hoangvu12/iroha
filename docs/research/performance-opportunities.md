# Iroha performance opportunities

Research date: 2026-09-19. Source of truth is this repository at commit
`1e3dc8d`; every claim cites a `file:line` in that tree. This is an internal
static-analysis audit, not a benchmark run. PRODUCT.md records that no
benchmarks or production usage exist for Iroha, so nothing here may be quoted
as a measured speedup. The output of this document is a ranked list of
hypotheses to validate with the local HTTP seam (`test/support/inference.ts`)
and a fake upstream.

Iroha has two performance surfaces and this document treats them separately:

- **The web side** — the Bun/Elysia server, static delivery of the built React
  management UI, and the admin/management API plus session and metric surface
  (Part A).
- **The proxy side** — forwarding inference to upstream Providers, including
  transport, redirects, timeouts, retries, streaming transforms, and discovery
  (Part B).

They share one persistence layer, so the cross-cutting database findings are
kept as the shared foundation (F1–F14) that both sides depend on.

## Executive summary

Iroha's inference path is dominated by database round-trips and duplicated
reads, not by upstream latency. One simple, successful, provider-scoped
streaming Chat Completion currently performs roughly **ten reads and five writes**
against the database, and the global `/v1/...` surface performs substantially
more (triple key authentication, a full provider-table scan, and a per-provider
N+1). Three of the largest costs are structural and cheap to remove:

1. **Provider reads are duplicated 5× per resolution.** `resolveProvider` →
   `getProvider` → `#viewOf` re-reads the provider row twice, and re-reads the
   keys with a second provider read (`src/providers/provider-registry.ts:365-369,1945-1966,1884-1916`).
   `resolveInference` then reads the provider and all keys *again* (`:1457-1463`).
2. **Global requests authenticate the Gateway Key three times**, hashing the
   secret with SHA-256 three times and writing `markUsed` three times
   (`src/http/qualified-model.ts:40,45,49` → `src/keys/gateway-key-registry.ts:457,471`).
   `discover()` is called only to authenticate but also performs a full
   `providers` scan plus a `getProvider`/`listEntries` N+1 (`gateway-key-registry.ts:339-354`).
3. **Only one index exists in the entire schema** (`providers_handle_unique`,
   `migrations/sqlite/0018_amusing_elektra.sql:42`). Foreign-key and
   time-ordered hot-path columns are unindexed, so `listKeys`, catalog lookups,
   and history reads full-scan.

On the streaming path, the first byte to the caller is withheld behind three
awaited database writes (`src/http/inference.ts:948-969`), and the response
monitor uses an eager `while` loop that ignores backpressure
(`src/http/inference.ts:2589-2606`).

The two surfaces each have one dominant, cheap win on top of that foundation:

- **Web side (Part A):** responses and the single 970,977-byte UI bundle are
  served with no compression and no code splitting, and each page load re-reads
  request history with a write-on-read abandonment sweep plus a whole-range JS
  aggregation. Add compression, split the chart tree out of the entry bundle,
  and give history a real index and a SQL aggregate.
- **Proxy side (Part B):** the advertised connect/first-byte/total timeouts are
  never enforced, the same-origin redirect wrapper has no hop limit, and the
  Anthropic adapter silently follows cross-origin redirects. Enforce the
  timeouts and bound redirects before tuning anything else.

## How the request path works today

Provider-scoped `POST /providers/:handle/v1/chat/completions`
(`src/http/inference.ts:747-969` for the streaming case; the buffered case
mirrors it at `:1116-1136`):

| Step | Work | Evidence |
|---|---|---|
| Parse body | Full `request.text()` + `JSON.parse` | `inference.ts:747`, `:2308` |
| Authorize key | `gatewayKeys.get` + SHA-256 + `markUsed` | `inference.ts:759`, `gateway-key-registry.ts:471,457` |
| Exclusion check | `modelCatalog.isExcluded` SELECT | `inference.ts:765` |
| Resolve provider | 5 DB reads (row ×3, keys, accounts) | `inference.ts:783`, `provider-registry.ts:365-369,1945-1966,1885,1889,1919` |
| Start attempt | `recordEvent` upsert + `recordAttempt` INSERT | `inference.ts:896`, `request-history.ts:203-216` |
| Resolve key | provider + `listKeys` (+ availability) re-read; AES-GCM decrypt key + static headers | `provider-registry.ts:1457-1466,1511,1517` |
| Upstream | network fetch | `inference.ts:933` |
| On 2xx | `recordInferenceSuccess` (`getKey`), attempt `updateAttempt`, history `recordEvent` — all awaited before returning the stream | `inference.ts:949-967` |

Global `POST /v1/chat/completions` adds, before forwarding
(`src/http/qualified-model.ts:30-64`):

- `discover()` — full `listProviders` scan, per-provider `getProvider`, and for
  unrestricted keys a `modelCatalog.listEntries` per provider
  (`gateway-key-registry.ts:338-354`).
- `resolveHandle` — provider by handle.
- `authorizeProvider` and `authorizeInference` — each re-locates, re-hashes, and
  re-writes the same Gateway Key.
- `isExcluded` during admission, then `isExcluded` again in the forwarder
  (`qualified-model.ts:53`, `inference.ts:765`).
- A second full body parse plus a `JSON.stringify` rewrite of the model field
  (`inference.ts:490`, `:515`), then `forwardGeneration` parses it a third time
  (`inference.ts:747`).

## Findings

### F1 — Provider resolution reads the same rows repeatedly (high)

`getProvider(id)` performs `db.providers.getProvider` and then `#viewOf(id)`,
which performs `db.providers.getProvider` *again*, then `#keysOf` performs
`listKeys` plus a *third* `getProvider`, then `#accountsOf` performs
`listAccounts` (`provider-registry.ts:365-369,1946,1885,1889,1919`). That is
five queries for one provider read.

`resolveProvider` calls `getProvider` (`:380`) and `resolveInference` then
re-reads provider and keys (`:1457,1463`). Nothing memoizes within a request.

Consequence: every inference request pays roughly 7 provider/key/account reads
before contacting the upstream. `listProviders()` is worse: one list plus four
reads per provider (`provider-registry.ts:355-363`), which multiplies through
admin, metrics, and gateway discovery.

### F2 — Gateway Key is looked up and hashed up to 3× on the global path (high)

`#locateKey` unconditionally reads the key row and recomputes SHA-256
(`gateway-key-registry.ts:471-473`, `secrets.ts:18-20`). `#authorizeScope`
writes `markUsed` on every successful authorization (`:457`). The global
admission calls `discover`, `authorizeProvider`, and `authorizeInference`, each
of which locates and writes (`qualified-model.ts:40,45,49`). `discover` also
builds a provider directory the caller discards.

SHA-256 itself is cheap (single pass, no KDF, justified at `secrets.ts:11-17`),
so the cost is the redundant DB reads and writes, not the hash.

### F3 — The schema has one index; hot-path columns are unindexed (high)

`providers_handle_unique` is the only explicit index in the repo
(`migrations/sqlite/0018_amusing_elektra.sql:42`,
`migrations/postgres/0019_smart_sunspot.sql:22`). Drizzle schemas define no
indexes (`rg "index\(" src/persistence` returns nothing). Foreign keys are not
auto-indexed by SQLite or PostgreSQL. Missing indexes on the hot path:

| Column | Used by | Evidence |
|---|---|---|
| `upstream_keys.provider_id` | every `resolveInference`, every provider list | `database.ts:484-491` |
| `key_model_availability.provider_id` | key-scoped routing, model-sync job | `database.ts:1232-1238` |
| `request_events.occurred_at` | history list, overview, retention prune | `database.ts:1483-1536` |
| `request_attempts.request_id` | attempts read + FK cascade on delete | `database.ts:1465-1472` |
| `owner_sessions.expires_at` | expiry sweep on every `sessions()` | `database.ts:350-356` |
| `audit_events.occurred_at` | audit page | `database.ts:1545-1558` |
| `upstream_accounts.provider_id` | `#viewOf` N+1 | `database.ts:534-541` |

`model_catalog_entries` is covered by its `(provider_id, model_id)` primary key
(`sqlite/schema.ts:189`). `request_attempts` has no index on `request_id`, which
also makes the FK cascade expensive during retention pruning
(`migrations/postgres/0010_ancient_warstar.sql:32`).

### F4 — Request history is written synchronously in the response path (high)

`startAttempt` performs `recordEvent` + `recordAttempt` before the upstream call
(`inference.ts:896`, `request-history.ts:203-216`). On a streaming 2xx, three
awaited writes (`recordInferenceSuccess`, `updateAttempt`, `recordEvent`) run
before `monitorResponse` hands the stream to the caller (`inference.ts:948-969`;
Anthropic mirror at `:1617-1635`). This directly inflates time-to-first-byte by
a full write round-trip chain per request, and on SQLite it contends with the
single writer.

Retention is on by default (`request-history.ts:151,422`), so this is the normal
path, not an opt-in.

### F5 — Streaming response monitor ignores backpressure (high)

`monitorResponse` reads the upstream as fast as it can inside `start()` and
enqueues every chunk without consulting `desiredSize`
(`inference.ts:2589-2606`). A slow caller causes unbounded queue growth in
memory. `deadlineGuard` does this correctly with a `pull`-driven source
(`:2859-2887`); `monitorResponse` should match it or be replaced by a
`TransformStream`/`pipeThrough`.

### F6 — Every SSE event is parsed and re-encoded even when unchanged (medium)

`createOpenAiStreamingNormalizer` is applied to all `text/event-stream`
responses (`generic-adapter.ts:122-123`). For each event it decodes, splits,
`JSON.parse`s, and re-encodes (`:394-414,504-554`), even when the provider uses
a separate `reasoning_content` field and nothing needs rewriting (the common
case; `normalizeSseEvent` returning `null` still re-encodes at `:412`). The
global path adds a second decode/parse/stringify/encode stage purely to prefix
the model id (`inference.ts:626-673`).

Two further streaming issues:

- **Unused accumulation** — translated Anthropic streams retain all response
  text and tool-call JSON for the whole stream (`anthropic-adapter.ts:1224,1276,1288`)
  for fields documented as not yet consumed (`:955-957`).
- **Shared decoder state** — module-level `TextDecoder` instances are reused
  with `{ stream: true }` across concurrent streams (`generic-adapter.ts:363`,
  `anthropic-adapter.ts:983`). A `TextDecoder`'s streaming state is per-instance,
  so concurrent streams can corrupt multi-byte splits. This is a correctness
  bug adjacent to performance, not just an allocation.

### F7 — Global body is parsed twice and re-serialized once (medium)

`admit` does `request.clone().json()` (`inference.ts:490`) then
`JSON.stringify({ ...input, model })` into a new `Request` (`:514-517`), and
`forwardGeneration` parses the rebuilt body again (`:747`). For non-streaming
responses the whole body is also re-read and `JSON.stringify`'d to rewrite the
model (`:628-669`). Parsing once and carrying the parsed object, or rewriting
the single `model` string in place, removes a full-body allocation per request.

### F8 — Persistence configuration uses defaults (medium)

SQLite (`src/persistence/sqlite/database.ts:97-102`) sets only
`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. `synchronous`,
`cache_size`, `temp_store`, and `mmap_size` are unset, so WAL commits keep the
default fsync behavior and the page cache stays small. `synchronous=NORMAL` is
the usual WAL companion and trades a power-loss window for materially lower
write latency; it is a deployment choice, not a default to change blindly.

PostgreSQL (`src/persistence/postgres/database.ts:84`) passes only
`connectionString`, so pg-pool defaults apply: `max=10`, no
`connectionTimeoutMillis`, no `statement_timeout`, no idle recycling, no SSL
configuration. Every Drizzle statement checks out a pooled client for a single
query (`drizzle-orm/node-postgres/session.js`), so the N+1 patterns above
consume pool slots one statement at a time. No `.prepare()` is used anywhere;
SQLite re-prepares each statement (`bun-sqlite/session.js`) and Postgres issues
unnamed extended-protocol queries.

### F9 — Management-key auth rewrites a JSON blob per request (medium)

`ManagementKeyRegistry.authenticate` reads the entire key list from `settings`,
mutates `lastUsedAt`, and writes the whole list back, outside a transaction
(`src/identity/management-key-registry.ts:81-87,121-123`). Cost and lost-update
race both scale with the number of keys.

### F10 — Metrics scrape is an N+1 over providers (medium)

`GET /metrics` reads the metrics-exposure setting (uncached,
`src/metrics/metrics.ts:104-108`) and calls `providers.listProviders()`
(`src/http/metrics.ts:52`), which is the one-plus-four-per-provider pattern from
F1 and includes decrypting static headers per provider. Cardinality is bounded
and safe (labels are only outcome/kind/bucket/health state,
`metrics.ts:7-14,71-92`), so the fix is a lean aggregate query, not label
pruning.

### F11 — Background scheduler stampedes on startup (medium)

`#nextDueAt` is empty on the first tick, so every job is due
(`src/jobs/scheduler.ts:194`), and `start()` schedules that tick 250 ms after
boot (`:204-210`), right after the port binds. All jobs — including
`modelSync`, `usage`, and `cooldownRecovery`, each iterating every provider
(`src/jobs/jobs.ts:92,151,186`) — run in one serial tick. There is no jitter or
initial delay. On SQLite these share the single writer with inference.

### F12 — Catalog and metadata work is recomputed (medium)

- Admin `view()` performs a template-knowledge DB write on every read
  (`src/models/catalog-service.ts:216,587-592`).
- `models-dev` metadata is fetched lazily with a 15-minute in-memory cache
  (`src/models/models-dev-metadata.ts:36,50-113`), which is fine, but a lookup
  miss scans every catalog value and `JSON.stringify`s each candidate
  (`:172-194,255-259`).
- `listForScope` re-reads and re-sorts catalog entries per Models-list request
  (`catalog-service.ts:550-585`), and `isExcluded` is a separate read per
  inference request (`inference.ts:765`).

### F13 — Startup migrations can block for a long time on large installs (low/medium)

Migrations run after `readiness.markConfigured()` and before `app.listen`
(`src/runtime/startup.ts:92,222`), and the `providers_handle_unique` backfills
(`migrations/sqlite/0018_amusing_elektra.sql:3-40`,
`migrations/postgres/0019_smart_sunspot.sql:3-22`) run in that blocking window.
The Postgres backfill loops with `WHILE EXISTS (SELECT 1 FROM providers WHERE handle = candidate)`
*before* the unique index exists, making it roughly quadratic in providers.

### F14 — Wiring defects that waste or disable work (low)

- `createApp` builds a second `AdapterRegistry` and generic inference adapter
  because `startIroha` never passes `adapterRegistry`/`inference`
  (`src/runtime/startup.ts:203-220` vs `src/http/app.ts:116-117`).
- `brandLogos` is never passed, so the no-op service is always used and
  `logoDevToken` (`environment.ts:94`) is dead config
  (`src/http/app.ts:230,392-397`).
- `transportDefaults` is documented as read from settings but is a compile-time
  constant (`src/http/app.ts:76,163`; `inference.ts:146`), so transport timeouts
  are not actually owner-configurable.

## Part A — The web side findings

### W1 — No response compression anywhere (high)

No compression plugin is installed or registered. `package.json:20-26` has no
compression dependency, `src/runtime/startup.ts:222` calls `app.listen` with no
options, and `src/http/app.ts:166` builds a bare `new Elysia()`; grep for
`compress|gzip|brotli` in `src/` finds nothing. The built UI is a single
970,977-byte JS file and a 70,845-byte CSS file plus 11 font files
(`ui/dist/assets/index-BsNIjyTu.js`, `index-BAACuJ3E.css`). Impact: the first
paint and every JSON response ship uncompressed, typically 4–6× more bytes than
gzip.

### W2 — One bundle, no code splitting, chart code eager (high)

There is no `React.lazy` or dynamic `import()` in the UI (only type-position
`import('@/lib/requests')` at `ui/src/components/providers-area.tsx:879`), and
`ui/vite.config.ts:36-39` sets no `manualChunks`. `ui/src/router.tsx` statically
imports `Overview`, `ProvidersArea`, and `ProviderDetail`, which statically
import the visx/d3 chart tree (`overview.tsx`, `providers-area.tsx:28`,
`provider-detail.tsx:56`). Impact: the login screen and every non-chart page
parse and execute the entire chart library.

### W3 — Every history read runs an `abandonRequests` UPDATE (high)

`RequestHistoryService.listEvents` and `getEvent` both call
`abandonRequests(...)` before reading (`src/history/request-history.ts:315-327`),
and `abandonRequests` filters `lifecycle='in_progress' AND occurred_at < ?` with
no index. Impact: a read mutates the table, full-scans it, and on SQLite takes
the single writer lock ahead of inference. The fix is an index on
`(lifecycle, occurred_at)` (F3) plus moving abandonment to a scheduled job
rather than the read path.

### W4 — The Providers list page pulls 800 request rows to draw sparklines (high)

`ui/src/components/providers-area.tsx:83` calls `useRequestHistory()`, which
sets `REQUEST_HISTORY_LIMIT = 800` (`ui/src/lib/use-providers.ts:110-116`) and
hits `GET /api/v1/admin/requests?limit=800`. Combined with W3 that is an
UPDATE + unindexed `COUNT(*)` + 800-row read per Providers page load, aggregated
in JS by `buildTrafficByProvider` (`providers-area.tsx:878-916`). Impact: a page
whose real need is per-provider totals does a large time-range fetch.

### W5 — Overview aggregates a whole time range in JavaScript (high)

`RequestHistoryService.overview` calls `listEvents({ filter: { after } })` with
no limit (`src/history/request-history.ts:333-375`), then buckets statuses,
counts models, and computes p50/p95/p99 by copying and sorting latency arrays
(`:453-457`). The route (`src/http/request-history.ts:60-78`) exposes this as
`GET /api/v1/admin/requests/overview`, which the Overview loader warms on every
cold load (`ui/src/router.tsx:122-132`). Impact: a 7-day range loads the entire
`request_events` window into memory; on a busy install this grows without
bound. SQL aggregation (`GROUP BY` bucket, `percentile_cont` on Postgres,
ordered counts on SQLite) removes the JS work.

### W6 — Provider listing is the shared 1+4N bottleneck (high)

Cross-references F1. The admin route calls `providers.listProviders()`
(`src/http/admin.ts:106`), which is one list query plus four queries per
provider (`src/providers/provider-registry.ts:355-363,1945-1966,1884-1919`).
Every page that shows providers (Providers, Provider detail, Requests filter
bar, Overview) and every metrics scrape (`src/http/metrics.ts:52`) pays it.
Impact: a 20-provider fleet is ~81 queries per page view.

### W7 — Static assets: two stats, no `ETag`, immutable applied to non-hashed files (medium)

`src/http/frontend.ts:24-37` does `Bun.file(...).exists()` for `index.html` and
again for the requested asset on every request, sets no `ETag`/`Last-Modified`,
and never honours `If-None-Match`/`If-Modified-Since`. The immutable header is
applied to every existing file (`:16,35`), including non-hashed assets such as
`/brand/iroha-sidebar-banner.jpg` and `/brand/iroha-favicon.png`
(`ui/dist/brand/`, 74 KB and 100 KB). Impact: the 970 KB bundle is re-downloaded
on a hard refresh; replacing a non-hashed image requires renaming it or it stays
cached for a year.

### W8 — No virtualization, and a full chart per Provider row (medium)

`ui/src/components/providers-area.tsx:155-163` maps every provider, and each row
mounts `ProviderSparkline` → a full `LineChart` (visx `ParentSize` + scales)
at `:288,844-876`. `Overview` mounts six charts plus four sparklines eagerly
(`ui/src/components/overview.tsx:163,211,504`). Impact: a 20-provider list
mounts 20 independent chart subtrees plus the 800-event aggregation from W4.

### W9 — Hover warms providers, fanning out expensive reads (medium)

`useWarmProvider` fires `ensureQueryData(providerQueryOptions(id))` on mouse
enter/focus (`ui/src/lib/use-providers.ts:95-103`,
`ui/src/components/providers-area.tsx:251-252`). Each distinct provider is a
distinct query key, so sweeping the pointer across a 20-row list issues up to 20
`GET /providers/:id` requests, each the 1+4N operation from W6. Impact: idle
pointer movement creates cross-fleet read load.

### W10 — `background_jobs` is written on every status read (medium)

`BackgroundScheduler.listStatus` calls `ensureIdle` per job
(`src/jobs/scheduler.ts:158-182`), which is an `INSERT ... ON CONFLICT DO UPDATE`
(`src/persistence/sqlite/database.ts:1664-1679`), and the Overview loader
triggers it on every load. Impact: five upserts and `updatedAt` bumps per page
load even when no job ran; a read should not be a write.

### W11 — No polling; live job state goes stale in an open tab (low)

`ui/src/lib/query-client.ts:16,27-36` sets `staleTime = 30_000` and a
focus-refetch policy, and there is no `refetchInterval` anywhere in `ui/src`.
Impact: a running background job's status does not advance while the tab stays
open; conversely, `refetchOnWindowFocus` re-runs the expensive provider load
without throttling.

### W12 — Session and management-key auth overhead per request (medium)

Cross-references F9. `GET /api/v1/auth/state` does an owner SELECT plus session
validation on every app mount (`src/http/auth.ts:49-60`, `ui/src/App.tsx:74-76`).
`GET /auth/sessions` runs a DELETE expiry sweep then a full SELECT on an
unindexed `expires_at` (`src/identity/owner-identity.ts:283-285`). Management-key
auth reads and rewrites the entire key blob on every request
(`src/identity/management-key-registry.ts:74-89`). Impact: admin requests and
app mount pay avoidable DB work; the blob cost scales with key count.

### W13 — Audit listing is an unindexed count plus sort over an append-only table (medium)

`GET /api/v1/admin/audit` counts and orders the whole `audit_events` table with
no index on `occurred_at` (`src/http/audit.ts:24-49` →
`src/persistence/sqlite/database.ts:1538-1559`), and audit is only ever cleared
manually (`src/http/audit.ts:70`). Impact: audit page latency grows forever.

## Part B — The proxy side findings

### X1 — There is no custom upstream transport; keep-alive, pooling, DNS, TLS, and HTTP/2 are Bun defaults (high)

Every upstream call is a bare `globalThis.fetch`; grep finds no
`undici|Agent|Dispatcher|http2|https.Agent|keepAlive|lookup|servername` in
`src/` (only the unrelated Postgres pool). Adapters capture fetch once at
construction (`src/inference/generic-adapter.ts:81`,
`src/inference/anthropic-adapter.ts:98`, `src/providers/key-probe.ts:46`,
`src/usage/zai-usage-adapter.ts:142`, `src/usage/minimax-usage-adapter.ts:367`).
`Connection`/`Keep-Alive` are filtered from caller headers and never set
(`src/inference/blocked-headers.ts:10,15`), so pooling is entirely
runtime-controlled. Impact: Iroha cannot raise per-origin socket limits, enable
HTTP/2, cache DNS, or reuse TLS sessions for the proxy hot path; discovery
traffic shares the same unpartitioned pool as inference.

### X2 — `connectionTimeoutMs`, `firstByteTimeoutMs`, and `nonStreamingTotalTimeoutMs` are dead configuration (high)

These fields exist on the adapter contract (`src/inference/adapter.ts:40-48`)
and the route passes them on every attempt (`src/http/inference.ts:925-929`),
but no adapter reads them: a grep restricted to `src/inference` finds them only
in `adapter.ts`. The generic adapter passes only `signal` to fetch
(`src/inference/generic-adapter.ts:295-301`). Impact: a hung connect or a slow
non-streaming body is bounded only by the caller's signal. The advertised
connect/first-byte/total limits do not exist. Only the streaming deadlines
(`streamingHeaderMs`/`streamingIdleMs`) are real, via `deadlineGuard`
(`src/http/inference.ts:2825-2893`, resolved at `:2906-2917`), and
`firstByteTimeoutMs` doubles as the streaming-header fallback
(`:2913`).

### X3 — The same-origin redirect wrapper has no hop limit or loop guard (high)

`fetchWithSameOriginRedirects` is a `while (true)` loop that re-fetches on every
same-origin 3xx (`src/inference/generic-adapter.ts:294-318`), with no cap.
Discovery calls it with `signal: null` (`src/models/catalog-service.ts:426`), so
a same-origin redirect cycle (`/a → /b → /a`) loops until the process or socket
gives up. Method and body are replayed verbatim, so a 303 that should downgrade
POST→GET is followed as POST. Impact: a misbehaving upstream can pin a request
indefinitely and burn round-trips.

### X4 — The Anthropic adapter silently follows redirects, unlike the generic adapter (medium/high)

Only the generic adapter sets `redirect: 'manual'`
(`src/inference/generic-adapter.ts:299`). The Anthropic adapter's fetch calls
(`src/inference/anthropic-adapter.ts:122-127,159,1549`) omit `redirect`, so
Bun's default follow applies, including cross-origin. Impact: hidden round-trips
the Iroha retry/classification layer never sees, and a possible cross-origin
forwarding of `x-api-key`/`anthropic-version` that the generic path explicitly
refuses.

### X5 — Same-key backoff delays failover, and `Retry-After` can add 60 s (medium)

`classifyGenericFailure` maps every 5xx to `retry_same`
(`src/inference/generic-adapter.ts:457-459`), which sleeps via
`retryBackoffMs` (`src/http/inference.ts:1011-1017`) before an alternate key is
considered. Backoff is capped at 8 s, but a `Retry-After` hint raises a single
sleep to 60 s (`:128-143`). `try_alternate` itself does not sleep (`:1005-1010`),
and `totalRetryTimeoutMs` only stops *starting* attempts, not an in-flight one
(`:809`). Impact: with a healthy alternate key available, a 5xx provider can
still delay the first byte by up to two backoffs plus a possible 60 s hint.

### X6 — Non-streaming bodies are parsed and serialized up to three times (medium)

Cross-references F7. The adapter reads the body once and `normalizeOpenAiResponseBody`
`JSON.parse`s it and conditionally `JSON.stringify`s the whole document
(`src/inference/generic-adapter.ts:128,170-195`); the route then `parseUsage`s
the same string again (`src/http/inference.ts:48-71,1117`); the global route
`JSON.parse`s/`JSON.stringify`s it a third time to rewrite the model
(`:623-629,656-673`). Impact: large completions pay repeated full-body
serialization and GC pressure.

### X7 — `accept-encoding` is forwarded and upstream `content-encoding`/`content-length` are copied wholesale (medium, needs runtime verification)

`accept-encoding` is not in the blocked set (`src/inference/blocked-headers.ts:8-34`),
and response headers are copied verbatim from the upstream Response
(`src/inference/generic-adapter.ts:121-134`). If the Bun runtime transparently
decodes a compressed upstream body while leaving `content-encoding`/
`content-length` in `response.headers`, the caller can attempt a second decode
or truncate on a stale length. This is the classic double-compression risk and
should be confirmed with a gzip upstream before changing anything.

### X8 — Catalog discovery is fully serial across keys (medium)

`ModelCatalogService.refresh` awaits each discovery target in a `for` loop
(`src/models/catalog-service.ts:266-269`), and `discoverMissingKeys` does the
same (`:387-400`). Key probing is already bounded to five concurrent probes
(`src/providers/provider-registry.ts:264,1845`), so the catalog path is the
outlier. Impact: a key-scoped Provider with N keys pays N serial upstream GETs;
one slow key gates the rest.

### X9 — Usage adapters have no request timeout (medium)

`zai-usage-adapter.ts:152` and `minimax-usage-adapter.ts:335` pass only
`request.signal`; when the scheduler calls them without a signal there is no
bound, unlike the key probe and metadata fallback which use
`AbortSignal.timeout` (`src/providers/key-probe.ts:65`,
`src/models/models-dev-metadata.ts:66`). Impact: a hung entitlement read can
occupy a usage refresh indefinitely while sharing the pool with inference.

## Prioritized recommendations

Ordering favors changes that are local, low-risk, and remove whole round-trips.
Each item should be validated against the local harness before shipping.

### P0 — high impact, small blast radius

1. **Add the missing indexes** (F3) in one migration for each dialect:
   `upstream_keys(provider_id)`, `key_model_availability(provider_id)`,
   `request_events(occurred_at)`, `request_attempts(request_id)`,
   `owner_sessions(expires_at)`, `audit_events(occurred_at)`,
   `upstream_accounts(provider_id)`. This is the single highest-leverage change
   and requires no behavior change.
2. **Collapse provider reads per request** (F1). Have `resolveProvider` load the
   provider, keys, and accounts once and pass that snapshot into
   `resolveInference`, or add a request-scoped loader. Remove the duplicate
   `getProvider` in `getProvider`/`#viewOf` and the redundant `getProvider` in
   `#keysOf`. Target: one provider read plus one keys read per request.
3. **Authenticate the Gateway Key once per request** (F2). Split
   "authenticate" from "authorize scope", replace the `discover()` call in
   `admit` with a single locate, and pass the located key through
   `authorizeProvider`/`authorizeInference`. Keep one `markUsed`.
4. **Move request-history writes off the first-byte path** (F4). Accumulate
   attempt/terminal metadata in memory and flush after the response (or stream)
   is returned, or batch attempt + event into one write. Never await three DB
   writes between the upstream 2xx and handing back the stream.
5. **Fix streaming backpressure** (F5). Reimplement `monitorResponse` as a
   `pull`-driven source like `deadlineGuard`, or attach activity tracking via a
   `TransformStream` and `pipeThrough` so the readable queue is bounded.

### P1 — meaningful, medium effort

6. **Fast-path the SSE normalizer** (F6). Skip `createOpenAiStreamingNormalizer`
   for templates that do not emit inline reasoning tags, or short-circuit events
   that contain none of the keys it would touch. Create a decoder per stream
   instead of sharing a module-level one (also fixes the concurrency bug).
7. **Parse the global body once** (F7). Carry the parsed object from `admit` and
   avoid `request.clone().json()` plus re-`JSON.stringify`.
8. **Tune persistence** (F8). Consider `synchronous=NORMAL`, `temp_store=MEMORY`,
   a larger `cache_size`, and `mmap_size` for SQLite; set pg-pool `max`,
   `connectionTimeoutMillis`, `statement_timeout`, `idleTimeoutMillis`, and
   optional SSL. Expose these as deployment settings rather than hard-coding.
9. **Give the scheduler an initial jitter/stagger** (F11) and avoid running
   heavy model-sync/usage jobs at boot; respect a first-run delay.
10. **Remove the `view()` write and memoize catalog reads** (F12): only sync
    template knowledge when template knowledge changed, cache `isExcluded` per
    request, and cache the Models-list projection.
11. **Leann the `/metrics` route** (F10): aggregate key health with one query,
    cache the exposure setting.

### P2 — correctness and cleanup

12. Drop the unused Anthropic stream accumulators (F6).
13. Stop rewriting the whole management-key list for `lastUsedAt` (F9).
14. Fix the duplicate registry/adapter construction and either wire
    `brandLogos`/`transportDefaults` or remove the dead configuration (F14).
15. Cache static-file existence checks and emit an `ETag` (`frontend.ts:26,34`).
16. Replace per-chunk `setTimeout`/`clearTimeout` in `deadlineGuard` with a
    deadline check plus a single armed timer (F6, `inference.ts:2883-2886`).

### Web side roadmap

- **W1 (compression)** is the cheapest large win: add gzip/brotli for
  `application/json`, `text/html`, `text/css`, and JS, but explicitly exclude
  `text/event-stream` so SSE is not buffered.
- **W2 (code splitting)** — lazy-load `ProviderDetail` and the chart tree, and
  set `build.rollupOptions.output.manualChunks` to split `@visx/*`/`d3-*`/
  `motion` out of the entry bundle.
- **W3 + W5 + W13 (history)** — add `(lifecycle, occurred_at)` and
  `occurred_at` indexes (F3), move `abandonRequests` off the read path, and
  compute Overview buckets and percentiles in SQL.
- **W4 (800-row page fetch)** — replace the Providers-page request fetch with a
  small server aggregate endpoint (per-provider counts/latency buckets) so the
  sparkline data is computed once, not shipped as 800 rows.
- **W6 (1+4N)** — fix the shared provider listing (F1) and deepen the metrics
  route (F10).
- **W7 (static)** — cache the `exists()` results/stat map at startup, honour
  `If-None-Match`, and scope immutable caching to content-hashed filenames only.
- **W8 + W9 (render/fan-out)** — virtualize long provider/request lists, render
  sparklines from pre-aggregated series, and drop or debounce hover warming.
- **W10 (write-on-read)** — seed job rows once at startup; `listStatus` should
  read, not upsert.
- **W12 (auth)** — give management keys their own rows (or a background
  `lastUsedAt` flush) instead of a whole-blob rewrite per request.

### Proxy side roadmap

- **X2 (dead timeouts)** is the highest-value proxy fix: enforce
  `connectionTimeoutMs`/`firstByteTimeoutMs`/`nonStreamingTotalTimeoutMs` with
  an `AbortController` or `AbortSignal.any([signal, AbortSignal.timeout(...)])`
  in the generic and Anthropic adapters.
- **X3 + X4 (redirects)** — add a hop cap and loop guard to
  `fetchWithSameOriginRedirects`, and give the Anthropic adapter the same
  `redirect: 'manual'` policy (or an explicit, documented decision to follow).
- **X5 (failover)** — consider classifying repeated 5xx as an alternate-key
  action, or cap the pre-failover backoff, so a healthy alternate is tried
  before the first long sleep.
- **X8 (discovery)** — run catalog discovery with the same bounded concurrency
  as key probing (`forEachWithConcurrency`).
- **X9 (usage timeout)** — apply `AbortSignal.timeout` to usage-adapter calls.
- **X1 (transport)** — if per-origin socket control or HTTP/2 matters, this
  needs a deliberate Bun-native transport decision; today there is no seam.
  This is a design choice, not a quick patch.
- **X6 + X7** — verify the double-parse cost and the compression-header
  behavior with a real gzip upstream before optimizing.

## How to measure before and after

No numbers in this document are measured. Validate with the existing seams:

- **Per-request DB counts.** Count repository calls (or enable a query counter)
  while driving `test/support/inference.ts` against the fake upstream. Expect
  the P0 items to reduce a scoped success from ~10 reads + 5 writes to roughly
  3-4 reads + 2-3 writes; measure rather than assume.
- **TTFB.** Time the gap between the upstream fake's first chunk and the
  caller's first read; F4 should move it to near zero.
- **Query plans.** Run `EXPLAIN QUERY PLAN` (SQLite) and `EXPLAIN ANALYZE`
  (Postgres) for the `listKeys`, catalog, and history queries before/after F3.
- **Streaming memory.** Feed a large stream to a deliberately slow consumer and
  watch resident memory before/after F5.
- **Startup and migration time.** Time `startIroha` on a seeded large database
  before/after F13/F11.
- **Concurrency.** Run concurrent streams with multi-byte UTF-8 content across
  chunk boundaries to confirm the shared-decoder fix (F6).

Web side:

- **Transfer size.** Build the UI and compare `Content-Length` and compressed
  size of `/` and a providers JSON response before/after W1; confirm SSE is not
  compressed.
- **Bundle split.** Inspect the Vite build output for the entry chunk size and
  chart chunks before/after W2; load the login route and confirm chart code is
  absent from the initial network waterfall.
- **Page ledger.** Count endpoints and DB queries per page (Overview, Providers,
  Provider detail, Requests, Audit) with a query counter; expect W3–W6, W10,
  W13 to cut the largest contributors.
- **History query plans.** `EXPLAIN QUERY PLAN` on the `request_events` list,
  count, and `abandonRequests` statements before/after the index and
  read-path changes.
- **Static caching.** Verify `ETag`/`304` behavior and that immutable is only
  sent for hashed filenames.

Proxy side:

- **Timeout enforcement.** Point a provider base URL at a socket that accepts
  and never responds; confirm the request fails at the configured connect /
  first-byte / total limit after X2 (today it should hang).
- **Redirect guard.** Serve a same-origin redirect loop to
  `fetchWithSameOriginRedirects` and confirm it terminates at a hop cap (today
  it should loop).
- **Failover latency.** With one failing key and one healthy key, measure time
  to first byte before/after X5.
- **Discovery wall time.** Refresh a key-scoped provider with N keys and compare
  serial vs bounded-concurrency discovery (X8).
- **Compression headers.** Proxy a gzip-encoded upstream and inspect the
  downstream `content-encoding`/`content-length` and body integrity (X7).

## Appendix — query inventory for one scoped streaming success

| # | Operation | Kind | Source |
|---|---|---|---|
| 1 | `gatewayKeys.get` | SELECT | `gateway-key-registry.ts:471` |
| 2 | `markUsed` | UPDATE | `gateway-key-registry.ts:457` |
| 3 | `modelCatalog.isExcluded` | SELECT | `inference.ts:765` |
| 4 | `providers.getProvider` (public) | SELECT | `provider-registry.ts:366` |
| 5 | `providers.getProvider` (`#viewOf`) | SELECT | `provider-registry.ts:1946` |
| 6 | `providers.listKeys` (`#keysOf`) | SELECT | `provider-registry.ts:1885` |
| 7 | `providers.getProvider` (`#keysOf`) | SELECT | `provider-registry.ts:1889` |
| 8 | `providers.listAccounts` (`#accountsOf`) | SELECT | `provider-registry.ts:1919` |
| 9 | `providers.getProvider` (`resolveInference`) | SELECT | `provider-registry.ts:1457` |
| 10 | `providers.listKeys` (`resolveInference`) | SELECT | `provider-registry.ts:1463` |
| 11 | key availability (key-scoped templates only) | SELECT | `provider-registry.ts:1466` |
| 12 | `recordEvent` (upsert) | WRITE | `request-history.ts:203`, `:181` |
| 13 | `recordAttempt` (INSERT) | WRITE | `request-history.ts:205` |
| 14 | `providers.getKey` (`recordInferenceSuccess`) | SELECT | `provider-registry.ts:1559` |
| 15 | `updateAttempt` | WRITE | `request-history.ts:224` |
| 16 | `recordEvent` (terminal upsert) | WRITE | `request-history.ts:258` |

The global `/v1/...` variant adds three `#locateKey` reads, three `markUsed`
writes, a full `providers` scan, a `getProvider`/`listEntries` N+1 in `discover`,
a provider-by-handle read, and a second `isExcluded`.