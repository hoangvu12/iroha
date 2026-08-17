Status: ready-for-agent

# Immutable Provider Handles for public routing

## Problem

Global routing currently exposes generated Provider IDs in Qualified Model IDs such as `pr_01.../gpt-4o`, and provider-scoped inference exposes the same IDs in `/providers/pr_01.../v1/*`. These identifiers are deterministic but unpleasant to read, copy, and configure. The editable Provider display name cannot safely replace them because changing a display name would break callers.

## Solution

Add a required Provider Handle: a globally unique, immutable public routing identity chosen during Provider creation. Keep the generated Provider ID as the internal identity for persistence, authorization policy, management, audit, and history. Resolve a Handle to its Provider ID at the inference boundary.

This spec replaces the Provider-ID prefix contract in `.scratch/gateway-key-global-routing/spec.md` and `docs/adr/0016-qualified-models-add-global-gateway-routes.md`. It does not restore implicit Provider selection or introduce model aliases.

## Handle contract

- The canonical term is **Provider Handle**. Avoid `alias`, `slug`, and `Provider ID` for this concept.
- A Handle matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` and contains between 1 and 63 characters.
- Handles are globally unique across active and archived Providers.
- A Handle remains reserved for as long as its Provider record exists.
- A Handle is required when creating a Provider.
- **A Provider Handle can never be renamed after creation.** Changing a Provider's display name never changes its Handle.
- The server validates the exact submitted Handle and never silently normalizes, suffixes, or replaces it.
- A uniqueness race returns a field-level `409 handle_already_exists` conflict. Database constraints are authoritative in both SQLite and PostgreSQL.
- Future hard-deletion work must explicitly decide whether a deleted Provider's Handle may be reused; this feature does not decide that behavior.

## Creation experience

- The UI slugifies and, where supported, transliterates the display name into a proposed lowercase kebab-case Handle while the Owner types.
- Automatic derivation continues until the Owner manually edits the Handle. Later display-name changes do not overwrite a customized Handle.
- The UI offers an explicit way to regenerate the proposal from the current display name.
- If slugification produces no characters, the proposal starts with `provider`.
- The UI performs a debounced availability check and may suggest the first available deterministic suffix: `name-2`, `name-3`, and so on.
- Suffixing trims the base as needed to keep the final Handle within 63 characters and removes a trailing hyphen before appending the suffix.
- The value shown and confirmed by the Owner is the exact value submitted. The server does not silently accept a different Handle.
- The creation UI clearly states that the Handle cannot be changed after the Provider is created.

## Existing Provider migration

- Every existing Provider receives a Handle derived solely from its display name.
- Migration slugification uses the same syntax and transliteration policy as creation-time proposals.
- An empty result uses `provider`.
- Collisions receive deterministic `-2`, `-3`, and later suffixes, ordered by Provider creation time and then immutable Provider ID.
- Migration suffixing respects the 63-character limit.
- No compatibility resolver for the former Provider-ID inference URLs or Qualified Model IDs is required.
- SQLite and PostgreSQL migrations must produce equivalent Handles and enforce equivalent uniqueness constraints.

## Public routing

- Global requests use a Qualified Model ID in the form `<provider_handle>/<model_id>`.
- Parsing continues to split at the first slash only. Everything after it remains the exact Upstream Model ID and is forwarded unchanged.
- Provider-scoped inference routes use `/providers/{provider_handle}/v1/*`.
- Global `/v1/models`, non-streaming responses, and streaming response model fields use the Provider Handle as their prefix.
- If an upstream response omits its model, the Gateway falls back to the requested Handle-qualified model ID.
- Provider-scoped model fields remain exact, unqualified Upstream Model IDs.
- Generated code snippets and copyable inference URLs use Handles.
- Internal Provider IDs are not accepted as public inference selectors after migration.

## Identity boundaries

- Database foreign keys and repository relationships continue using Provider IDs.
- Gateway Key selected-access entries continue storing Provider IDs.
- Management API mutation paths and admin-page browser routes continue using Provider IDs.
- Audit records and historical relationships continue retaining Provider IDs.
- The application-facing Provider Directory returns both `id` and `handle`; its inference `url` uses the Handle.
- Admin Provider representations return both identities.
- Provider cards and detail pages display the Handle prominently and the internal ID as secondary diagnostic metadata.
- Request history stores the Provider ID and an immutable Handle snapshot, and displays the Handle to the Owner.

## Errors and privacy

- A syntactically invalid Handle produces `400 invalid_provider_handle` without Provider lookup or upstream traffic.
- A nonexistent, inaccessible, archived, or disabled Handle produces the same sanitized `403 provider_not_allowed` response.
- A malformed Qualified Model ID continues producing `400 invalid_model_id`.
- A scope-denied exact model continues producing `403 model_not_allowed`.

## Acceptance criteria

1. Provider creation requires a valid, available Handle and clearly warns that it cannot be renamed.
2. UI derivation follows display-name edits until manual Handle customization, supports regeneration, and never submits a value different from the one shown.
3. SQLite and PostgreSQL reject duplicate Handles authoritatively, including concurrent creation races.
4. Existing Providers receive deterministic, valid, unique Handles derived from display names on both database engines.
5. Global discovery, global request and response model fields, scoped inference URLs, directories, and code snippets use Handles instead of Provider IDs.
6. Nested Upstream Model IDs preserve every slash after the Handle separator.
7. Gateway Key authorization continues operating on internal Provider IDs after Handle resolution.
8. Admin mutations and admin-page routing remain ID-based, while Owner-facing Provider views expose both identities.
9. Request history preserves an immutable Handle snapshot alongside internal Provider identity.
10. Invalid Handles and inaccessible Provider states obey the specified sanitized error contract without upstream traffic.
11. HTTP-seam and dual-database conformance tests cover creation, validation, collision races, migration collisions, routing, discovery, response qualification, directory output, privacy, and history snapshots.

## Out of scope

- Renaming a Provider Handle.
- Accepting old Provider IDs as inference selectors.
- Model aliases, model rewriting, implicit Provider lookup, or cross-Provider fallback.
- Replacing Provider IDs in database relationships, Gateway Key scopes, management mutation URLs, admin browser routes, or historical identity.
- Deciding whether a future hard-deleted Provider releases its Handle.

## Supporting material

- `CONTEXT.md`
- `docs/adr/0001-provider-scoped-openai-routes.md`
- `docs/adr/0016-qualified-models-add-global-gateway-routes.md`
- `docs/adr/0017-provider-handles-are-public-routing-identities.md`
- `.scratch/gateway-key-global-routing/spec.md`
