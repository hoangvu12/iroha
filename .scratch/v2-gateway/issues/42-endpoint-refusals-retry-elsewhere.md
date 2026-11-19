# 42: A 404 page or a 413 from one Endpoint should not fail the whole Request

**What to build:** On production the generic `bad-request` rule (any other 4xx → `fail_request`) ended Requests on refusals that belong to one Endpoint, not to the request: an Endpoint with a wrong path answered plain-text `404 page not found`, and an nginx in front of one Endpoint answered `413 Request Entity Too Large` as HTML. Iroha never tried the Provider's other Endpoints and keys, which would have served. Make both move on to the next candidate without touching the key.

**Blocked by:** none

**Status:** done

- [x] Built-in rule `endpoint-body-too-large`: status 413 → `retry_elsewhere`
- [x] Built-in rule `endpoint-path-not-found`: status 404, body `^\s*404 page not found\s*$|<title>\s*404` → `retry_elsewhere`, after `model-not-found` and before `bad-request`
- [x] Gateway test per rule: Endpoint a refuses, another key on Endpoint b serves, a's key stays active with no Model Gap, Endpoint Gap or cooling
- [x] 404 naming the model still records a Model Gap
- [x] Skill (Key States and Failure Rules) and conformance rows FAIL-52, FAIL-53 updated

## Comments

**Decision (Owner, 2026-11-19): Failure Rules, not a new outcome.** A first design added an outcome (`retry_other_endpoint`) that would skip the refusing Endpoint for every key of the Request. The Owner dropped it for two built-in rules using the existing `retry_elsewhere`. The rules already exist as Owner rules on production under these exact names, so production now shows them as overrides of the built-ins.

- Rules are in `internal/rules/builtin.go`, placed right after `model-not-found` among the generic fallbacks. A 404 whose error text names a model (`\bmodels?\b`) is still `model_gap`, and both new rules match before `bad-request`. Table cases are in `rules TestBuiltinRulesClassifyTheGenericFailures` (plain text, nginx HTML 404, a JSON message, a 404 text naming a model staying `model-not-found`, nginx 413, Anthropic `request_too_large`). The gateway test is `gateway TestAnEndpointRefusalIsServedByAnotherKeyOnAnotherEndpoint`. The Model Gap case is still covered by `gateway TestARefusedModelCreatesAModelGapAndTheKeyKeepsServingOtherModels`.
- Being `retry_elsewhere`, these rules put out only the key and Endpoint pair that was refused. Other keys can still be sent to the refusing Endpoint within the budget (3 Attempts). A 4xx is never replayed (only 5xx is). When every candidate refuses this way, the Caller gets 502 `upstream_failed` with the Attempts listed, not the Provider's 404/413 as `upstream_rejected`.
- Not done (dropped with the scope change): skipping the Endpoint for every key in the Request, and returning the original status when nothing is left.
