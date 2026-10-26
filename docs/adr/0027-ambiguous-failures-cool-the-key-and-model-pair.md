# Ambiguous failures cool the key-and-model pair, then escalate

ADR-0003 persists Key Health at its actual scope, but the generic Failure Classification only
ever claimed the whole key for a 403, 429 or 5xx. Providers limit, entitle and break single
models as often as whole keys — Mistral rate-limits per model, and DashScope's 502s concentrate
on a few models — so one model's failure cooled a key for all of them and healthy models failed
as `model_keys_unavailable`.

A 403, 429 or 5xx whose body names no account condition now claims a new Capacity Scope,
`key_model`: the key that answered, for the model it was asked. It is persisted in the existing
`health_scope`/`health_model` columns as `cooling_down` with a `retryAfterAt`, so it expires into a
controlled trial like any other cooldown; the key serves its other models as an Active key. A
401, and a 403 or 429 whose error text names the key or its account (verification, suspension,
billing, credit, quota) without naming a model, still claim the whole key at once. A typed
Inference Adapter's own scope always wins over the generic reading. Transport failures that never
produced a response are not classified and are unchanged.

When the same Failure Classification kind reaches 3 distinct models of one key within 5 minutes,
the key is cooled key-wide: that is what an account problem, or a Provider down for every model,
looks like. A success on any model discards the expired failures it contradicts.

## Considered options

**A per-key-model health table.** It would persist every model's cooldown rather than the latest
one. Rejected for now: the cooldowns last seconds to minutes, so the other models' cooldowns and
the escalation count live in a volatile in-memory ledger beside the controlled trials, and a
restart costs at most one re-learned failure per model.

**Reusing `connection_model`.** That scope already means the model on every key of the Provider,
which is what the 5xx regression in `provider_failure` was fixed to avoid.

## Consequences

A model the key is genuinely not entitled to, refused with a bare 403, is re-offered after each
cooldown — the cost ADR-0023 describes for modelling entitlement as Key Health — and three such
models escalate the key. Recognising that refusal as `model_unavailable` remains a Provider
adapter's job, as DashScope's already does.
