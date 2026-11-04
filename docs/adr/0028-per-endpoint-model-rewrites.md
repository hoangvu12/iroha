# Per-endpoint model rewrites make the gateway model ID a per-endpoint alias

An Upstream Key may now carry a `modelRewrites` map, `{ requestedId: nativeId }`,
that renames the model on requests routed to that key's endpoint. A request for
`gpt-6.1-sol` on an endpoint whose map holds `gpt-6.1-sol -> openai/gpt-6.1-sol`
is sent upstream as `openai/gpt-6.1-sol`; an endpoint without an entry sends the
requested ID unchanged.

This departs from the prior invariant that the gateway-facing model ID is the
exact upstream name (CONTEXT.md's Upstream Model; ADRs 0023–0025 preserve
"routing identity = exact id"). With a rewrite the ID becomes a per-endpoint
alias: one gateway ID can reach several endpoints that each call it something
different. We accept this because one Provider legitimately spreads over
endpoints — including OpenAI-compatible gateways that prefix native IDs — that
disagree on a model's name, and the alternative (one Provider per naming scheme)
is the per-endpoint inconvenience ADR-0006 already rejected for base URLs.

The rewrite is resolved **per Attempt, after key selection**, not at admission.
`resolveInference` returns the chosen key's native ID on `InferenceTarget`, and
the forwarding loop rebuilds the outbound body's `model` from it, so a failover
to another endpoint re-maps. Eligibility and round-robin are unchanged: the
per-key allow-list (`keyServesModel`) still decides which endpoints serve a
model, and Key Model Availability still only orders within that (ADR-0023). The
rewrite is independent of the allow-list — the allow-list decides eligibility,
the rewrite decides the wire name.

We rejected a rewrite applied once at admission (it cannot vary per endpoint, and
a retry onto a differently-named endpoint would send the wrong ID), and a
regex/transform rule language (an explicit per-ID map covers the prefix case and
anything else without new syntax). The map is stored per key as JSON
(`model_rewrites`, nullable), mirroring `allowedModels`/`deniedModels`.
