# 12 — Advanced Provider transport policy

**What to build:** The Owner can configure unusual compatible Provider transport behavior without weakening Iroha's credential and proxy boundary.

**Blocked by:** 05 — Single-key Chat Completions path; 07 — Streaming Chat Completions.

**Status:** done

- [x] Advanced settings support adapter-approved authentication header formats and encrypted static headers without arbitrary executable code.
- [x] HTTPS is required by default; explicit insecure HTTP is connection-scoped and visibly warned.
- [x] Redirects are rejected by default; explicitly enabled same-origin redirects cannot leak credentials cross-origin.
- [x] Global connection, first-byte, non-streaming total, streaming idle, and total retry timeout defaults support Provider Connection overrides.
- [x] Ambiguous network retry policy is configurable and defaults off.
- [x] Adapters declare supported idempotency headers and whether Iroha generation is safe.
- [x] Browser inference CORS is disabled by default and may allow explicit origins globally or per Gateway Key without wildcard credentials.
- [x] Callers can never supply or override arbitrary upstream destinations, authentication, or proxy-control headers.
- [x] Security-focused HTTP tests cover SSRF boundaries, redirects, headers, CORS, idempotency, timeouts, and redaction.

## Comments

Built on the existing inference and persistence scaffolding. The advanced transport fields (`authHeader`, `authPrefix`, `staticHeaders`, `redirectAllowSameOrigin`, `connectionTimeoutMs`, `firstByteTimeoutMs`, `nonStreamingTotalTimeoutMs`, `streamingIdleTimeoutMs`, `totalRetryTimeoutMs`, `idempotencyHeader`) now flow from the admin HTTP routes through the registry into the SQLite and PostgreSQL repositories (migration `0009_advanced_provider_transport.sql`). Validation is structural: header names are `[A-Za-z0-9-]{1,128}` or the approved `Authorization`, `X-Api-Key`, `Api-Key`; static headers are encrypted as one JSON blob and only their names are exposed in `ConnectionView`.

The generic Inference Adapter (`src/inference/generic-adapter.ts`) declares capabilities (`Idempotency-Key` with safe generation) and merges caller-safe headers, the configured authentication header (case-insensitive overwrite of any caller-supplied one), and the connection's static headers. The wrapper manually walks `Location` for same-origin redirects only, leaving credentials in place on same-origin hops and returning the redirect response itself when the target crosses host.

CORS lives in `src/http/inference.ts` with three layers: a same-origin fast path that strips all CORS machinery, an OPTIONS preflight that echoes the allow-listed origin with the configured methods/headers, and a per-request check that consults a per-Gateway-Key `corsOrigins` list (looked up by bearer token) and then the global `transportDefaults.corsAllowedOrigins`. Wildcards are rejected at key-creation time.

Caller `Host`, `X-Forwarded-*`, `Cookie`, `Authorization`, `X-Real-IP`, `X-Request-Id`, `Origin`, and proxy-control headers are stripped before the request leaves Iroha; the connection's `staticHeaders` overwrite any caller-supplied header with the same lowercase name.

Tests added: 23 HTTP cases in `test/http/inference-security.test.ts` covering SSRF header boundaries, caller's auth smuggling, static-header precedence, cross-origin and same-origin redirects, idempotency forwarding and generation, CORS denial/same-origin/global/per-key/preflight/wildcard rejection, advanced field validation (auth header shape, prefix control characters, timeout bounds, explicit insecure-HTTP warning), static-header encryption at rest, and a runtime test that proves a per-connection streaming-idle override actually shortens the watchdog (the test uses no route-level `streamingTimeouts` override, so the only deadline is the per-connection one).

Full suite: 508 pass / 1 skip / 0 fail; typecheck clean.

Code-review follow-ups applied — the dead `mergeAuthValue` function (both branches identical) is gone, the unused `authHeader`/`staticHeaderNames` parameters in the redirect wrapper are gone, the `reactiveOnlyAdapter()` Middle Man in `createApp` is inlined, the per-connection `firstByteTimeoutMs`/`streamingIdleTimeoutMs` overrides now actually drive `deadlineGuard` (a small `streamingTimeoutsFor` helper picks the route test override, then the per-connection values, then the global `transportDefaults`), and the redirect docstring no longer overstates the cross-origin behaviour.

