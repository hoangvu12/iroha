# Key Model Availability orders Upstream Keys rather than filtering them

A Provider may issue Upstream Keys with different model entitlements, so a Request for a
model only some keys can call fails whenever round-robin lands on a key without it. We now
discover each key's models from the Provider and hold that set as its Key Model Availability,
using it to order the eligible keys of a Request — keys known to call the model first — rather
than to remove keys from the candidate list.

## Considered options

**Filter the candidates.** Remove every Upstream Key whose Key Model Availability lacks the
requested model. This is the obvious reading of the problem and was the design until measurement
contradicted it.

Probing a DashScope Provider with 23 keys found `GET /models` returns three distinct lists
(10, 159 and 238 models across 5, 7 and 8 keys), which are not nested: the union is 250 models
and the intersection is 6. Discovery is therefore genuinely per key. But testing each tier against
models absent from its own list showed the large tier serving 3 of 5 of them with real 200
responses. `GET /models` is reliable when it says yes and unreliable when it says no. A filter
would have permanently and silently hidden real capacity on 8 of 20 keys, and no refresh interval
could ever correct it, because the list is wrong at the moment it is discovered rather than stale.

**Order the candidates.** Keys that list the model are preferred; the rest remain reachable behind
them. A model on 7 of 20 keys rotates over those 7 and reaches the others only once they are
exhausted, which answers the original complaint, while an under-reported model is still served —
just later in the order.

## Consequences

Key Model Availability is positive evidence, not an allow-list. An Upstream Key with no discovered
availability is unrestricted rather than excluded, so a newly added key works before its first
discovery and the three keys that answer 401 need no special case.

Ordering only helps if a wrong guess is cheap, so the DashScope Inference Adapter must classify
the entitlement refusal with the Retry Action `try_alternate`. It currently falls through to the
generic classifier's `request_rejected`, whose `stop` action is the direct cause of the reported
errors. Three signatures carry the same meaning and all three must be recognised:
400 `invalid_parameter_error`, 404 `model_not_found`, and 404 `model_not_supported`.

Because no candidate is ever removed, a mistyped model would otherwise burn one Attempt per key.
A model absent from *every* key's availability is treated as unroutable and refused before any
Attempt; that is distinct from a model whose keys are all currently ineligible, which is temporary
and reported as such so a caller can tell "stop" from "retry shortly".

Key Model Availability is deliberately not modelled as Key Health with a `connection_model`
Capacity Scope, though that machinery already exists and would fit mechanically. A key that was
never entitled to a model is not limited, and giving a permanent condition a `retryAfterAt` would
both re-offer the key forever and report healthy keys as cooling down.
