# Per-endpoint model lists and model-ID mapping

Status: Built locally; verified (1357 backend tests pass, server + UI typecheck,
UI build). Not yet deployed to production.

## Problem

An Owner adds one Provider whose endpoints (per-key base URLs) each serve a
different set of models, and some endpoints address a model under a different
native ID than the gateway-facing one. Today:

- The per-key "Only allow models" list already filters routing to the
  endpoints that serve a requested model, and round-robin already spreads
  across them. This half works.
- There is no way to say "this endpoint calls `gpt-6.1-sol` under the name
  `openai/gpt-6.1-sol`". The outbound model ID is fixed once at admission
  (`src/http/inference.ts`, `model: authorization.modelId`) before an endpoint
  is chosen, so it cannot vary per endpoint.
- The model picker (`ui/src/components/model-list-picker.tsx`) renders every
  catalog model as a chip. An endpoint with ~2k models floods the page.

## Decisions

1. **Filtering + round-robin is A, and it already exists.** A request for model
   M is eligible only on endpoints whose allow-list admits M (`keyServesModel`),
   and those rotate round-robin (`RoundRobinSelector`). No routing change for
   this half. Discovered Key Model Availability still *orders* within that
   (ADR-0023), unchanged.

2. **Rename is a new per-key field `modelRewrites`.** Shape:
   `Record<gatewayModelId, nativeModelId> | null`. `null`/absent means send the
   requested ID unchanged. It is independent of `allowedModels`: the allow-list
   decides eligibility, the rewrite decides the wire name.

3. **The outbound rewrite moves from admission to per-attempt.** `resolveInference`
   returns the native ID for the chosen key
   (`key.modelRewrites?.[model] ?? model`) on `InferenceTarget`. The forwarding
   loop sets the outbound body's `model` from the resolved target, so a retry
   that fails over to another endpoint re-maps. This changes the invariant that
   the gateway model ID equals the exact upstream name — the ID becomes a
   per-endpoint alias. Recorded in ADR-0028.

4. **UI: one scalable, searchable control per endpoint** replacing the chip
   flood. Columns: Model (caller asks for / the allow-list), Send as (the
   rewrite; blank = same), Served (allow-list membership). Search + windowing so
   a 2k-model catalog never renders at once. Appears in the create-provider
   endpoint rows and the Add/Configure key dialogs.

## Non-goals

- No change to discovery, Key Model Availability, or capacity logic.
- No arbitrary regex/transform; an explicit per-ID map only (covers the
  `openai/`-prefix case and anything else without a new rule language).

## Work

- [x] `modelRewrites` column on `upstream_keys` (sqlite + postgres) + migration
      (sqlite `0025_previous_nightcrawler`, postgres `0026_flaky_blur`).
- [x] Repository record/patch fields + conformance (passes).
- [x] Registry: validate in `readKeySettings` (`readModelRewrites`); carried on
      create + add + patch; resolve native ID in `resolveInference` →
      `InferenceTarget.upstreamModelId`. (Bulk paste still per repo policy omits
      per-key settings; rewrites set later via PATCH or on create rows.)
- [x] Inference path: `bodyForUpstreamModel` applies the per-attempt native ID
      in both OpenAI and Anthropic forwarding loops; common path stays
      byte-exact.
- [x] Admin API: accept/return `modelRewrites` on key create/add/patch + view.
- [x] ADR-0028 (model ID is a per-endpoint alias).
- [x] UI: `ModelRewritesEditor` wired into create endpoint rows + Add/Configure
      key dialogs; `ProviderModelsCard` and `ModelListPicker` now search + cap
      rendering so a 2k-model catalog no longer floods the page.
- [x] HTTP tests: `test/http/endpoint-model-rewrites.test.ts` (6 cases). UI
      ships without browser tests (per repo policy).
