---
name: iroha
description: Operate an Iroha Gateway (version {{version}}) through its admin HTTP API - Providers, Upstream Keys, Gateway Keys, Model Pools, Failure Rules, Requests and logs. Use when asked to configure, inspect or diagnose Iroha.
---

# Operating Iroha

Iroha is a self-hosted Gateway in front of many AI inference Providers. You operate it only through the HTTP admin API described here; this document is served by the running Iroha (`GET /skill.md`), so it always matches the deployed version ({{version}}). The full machine-readable contract is `GET /api/openapi.json`.

## Authentication

Every route under `/api/` (except `/api/openapi.json`) needs an Admin Token:

```
Authorization: Bearer <Admin Token>
```

The first start of Iroha prints a bootstrap Admin Token named `bootstrap` to its console, once. Ask the Owner for a token if you have none.

## Conventions

- JSON in and out, field names in `snake_case`, times in RFC 3339 (UTC).
- Errors always have the form `{"error": {"code", "message", "hint"}}`. The `hint` says what to do next; follow it.
- `GET /readyz` answers 200 when Iroha is ready to serve and 503 otherwise; `GET /healthz` answers 200 while the process is alive. Both report the running version.

## Diagnosing

Read structured logs with `GET /api/logs`. Useful filters: `since=15m` (or an RFC 3339 time), `level=warn` (that level and above), `kind=startup,shutdown` (exact kinds, or a prefix such as `http.*`). Results are newest first; pass `before=<id>` from `next_before` to page back.
