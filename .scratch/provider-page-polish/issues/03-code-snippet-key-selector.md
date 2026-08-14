# 03 — Code snippet: per-Upstream-Key model filtering and endpoint

**What to build:** The Code snippet card on the Provider detail page gains an
Upstream Key selector next to the existing Model selector. The model list
filters to what the selected key can actually serve, and the selected key's
upstream endpoint is surfaced in the dropdown so the Owner knows which
upstream the snippet is scoped to.

**Blocked by:** —

**Status:** done

## Why

- An Upstream Key can restrict which models it serves (`allowedModels`,
  `deniedModels` — enforced server-side in
  `src/providers/provider-registry.ts:1849-1853`).
- A Provider can hold several Upstream Keys that point at different upstreams
  via the per-key base URL override.
- Today the snippet shows the full catalog and a single Gateway URL, so the
  Owner cannot tell which key a pasted snippet is meant to use, or whether
  the model in the snippet is even reachable through the key they have in
  mind.

## Scope

- The snippet's URL stays the Gateway URL (`/providers/:id/v1/...`). The
  Upstream Key's `effectiveBaseUrl` is shown as a hint in the key selector
  and is **not** baked into the snippet body — the snippet remains a clean
  copy-paste of the Gateway call.
- Model filtering is a **client-side filter over the already-loaded
  catalog**. We do not re-discover per key. The "Refresh catalog" action
  keeps using its current behavior (first eligible key).
- No backend change. The catalog endpoint and the key settings endpoint
  are unchanged.

## Acceptance

- [x] `CodeSnippetCard` renders a "Key" `Select` next to the existing
      "Model" `Select` when `provider.keys.length > 0`. The label uses
      "Key" (not "Upstream key") so the header does not get noisy; the
      surrounding context already makes "upstream" clear.
- [x] On first render the selected key defaults to `provider.keys[0].id`.
      A subsequent reload (key added/removed) keeps the current selection
      when still valid; falls back to the first remaining key when the
      selected key was removed.
- [x] Each dropdown row shows the key's `id` and a muted secondary line
      with the key's `effectiveBaseUrl`. The trigger button shows the
      key id only.
- [x] The Model select's option list is the catalog filtered by the
      selected key: `allowedModels` becomes an allow-list, `deniedModels`
      becomes a deny-list, both `null` means "all catalog models". The
      Owner-excluded catalog rows (`entry.excluded === true`) are
      filtered out regardless. This mirrors the server-side
      `keyServesModel` (`src/providers/provider-registry.ts:1849`).
- [x] When the selected key changes such that the current `modelId` is no
      longer in the filtered list, `modelId` snaps to the first model in
      the filtered list (or `null` if the key serves no models).
- [x] When the filtered list is empty because the selected key has an
      allow-list that excludes everything, the Model select shows "No
      models for this key" and the snippet keeps the current model name
      so the Owner sees the URL shape.
- [x] When `provider.keys.length === 0`, the Key select is hidden and the
      model list reverts to the unfiltered catalog (existing behavior).
- [x] The card layout still fits a single header row at the existing
      width; the two selects wrap below each other at the existing `sm:`
      breakpoint via `flex-wrap`.
- [x] Browser tests pass. (Defer per `docs/agents/ui-testing.md`. The
      catalog filter logic in the server is already covered by
      `test/http/upstream-keys.test.ts` and the snippet itself is
      covered by `test/http/model-catalog.test.ts`.)

## Implementation notes

- Pure change inside `ui/src/components/code-snippet-card.tsx`.
- Extract a `keyServesModel(key, model)` helper mirroring the server's
  rule. Keep it local to the component (no need to share with the
  `ModelListPicker` — that component already does its own allow/deny
  editing and is not affected).
- Track `selectedKeyId` as a state. On `provider.keys` change, if the
  current `selectedKeyId` is no longer present, reset to
  `provider.keys[0]?.id ?? null`. Otherwise leave the selection alone.
- Watch the filtered list: when `modelId` is not in it, set
  `modelId` to the first filtered model (or `null`). Use a
  `useEffect` to keep this in sync without an extra render.
- The secondary `effectiveBaseUrl` line uses `text-[10px] break-all`
  rather than a Tooltip — the line is short enough at the current
  breakpoint that truncation is rare and the surrounding context makes
  the value discoverable without a hover.
- The header row already exists; just add a second `Select` group
  before the existing Model group. Match the existing label / trigger
  size (`size="sm"`, `h-8`, `w-56`).
