# 13 — Private request history and Owner audit

**What to build:** The Owner can diagnose inference and configuration behavior from metadata and audit trails without Iroha retaining inference content or secrets.

**Blocked by:** 02 — Secure single-Owner lifecycle; 05 — Single-key Chat Completions path.

**Status:** ready-for-agent

- [ ] Request history records request ID, time, connection, exact model, selected key identity, status, latency, retry/skip trail, and provider-supplied token usage.
- [ ] Prompts, responses, Upstream Key values, Gateway Key secrets, authentication headers, and unsafe upstream messages are never stored.
- [ ] The Owner can filter, paginate, and inspect request metadata and individual retry decisions in the UI.
- [ ] Owner mutations create audit records that identify the action and affected domain identity without secret before/after values.
- [ ] Audit history remains until explicitly cleared.
- [ ] Request-history retention is configurable, supports disabled storage, and defaults to 30 days.
- [ ] Caller-safe errors contain a request ID but no internal key names or retry trail.
- [ ] Systematic tests seed secret-like values through every error/log/audit path and prove redaction.

