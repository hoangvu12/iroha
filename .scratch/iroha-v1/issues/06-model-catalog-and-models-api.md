# 06 — Model catalog and scoped Models API

**What to build:** Provider Connections maintain an explainable cached model catalog and expose an OpenAI Models response filtered by the caller's Key Scope.

**Blocked by:** 03 — Generic Provider Connection with one encrypted Upstream Key; 04 — Scoped Gateway Keys and Provider Directory.

**Status:** complete

- [x] A connection can synchronize models after creation/edit and through an explicit Owner refresh action.
- [x] The catalog merges last upstream discovery, Provider Template knowledge, Owner additions, Owner exclusions, and capability overrides.
- [x] The UI identifies model provenance, freshness, last success, and the latest synchronization failure.
- [x] A failed refresh retains the last successful catalog, marks it stale, and does not disable inference.
- [x] Provider-scoped Models returns an OpenAI-shaped list of exact model IDs permitted by the calling Gateway Key.
- [x] Unknown catalog models remain forwardable on provider-scoped inference unless Key Scope or an Owner exclusion forbids them.
- [x] Connection capability defaults and per-model overrides represent Chat, streaming, tools, structured output, and Responses support.
- [x] HTTP and browser tests cover refresh success/failure, stale retention, source merging, overrides, and scope filtering.

## Comments

Implemented via subagent: Models API and catalog routes (src/http/inference.ts, src/http/catalog.ts), catalog service (src/models/catalog-service.ts), migration 0004 both dialects, ModelCatalogRepository. Follow-up in this session: 13 HTTP tests (test/http/model-catalog.test.ts) and 3 model-catalog conformance cases (test/persistence/repository-conformance.test.ts).

A correctness bug found while writing the tests: multi-condition drizzle queries were chained with the `&&` operator, which in JavaScript returns only its last truthy operand, silently dropping every earlier condition. `syncDiscovered` could therefore delete a still-reported model, and `setExcluded`/`removeOwnerModel`/`isExcluded`/`updateOverrides` ignored the connection and model IDs. Fixed in both dialects by switching all catalog conditions to drizzle's `and(...)`. Full suite 368 pass / 1 skip / 0 fail; typecheck clean.
