# Management API for headless agents

Status: Research proposal

## Question

How should Iroha let agents perform every Owner operation—creating and editing Providers, managing Upstream Keys, refreshing the Model Catalog and usage, running background jobs, and changing settings—without driving the management UI?

## Executive conclusion

Iroha already exposes nearly all of these operations as JSON endpoints under `/api/v1/admin`, and publishes them from `/docs` and `/docs/json`. The UI is a client of that API; it is not the only implementation of the operations. The real blocker is that every administrative route accepts only an Owner Session cookie, while mutations additionally require its per-session CSRF token. A headless client can technically call `/api/v1/auth/login`, retain the cookie, read the returned CSRF token, and send `x-iroha-csrf`, but that makes an agent hold the Owner password and emulate browser session lifecycle.

The recommended feature is therefore **Management Keys** (name subject to the domain-model decision): revocable, scoped bearer credentials for automation, accepted by the existing admin routes through one shared guard. Do not give Gateway Keys administrative powers and do not create a duplicate `/agent` API. Keep Owner Session authentication for browsers, add Management Key authentication for non-browser callers, and describe both alternatives in the existing OpenAPI document.

This extends ADR-0005, whose decision specifically defines browser Owner Sessions as database-backed cookies. Because a durable machine principal broadens the management trust model, implementation should begin with a small ADR and a `CONTEXT.md` glossary addition rather than silently treating it as another Gateway Key.

## What exists today

Repository inspection on 2026-09-11 found these JSON surfaces:

- Provider lifecycle: list, inspect, handle availability, create, patch, archive, restore, duplicate, and purge.
- Upstream Key lifecycle: add one, bulk add, patch settings, test, reveal on demand, activate, disable, and delete.
- Legacy Upstream Account create, patch, and delete.
- Gateway Key list, inspect, create, patch, revoke, and delete.
- Model Catalog read, refresh, Owner model addition, exclusion/capability override, and deletion.
- Usage read and refresh.
- Request History list/detail/overview and retention settings.
- Audit feed list and clear.
- Background-job list/detail/manual run and schedule settings.
- Metrics read and exposure settings.
- Provider Templates, logo resolution, Owner Session lifecycle, readiness, and Gateway inference/directory routes.

The authoritative inventory is the route assembly and generated schema in [`src/http/app.ts`](../../src/http/app.ts), with individual routes in [`src/http/admin.ts`](../../src/http/admin.ts), [`src/http/catalog.ts`](../../src/http/catalog.ts), [`src/http/usage.ts`](../../src/http/usage.ts), [`src/http/background-jobs.ts`](../../src/http/background-jobs.ts), [`src/http/settings.ts`](../../src/http/settings.ts), [`src/http/metrics.ts`](../../src/http/metrics.ts), [`src/http/audit.ts`](../../src/http/audit.ts), and [`src/http/request-history.ts`](../../src/http/request-history.ts). The UI calls the same paths from [`ui/src/lib`](../../ui/src/lib). [`test/http/openapi.test.ts`](../../test/http/openapi.test.ts) verifies that admin operations are documented and currently declare only `OwnerSession` security.

The current guard in [`src/http/owner-guard.ts`](../../src/http/owner-guard.ts) requires a live cookie for every Owner route, plus `x-iroha-csrf` for a mutation. ADR-0005 records the reason for this browser-oriented design. This is sound for the UI but a poor automation credential exchange.

## Recommended design

### 1. Add a distinct machine credential

Create a Management Key resource with:

- stable ID, Owner-chosen name, creation/last-used/revocation timestamps;
- an unguessable secret displayed only once, a lookup prefix, and only a one-way verifier at rest;
- explicit scopes, initially `providers:read`, `providers:write`, `upstream-keys:write`, `upstream-keys:reveal`, `catalog:write`, `usage:refresh`, `jobs:run`, `settings:write`, `gateway-keys:write`, and `audit:read` (the exact grouping should be reduced after endpoint-by-endpoint threat review);
- optional expiry; revocation that takes effect immediately;
- an audit actor identity distinct from an Owner Session and Gateway Key.

Send it only as `Authorization: Bearer <secret>`. RFC 6750 standardizes bearer transmission in the `Authorization` header, warns against putting tokens in URLs, recommends restricting scope, and requires protected transport ([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)). Require HTTPS whenever Iroha is reachable beyond a trusted loopback/private deployment boundary.

Management Keys must remain a different credential type from Gateway Keys. A leaked inference credential should not become an administrative credential, and accepting both through an ambiguous bearer parser would invite function-level authorization mistakes. Prefixing key material by credential type and routing it through a shared, deny-by-default management authenticator makes this separation inspectable. OWASP specifically warns that administrative versus regular function separation is a common source of broken function-level authorization and recommends a consistent deny-by-default authorization module ([OWASP API5:2023](https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/)).

### 2. Reuse the existing routes and service methods

Keep `/api/v1/admin/...` as the single control-plane API. Refactor `OwnerGuard` into a management guard whose result is a principal:

- Owner Session: require same-origin checks and CSRF on mutations, preserving ADR-0005.
- Management Key: authenticate the bearer secret and require the operation's scope; CSRF is irrelevant because the secret is not ambient browser authority.

Route handlers should keep calling the existing registries/services so browser and agent behavior cannot drift. Every operation should declare an explicit scope in route metadata and tests; the `/admin` prefix is organization, not authorization. In this single-Owner product, object-level authorization is simple today, but checks must still occur after resolving each `{id}` if future project/tenant boundaries appear ([OWASP API1:2023](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)).

Bootstrap and recovery should remain interactive/deployment operations. An API client must not be able to mint its first Management Key anonymously. Owner Session endpoints can create/list/revoke Management Keys; optionally a deployment CLI can mint the first one locally.

### 3. Make long-running upstream work automation-safe

Provider creation, key addition/testing, Model Catalog refresh, usage refresh, and manual jobs cross an upstream boundary. Today several calls wait and return their final representation, which is usable but vulnerable to client timeouts and ambiguous retries.

Use job resources for operations that can exceed an ordinary request budget:

```text
POST /api/v1/admin/providers/{id}/catalog-refreshes
202 Accepted
Location: /api/v1/admin/operations/{operationId}

GET /api/v1/admin/operations/{operationId}
200 { status: "queued|running|succeeded|failed", ... }
```

RFC 9110 says a `202 Accepted` response is for processing not yet completed and ought to describe status and point to a status monitor ([RFC 9110, §15.3.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.3)). Collapse an already-running refresh for the same Provider or support a client-supplied deduplication key, because POST is not idempotent and agents will retry after connection failures ([RFC 9110, §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)). This can evolve compatibly: retain the current synchronous refresh endpoints initially, then add async job-form endpoints for automation.

Bound concurrency, queue length, execution time, bulk input size, and per-key/per-Provider trigger frequency. Return `429` plus `Retry-After` when appropriate. Model and usage refreshes consume upstream network/cost capacity; OWASP recommends operation, time, payload, record, and frequency limits for such endpoints ([OWASP API4:2023](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/); [RFC 6585, §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)).

### 4. Tighten mutation semantics without a wholesale rewrite

- Keep `POST` for server-assigned resources and actions. Return `201 Created` plus `Location` for newly created resources.
- Keep `PATCH` only for defined partial-update DTOs; never bind arbitrary persistence objects.
- Preserve optimistic concurrency for Gateway Keys and extend revision/ETag preconditions to Provider edits where concurrent browser/agent writes could lose changes. `If-Match` is defined for preventing lost updates; `412` represents a failed condition, and `428` can require the precondition ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html); [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html)).
- Prefer idempotent DELETE semantics for actual deletion where compatibility permits. Existing action routes such as archive/restore are understandable and need not be renamed merely for aesthetic REST purity.
- Keep the existing stable management error envelope for compatibility. RFC 9457 `application/problem+json` is a reasonable future version, not a prerequisite ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)).

### 5. Treat Provider URLs and secrets as the highest-risk fields

Provider and per-key base URLs cause server-side network requests. Continue validating their shape, and add an explicit deployment policy for schemes, ports, resolved private/link-local/loopback addresses, redirects, and cloud metadata endpoints. This deserves configuration because a self-hosted Owner may intentionally target a LAN model server; silently banning all private addresses would break a core use case. OWASP describes URL-driven server fetches as the central SSRF risk and recommends validation/allowlisting and network controls ([OWASP API7:2023](https://owasp.org/API-Security/editions/2023/en/0xa7-server-side-request-forgery/)).

Keep Upstream Key values out of ordinary Provider DTOs, logs, audit detail, OpenAPI examples, and generic PATCH bodies. The existing dedicated reveal endpoint and ADR-0008 are the right pattern; protect reveal with its own narrow scope. OWASP API3 highlights property-level authorization and excessive data exposure risks ([OWASP API Top 10:2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)).

## OpenAPI and agent ergonomics

The existing generated document is the natural machine contract. Add a `ManagementKey` HTTP bearer security scheme, declare `OwnerSession OR ManagementKey` on each supported admin operation, and give every operation a stable, unique `operationId`, full request/response/error schemas, examples, and all expected status codes. OpenAPI supports HTTP bearer, API-key, OAuth2, OpenID Connect, and mutual-TLS security schemes and per-operation security requirements ([OpenAPI 3.1 Security Scheme Object](https://spec.openapis.org/oas/v3.1.0.html#security-scheme-object)).

Stable `operationId`s matter more than pretty REST naming for agents because tool generators commonly derive callable names from them. Add a small checked-in CLI or examples only after the contract is complete; it should be a consumer of OpenAPI, not a parallel control path. A useful acceptance test is that a fresh headless client can discover the schema, create a Provider, add an Upstream Key, start and poll a catalog refresh, update the Provider, and revoke its own credential without loading HTML.

## Scope and rollout

Suggested sequence:

1. ADR and domain vocabulary for Management Principal/Management Key; decide whether Management Keys may manage other Management Keys (recommended default: no).
2. Persistence and registry for hashed, scoped, expiring, revocable keys with one-time reveal and audit events.
3. Shared management guard accepting either Owner Session or Management Key; explicit scope metadata and negative authorization tests for every admin route.
4. Owner-session-only Management Key CRUD endpoints and OpenAPI security/`operationId` coverage.
5. Async operation resources for catalog/usage refresh and other slow upstream actions, with deduplication and limits.
6. CLI/examples and an end-to-end headless-agent test.

Do not block the first useful release on async jobs. Authentication plus a complete OpenAPI contract immediately eliminates browser automation; job resources are the next reliability layer.

## Decisions still needed

- Credential name: `Management Key`, `Automation Key`, or `Owner API Key`. `Management Key` best describes authority without confusing it with the human Owner Session or inference-only Gateway Key.
- Scope granularity and safe presets (`read-only`, `provider-operator`, `full-control`). Prefer stored primitive scopes with UI presets rather than storing role names.
- Whether Management Keys may reveal Upstream Keys or create/revoke Gateway/Management Keys. These should be separate high-risk grants and disabled by default.
- Whether async operation records are durable across restart and how long they are retained.
- Network policy for private Provider URLs in self-hosted deployments.

## Bottom line

The requested capability is smaller and cleaner than “build APIs for everything”: those APIs mostly exist. Add a first-class, scoped headless authentication mode to the same control plane, finish the OpenAPI contract for agent consumption, and then make upstream refresh/probe work retry-safe through operation resources. This removes the browser dependency while preserving the database-authoritative control plane and the browser security model already established by the repository ADRs.
