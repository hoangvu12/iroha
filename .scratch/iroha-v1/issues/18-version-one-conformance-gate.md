# 18 — Version-one conformance and migration gate

**What to build:** A final executable acceptance gate proves the complete Iroha version-one promise across protocols, databases, security boundaries, browser workflows, and upgrades without live Provider credentials.

**Blocked by:** 08 — Responses API and streaming events; 10 — Scoped retries and durable Key Health; 12 — Advanced Provider transport policy; 14 — Bounded background operations; 15 — Built-in Provider Templates and known adapters; 16 — Exception-first operations workspace; 17 — Production runtime behavior and generated API documentation.

**Status:** ready-for-agent

- [ ] Official OpenAI JavaScript SDK conformance passes for Models, Chat Completions, Responses, both streaming forms, tools, structured output, errors, unknown fields, and cancellation.
- [ ] Deterministic mock upstream coverage passes for every agreed status, malformed response, timeout, redirect, rate-limit scope, quota state, disconnect, and streaming boundary.
- [ ] The repository conformance suite passes unchanged against SQLite and PostgreSQL.
- [ ] Migrations succeed from every released schema version on both supported database engines and fail safely when invalid.
- [ ] Browser acceptance passes first-run setup, recovery, Provider Connection and key management, Upstream Accounts, model/usage state, Gateway Key scope, history/audit, themes, and mobile emergency actions.
- [ ] Redaction tests prove prompts, responses, credentials, secret headers, and unsafe upstream messages do not enter persistence, audit, metrics, or public errors.
- [ ] Version-one acceptance succeeds using only normal Bun commands and no Docker, Nixpacks, or real Provider credentials.
- [ ] Documentation, capability declarations, generated OpenAPI, glossary terms, and ADR-governed behavior agree with the executable system.
