# 12 — Advanced Provider transport policy

**What to build:** The Owner can configure unusual compatible Provider transport behavior without weakening Iroha's credential and proxy boundary.

**Blocked by:** 05 — Single-key Chat Completions path; 07 — Streaming Chat Completions.

**Status:** ready-for-agent

- [ ] Advanced settings support adapter-approved authentication header formats and encrypted static headers without arbitrary executable code.
- [ ] HTTPS is required by default; explicit insecure HTTP is connection-scoped and visibly warned.
- [ ] Redirects are rejected by default; explicitly enabled same-origin redirects cannot leak credentials cross-origin.
- [ ] Global connection, first-byte, non-streaming total, streaming idle, and total retry timeout defaults support Provider Connection overrides.
- [ ] Ambiguous network retry policy is configurable and defaults off.
- [ ] Adapters declare supported idempotency headers and whether Iroha generation is safe.
- [ ] Browser inference CORS is disabled by default and may allow explicit origins globally or per Gateway Key without wildcard credentials.
- [ ] Callers can never supply or override arbitrary upstream destinations, authentication, or proxy-control headers.
- [ ] Security-focused HTTP tests cover SSRF boundaries, redirects, headers, CORS, idempotency, timeouts, and redaction.

