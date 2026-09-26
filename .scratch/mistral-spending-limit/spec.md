# Mistral billing 402 parks the key instead of burning an Attempt

Status: Complete

## Problem

Handoff item A (2026-09-27): the Mistral Provider's `uk_hTV8Y5vKKnnURso_0HQOjg`
answered 402 over 30 times and stayed `active`, so every Mistral Request
burned its first Attempt on it:

```
#1  uk_hTV8Y5vKKnnURso_0HQOjg  402  failure
#2  uk_szUenSKXpNqtxC5DgncxRw  200  success
```

Still live after the 2026-09-26 deploy: three Requests at 22:29Z each spent
their first Attempt this way. The generic 402 classification is
`payment_required` with `capacityScope: 'unknown'` and no capacity evidence,
and the registry's `payment_required` branch deliberately writes nothing
without key-scoped exhausted evidence — so the key never parked.

The refusal body is now captured (2026-09-26, exactly as Mistral sends it):

```json
{"object":"error","message":"Customer monthly spending limit reached. …",
 "type":"billing_customer_monthly_spending_limit_reached","param":null,
 "code":"2300","raw_status_code":402}
```

## Decisions

- A **Mistral Provider Pack** (`mistral` template id) pairs the
  OpenAI-compatible wire shape with a typed Mistral Inference Adapter and the
  reactive-only Usage Adapter — Mistral exposes no entitlement API, so
  nothing can resurrect the key on capacity grounds.
- The adapter recognizes the billing family by envelope shape: HTTP 402 with
  an error `type` beginning `billing_` (flat envelope — Mistral does not nest
  under `error`). It emits key-scoped `payment_required` with provisional
  exhausted `credit_exhausted` evidence, mirroring DashScope's `Arrearage`
  and Z.ai's `1113`, and the registry parks the key with the 15-minute
  billing recheck. `retryAction` stays `try_alternate`: a healthy sibling can
  still serve.
- A bare 402, a billing type on any other status, and every unrecognized
  envelope keep the generic classification — status alone names no billing
  condition, per the failure-classification-retries spec.
- `probedPatch` already refuses to activate an exhausted key on an
  `authenticated` probe verdict, and a spending-capped key's
  `GET /models` still answers 2xx — so the Owner's manual key test records
  the verdict without resurrecting the park. A test pins that.

## Deployment note

The production Mistral Provider was created as
`templateId: 'generic-openai-compatible'`, and `templateId` is immutable
through the admin API. After deploying this code the Provider row must be
re-bound (`template_id` → `mistral`) — a one-line data change on the server
(SQLite) or a follow-up PATCH capability. Until then the pack exists but the
Provider keeps resolving the generic adapter.

## Verification

- `test/inference/mistral-adapter.test.ts`: the captured body classifies as
  key-scoped payment exhaustion; bare 402, non-402 billing types,
  unrecognized envelopes, missing context, and empty bodies all keep the
  generic reading.
- `test/http/mistral-spending-limit.test.ts`: the assembled Gateway parks the
  capped key on the first Request, the next Request goes straight to the
  healthy sibling, the manual key test does not resurrect the park, and the
  attempt diagnostics carry the bounded envelope identifiers without the
  message.
