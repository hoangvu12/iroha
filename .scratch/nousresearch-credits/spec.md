# Nous Research answers an empty account as a billing refusal, not "model unavailable"

Status: Complete

## Problem

The Nous Research Provider's single Upstream Key answered every paid-model
Request with HTTP 404, and the Gateway reported the failure as
`model_keys_unavailable` (18 Requests in the failure history). The routing
story was wrong: `GET /models` lists the models, the key is accepted, and the
refusal is about money. The captured body (2026-09-26):

```json
{"status":404,
 "message":"Model 'anthropic/claude-opus-5' requires available credits. Your
            account balance is too low to use paid models — add credits at
            https://portal.nousresearch.com or pick a free model.",
 "code":"insufficient_credits_for_paid_model"}
```

The generic 404 classification is `request_rejected` with a
`connection_model` scope: it tells the routing layer the key does not carry
the model, when the Provider is saying the account behind the key cannot pay
for paid models.

## Decisions

- A **Nous Research Provider Pack** (`nousresearch` template id) pairs the
  OpenAI-compatible wire shape with a typed Inference Adapter and the
  reactive-only Usage Adapter — Nous Research exposes no entitlement API.
- The adapter recognizes the signature by shape: HTTP 404 with a flat envelope
  (no `error` object, no `type`) carrying `code:
  insufficient_credits_for_paid_model`. It emits key-scoped
  `payment_required` with provisional exhausted `credit_exhausted` evidence,
  mirroring DashScope's `AllocationQuota.FreeTierOnly` — the Owner's own
  precedent for "free models work, paid ones need credits": park the key on
  the billing reading the Provider itself sent, and let a recheck, a
  controlled trial, or a manual test that proves real capacity revive it.
- A bare 404, the credits code on any other status, and every unrecognized
  envelope keep the generic classification.
- `probedPatch` already refuses to activate an exhausted key on an
  `authenticated` probe verdict, and this account's `GET /models` answers
  2xx — so the Owner's manual key test records the verdict without
  resurrecting the park. A test pins that.

## Deployment note

The production Nous Research Provider was created as
`templateId: 'generic-openai-compatible'`, and `templateId` is immutable
through the admin API. After deploying this code the Provider row must be
re-bound (`template_id` → `nousresearch`), the same one-line data change the
Mistral Provider needs for its pack.

## Verification

- `test/inference/nousresearch-adapter.test.ts`: the captured body classifies
  as key-scoped payment exhaustion; a bare 404, the code on another status,
  missing context, and empty bodies keep the generic reading.
- `test/http/nousresearch-credits.test.ts`: the assembled Gateway parks the
  empty key on the first Request, the next Request goes straight to the paid
  sibling, the manual key test does not resurrect the park, and the attempt
  diagnostics carry the bounded code without the message.
