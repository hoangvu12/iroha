# 15 — Built-in Provider Templates and known adapters

**What to build:** Common Providers are quick to configure through reviewed templates and typed behavior while custom compatible Providers continue to use the generic path.

**Blocked by:** 06 — Model catalog and scoped Models API; 11 — Usage Adapter and entitlement visibility; 12 — Advanced Provider transport policy.

**Status:** done

- [x] Provider Templates exist for Generic OpenAI-compatible, OpenAI, OpenRouter, MiniMax, and verified data-only compatible defaults informed by nyanis.
- [x] Templates prefill safe endpoint, authentication, model, and capability defaults but never contain accounts or secrets.
- [x] Providers that fit generic behavior use data-only templates rather than bespoke code.
- [x] Typed Inference Adapters exist only where authentication, endpoints, capabilities, errors, or idempotency require behavior.
- [x] Typed Usage Adapters exist only for documented balance or coding-plan/subscription endpoints and declare scope/freshness honestly.
- [x] The UI labels unsupported entitlement polling as reactive-only Unknown rather than zero.
- [x] Adapter registry validation rejects duplicate IDs and malformed declarations at startup.
- [x] Deterministic mock tests cover every built-in template and adapter without real Provider credentials.

## Comments

### What was built

Provider Templates are data-only defaults the Owner uses to seed a new Provider Connection:

- `src/providers/templates.ts` — `BUILT_IN_PROVIDER_TEMPLATES` ships five reviewed templates (Generic OpenAI-compatible, OpenAI, OpenRouter, MiniMax, Data-only OpenAI-compatible). Each one carries only safe fields (canonical base URL, canonical authentication header shape, capability defaults, the model list the template was reviewed against) and references the registered generic Inference Adapter and the reactive-only generic Usage Adapter by id. The constants `GENERIC_INFERENCE_ADAPTER_ID` and `REACTIVE_ONLY_USAGE_ADAPTER_ID` make the wiring explicit.
- `src/providers/adapter-registry.ts` — `AdapterRegistry` validates everything once at construction: blank or whitespace-bearing IDs, duplicate inference / usage / template ids, and template references to unknown adapters are all rejected. `AdapterRegistryValidationError` carries every problem so a misconfigured runtime never gets as far as the first request. `createBuiltInAdapterRegistry()` is the constant production uses.
- `src/http/admin.ts` — `GET /api/v1/admin/provider-templates` returns every template the Owner may seed from, in declaration order; `POST /api/v1/admin/provider-connections` accepts an optional `templateId` that prefills `baseUrl`, `authHeader`, `authPrefix`, and capability defaults while keeping every field overridable. An unknown template id returns `validation_failed` rather than silently falling back.
- `src/providers/connection-registry.ts` — `ProviderConnectionRegistry.create` consults the registry for the template, records the chosen `templateId` on the durable connection, and refuses unknown template ids at validation time. `duplicate` copies the `templateId` so the new connection shows the same provenance.
- `src/models/catalog-service.ts` + `templateKnowledgeFromRegistry` — the catalog merges template-known models alongside discovered ones with `source: 'template'` provenance, so a templated connection shows curated models even before discovery runs and keeps them across later discoveries that omit them. Discovered provenance wins on collision; template-known models are never overwritten by discovery absence.
- `src/usage/generic-adapter.ts` — the reactive-only generic Usage Adapter reports `visibility: 'reactive_only'` and an Unknown reading with `confidence: 'unknown'`. It never collapses missing authority into a zero balance; a cancellation arriving via `signal` returns a structural `upstream_unreachable` failure.
- `ui/src/components/connection-usage-view.tsx` — the usage view shows the connection's `visibility` as `Reactive only` and the balance row as `Unknown` when the adapter does not claim authority, matching the data-only contract.

### What was deliberately not built

A typed Inference or Usage Adapter for any of the built-in Providers. The ticket requires typed adapters only where authentication, endpoints, capabilities, errors, idempotency, or documented entitlement endpoints require behavior the generic contract cannot express safely, and none of the built-in Providers do. The `mock-credit-adapter` and `mock-plan-adapter` are test-only fixtures used to exercise the Usage Service end-to-end; production ships the generic adapter.

### Tests added

51 deterministic cases across the ticket's test files, no real Provider credentials:

- `test/providers/templates.test.ts` — 12 cases covering template coverage, no-secret hygiene, adapter references, id shape, capability claim shape, lookup behaviour, and the OpenAI curated-model list.
- `test/providers/adapter-registry.test.ts` — 15 cases covering built-in registry exposure, declaration-order output, lookup miss, duplicate inference / usage / template id rejection, unknown adapter references, blank or whitespace id rejection, multi-problem aggregation, and registry-without-adapters rejection.
- `test/providers/connection-templates.test.ts` — 10 cases covering null / known / unknown / blank / numeric / explicit-null `templateId`, Owner overrides, durable-row provenance, duplicate-carries-template, and audit detail not echoing secrets.
- `test/http/provider-templates.test.ts` — 10 HTTP cases covering list ordering, secret-free defaults, adapter references, OpenAI curated models, unauthenticated denial, cross-origin denial, hand-configured null `templateId`, templated create, unknown `templateId` rejection, and list-echoes-templateId.
- `test/http/model-catalog-templates.test.ts` — 4 HTTP cases covering template-known model provenance, hand-configured no-template-models, template-known model survival after a later discovery omission, and Owner exclusion survival over a template-known row.

Full suite: 732 pass / 1 skip (PostgreSQL conformance, no `IROHA_TEST_POSTGRES_URL`) / 0 fail; typecheck clean.
