# 17 — Production runtime behavior and generated API documentation

**What to build:** Iroha behaves predictably under hosting lifecycle events and gives developers accurate machine-generated documentation for its custom APIs.

**Blocked by:** 02 — Secure single-Owner lifecycle; 05 — Single-key Chat Completions path; 13 — Private request history and Owner audit; 14 — Bounded background operations.

**Status:** ready-for-agent

- [ ] Graceful shutdown stops new inference and background claims, drains active work for a configurable grace period, then aborts remaining upstream work and closes database resources.
- [ ] Readiness requires valid configuration, completed migrations, and traffic capability but remains healthy during Provider outages.
- [ ] Liveness remains a minimal unauthenticated process signal and neither health endpoint exposes Provider details.
- [ ] Database/API timestamps are UTC and the UI renders the Owner's browser timezone with UTC available.
- [ ] An optional authenticated metrics endpoint exposes bounded-cardinality request, latency, failure, retry, and Key Health counts without request IDs or secrets.
- [ ] Generated interactive OpenAPI documentation describes discovery/admin routes, schemas, errors, and their distinct Gateway Key or Owner-session authentication.
- [ ] The OpenAI passthrough surface is linked to its capability matrix rather than duplicated inaccurately in interactive docs.
- [ ] `.env.example` and configuration guidance document only supported normal Bun operation and required/optional secrets.
- [ ] Integration tests cover signals, shutdown during streaming/non-streaming work, Provider outage readiness, metrics privacy, and OpenAPI authentication metadata.

