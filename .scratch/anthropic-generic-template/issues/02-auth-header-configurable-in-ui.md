# 02 — Make authHeader and authPrefix configurable in UI

**What to build:** Add `authHeader` and `authPrefix` fields to both the create provider dialog and edit provider dialog. The create dialog pre-fills from the template's defaults; the edit dialog shows the current provider's values. Users can override the template defaults for their specific proxy or service.

**Blocked by:** None — can start immediately (independent of issue 01, but both should ship together).

**Status:** done

## Create dialog changes

- [x] Add `authHeader` and `authPrefix` state to the create provider form in `ui/src/components/providers-area.tsx`
- [x] Pre-fill from the selected template's `authHeader` and `authPrefix` when the template changes
- [x] Add UI fields for `authHeader` and `authPrefix` after the "Default base URL" field
- [x] Pass `authHeader` and `authPrefix` to the `createProvider()` API call
- [x] Update `createProvider()` in `ui/src/lib/providers.ts` to accept and send these fields

## Edit dialog changes

- [x] Add `authHeader` and `authPrefix` state to `EditProviderForm` in `ui/src/components/edit-provider-form.tsx`
- [x] Initialize from `provider.authHeader` and `provider.authPrefix`
- [x] Add UI fields for `authHeader` and `authPrefix`
- [x] Pass `authHeader` and `authPrefix` to the `updateProvider()` API call
- [x] Update `updateProvider()` in `ui/src/lib/providers.ts` to accept and send these fields

## API changes

- [x] Update `POST /management/providers` handler in `src/http/management.ts` to accept optional `authHeader` and `authPrefix` fields
- [x] Update `PATCH /management/providers/:id` handler in `src/http/management.ts` to accept optional `authHeader` and `authPrefix` fields
- [x] Add validation: `authHeader` must be a valid HTTP header name (alphanumeric + hyphens, case-insensitive)
- [x] Update `src/providers/provider-registry.ts` `createProvider()` to accept and persist `authHeader` and `authPrefix`
- [x] Update `src/providers/provider-registry.ts` `updateProvider()` to accept and persist `authHeader` and `authPrefix`

## UI design

- [x] Use a dropdown for `authHeader` with common options:
  - `x-api-key` (Anthropic native)
  - `Authorization` (OpenAI-compatible, with `Bearer ` prefix)
  - Custom (text input)
- [x] When `Authorization` is selected, show a second dropdown for `authPrefix`:
  - `Bearer ` (most common)
  - `` (empty, for custom schemes)
  - Custom (text input)
- [x] When `x-api-key` is selected, hide the `authPrefix` field (Anthropic uses empty prefix)
- [x] Show a hint: "Most providers use x-api-key or Authorization: Bearer. Check your provider's documentation."

## Tests

- [x] Add conformance test in `test/http/management-providers.test.ts` proving `authHeader` and `authPrefix` can be set on create and updated on edit
- [x] Add validation test proving invalid `authHeader` values are rejected
- [x] Add UI test proving the create dialog pre-fills from template defaults
- [x] Add UI test proving the edit dialog shows current provider values

## Comments

- The `authHeader` and `authPrefix` are provider-level settings, not key-level. All keys on a provider use the same auth scheme.
- The template's `authHeader` and `authPrefix` are defaults; the provider can override them.
- The `AnthropicInferenceAdapter` already reads the provider's `authHeader` and `authPrefix` when building upstream requests, so no adapter changes are needed.
- The `Generic OpenAI-compatible` template uses `Authorization: Bearer`; the new `Generic Anthropic-compatible` template uses `x-api-key`. Users can override either in the UI.
