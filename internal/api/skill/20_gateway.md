## Setting up a Provider and a Caller

A Provider is one upstream service; Callers reach it at `/providers/<handle>/v1/...`. Four calls take it from nothing to a working Caller, and each is safe to repeat:

```
POST /api/providers                         {"handle": "acme", "name": "Acme AI"}
POST /api/providers/acme/endpoints          {"url": "https://api.acme.example/v1", "shape": "openai-chat"}
POST /api/providers/acme/keys/bulk          {"items": [{"secret": "sk-..."}, {"secret": "sk-..."}]}
POST /api/gateway-keys                      {"name": "discord-bot", "scope": {"all": true}}
```

- **Handles** are lowercase letters, digits and single hyphens (at most 63). They never change and are never reused, so choose them with care. Retire a Provider with `PATCH /api/providers/<handle>` `{"archived": true}`.
- **Endpoint URLs** carry the version path (`.../v1`, `.../api/paas/v4`); Iroha appends the operation path such as `/chat/completions`. Today only Endpoints speaking the Caller's Shape serve it.
- **Upstream Keys** added without a name are matched by secret: pasting the same key twice never makes a duplicate, and new keys get the next free name `key-N`. A named key without a secret is a keyless slot that sends no auth header. Secrets are always readable with `GET /api/providers/<handle>/keys`.
- **Gateway Key scopes** are `{"all": true}` or `{"providers": [{"provider": "acme"}, {"provider": "other", "models": ["glm-4.6"]}]}`. The answer contains the key's secret; it stays readable with `GET /api/gateway-keys/<name>`.

Iroha uses a Provider's Upstream Keys in turn (round-robin), one per Request.

## Calling the Gateway

Callers send the Gateway Key as `Authorization: Bearer <key>`, `x-api-key: <key>` or `api-key: <key>`; it is never forwarded upstream. A Caller's body reaches the Provider unchanged; the answer comes back with the Provider's status, the model named as the Caller asked for it, and an `x-request-id` header. Errors Iroha itself returns use the OpenAI error envelope with Iroha's `code`, `hint` and `request_id`:

- `401 gateway_key_missing` / `gateway_key_invalid` (unknown and revoked keys look the same).
- `403 provider_not_allowed`: the Provider does not exist, is disabled or archived, or is outside the key's scope. All four look the same on purpose.
- `403 model_not_allowed`: the key's scope narrows this Provider to other models.
- `400 invalid_request` / `model_required`: the body is not a JSON object or names no model.
- `502 upstream_unreachable`, `upstream_redirect`, `endpoint_misconfigured`; `503 no_candidate` when the Provider has no Upstream Key or no Endpoint for the Shape (`details.reason`).

## Reading Requests

`GET /api/requests` lists Requests newest first (filter by `caller`, `provider`, `model`, `status` such as `429` or `5xx`, `since`); `GET /api/requests/<x-request-id>` adds every Attempt: Endpoint, Upstream Key name, wire model, upstream status or error, timings and token usage (streams included). A Request's `status` is what the Caller received; `error.code` says why it failed when it did. Requests whose Caller could not be identified (401) are not recorded; read `GET /api/logs?kind=request,attempt` for the event trail.
