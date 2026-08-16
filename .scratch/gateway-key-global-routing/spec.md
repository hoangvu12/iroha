Status: ready-for-agent

# Unrestricted Gateway Keys and global routing

## Problem

Gateway Keys currently contain only a list of selected Providers. An empty list denies all access, the Owner cannot grant access to Providers created later, and an active key's settings cannot be edited. Revoked keys remain listed permanently. Applications must also configure a provider-scoped base URL even when they prefer one conventional API base URL.

## Solution

Give each Gateway Key an explicit access policy with `all` and `selected` modes, add atomic editing for active keys, and allow revoked keys to be permanently deleted while retaining safe historical identity snapshots. Add deterministic global inference and model-discovery routes alongside the existing provider-scoped routes. Global calls select their Provider with a Qualified Model ID rather than implicit model lookup.

## Gateway Key access policy

- The wire representation is either `{ "access": { "mode": "all" } }` or `{ "access": { "mode": "selected", "providers": [...] } }`.
- `all` dynamically permits every model on every active Provider. Creating or restoring a Provider grants access immediately; archiving or disabling it removes access immediately.
- `all` has no exclusion list. An Owner who needs exceptions uses `selected`.
- `selected` contains Provider entries with `providerId` and `models`. `models: null` permits every model on that Provider; an explicit model list permits only those exact IDs.
- An empty selected Provider list denies all access.
- Existing persisted scope arrays and legacy create requests map to `selected`; no migration may reinterpret an existing empty scope as unrestricted.
- Model-catalog membership controls discovery, not inference authorization. An exact model absent from the current catalog is still attempted when the access policy otherwise permits it and the Owner has not excluded it.

## Gateway Key lifecycle

- Creation supports either access mode and may create an unrestricted key before any Provider exists.
- One edit operation atomically updates an active key's name, access policy, and CORS origins.
- Edits carry a revision or equivalent `updatedAt` precondition. A stale edit is rejected as a conflict rather than overwriting a newer policy.
- Authorization is evaluated once when a Request begins. An edit applies to subsequent Requests and does not cancel an admitted Request or stream.
- Revocation remains permanent and idempotent. A revoked key cannot be edited.
- Only a revoked key can be deleted. Deletion permanently removes the live Gateway Key record and secret-derived authentication material and removes it from the Gateway Keys list.
- Deletion records `gateway_key.deleted` without secret material.
- Request and audit history preserve immutable safe snapshots containing the historical Gateway Key ID and name. Deletion never removes those events and cannot restore the key.

## Global API

The following routes are additive:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

The existing `/providers/{provider_id}/v1/*` routes and authenticated Provider Directory remain unchanged.

### Qualified Model IDs

- A global request uses `<provider_id>/<model_id>`.
- Parsing splits at the first `/` only. Everything after it is the exact Upstream Model ID and is forwarded unchanged. For example, `pr_openrouter/openai/gpt-4o` selects Provider `pr_openrouter` and sends `openai/gpt-4o` upstream.
- A missing Provider segment, missing model segment, or unqualified model is rejected. Iroha never searches Providers or chooses one implicitly.
- Global `/v1/models` returns only Qualified Model IDs discoverable under the calling Gateway Key's current access policy. Provider-scoped model discovery continues returning exact unqualified Upstream Model IDs.
- On global non-streaming responses and streaming chunks, a returned model is `<provider_id>/<upstream-reported-model>` so aliases, routers, and fallbacks can report the model actually served. If upstream omits its model, use the requested Qualified Model ID.
- Provider-scoped response model fields remain unchanged.

## Error and privacy contract

- Invalid Gateway Key: `401 gateway_key_invalid`.
- Missing or malformed Qualified Model ID: `400 invalid_model_id`.
- Nonexistent, inaccessible, archived, or disabled Provider: the same sanitized `403 provider_not_allowed`, so a restricted key cannot probe the Owner's Provider inventory.
- Model denied by selected scope: `403 model_not_allowed`.
- After authorization succeeds and an upstream attempt occurs, existing Inference Adapter error translation remains authoritative.

## Acceptance criteria

1. Existing Gateway Keys, including empty-scope keys, retain exactly their prior authority after migration on SQLite and PostgreSQL.
2. An unrestricted key can use and discover a Provider created after the key, loses it upon archive/disable, and regains it upon restore/enable.
3. Selected keys enforce Provider and exact-model restrictions on both global and provider-scoped routes.
4. Unknown-but-permitted catalog models reach upstream; excluded or scope-denied models do not.
5. Global parsing preserves slashes inside the Upstream Model ID and rejects unqualified IDs without attempting upstream traffic.
6. Global model discovery and response fields use Qualified Model IDs; provider-scoped behavior remains backward compatible.
7. Active-key edits are atomic, audited, and concurrency-safe; admitted Requests continue under their initial authorization decision.
8. Revoked keys cannot be edited, active keys cannot be deleted, and deleting a revoked key preserves safe historical ID/name snapshots without retaining secret material.
9. Unauthorized Provider probing receives indistinguishable errors for absent, inaccessible, archived, and disabled Providers.
10. HTTP-seam tests cover both caller shapes, streaming and non-streaming responses, both access modes, migration compatibility, stale edits, revocation, deletion, audit, and sanitized errors.

## Out of scope

- Automatic Provider selection or searching by an unqualified model ID.
- Cross-Provider fallback.
- Virtual aliases or Owner-defined model rewrites.
- Exclusions within unrestricted access mode.
- Cancelling in-flight Requests when a key is edited or revoked.
- Removing or deprecating provider-scoped routes or changing the Provider Directory.

## Supporting material

- `docs/adr/0016-qualified-models-add-global-gateway-routes.md`
- `docs/research/openrouter-model-id-roundtrip.md`
