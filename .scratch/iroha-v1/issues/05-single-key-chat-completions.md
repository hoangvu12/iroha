# 05 — Single-key Chat Completions path

**What to build:** An ordinary OpenAI client can send a non-streaming Chat Completion through an explicit Provider Connection using a scoped Gateway Key and receive a compatible response or safe error.

**Blocked by:** 04 — Scoped Gateway Keys and Provider Directory.

**Status:** ready-for-agent

- [ ] Provider-scoped Chat Completions accept a valid Gateway Key and reject missing, revoked, or out-of-scope keys.
- [ ] The exact request model is forwarded unchanged to the selected Provider Connection.
- [ ] The caller authorization is consumed, the Upstream Key is injected by the generic Inference Adapter, and unsafe or hop-by-hop headers are stripped.
- [ ] Unknown request JSON fields are preserved after validation of the routing-critical envelope.
- [ ] Safe upstream successes are returned in OpenAI-compatible form.
- [ ] Safe upstream failures become OpenAI-shaped errors with stable Iroha codes and sanitized detail.
- [ ] Every request receives a correlation ID that is returned to the caller.
- [ ] Caller cancellation aborts the upstream operation.
- [ ] Official OpenAI JavaScript SDK tests exercise the complete request against deterministic mock upstreams.

