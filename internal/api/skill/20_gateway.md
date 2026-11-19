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
- **Several Endpoints** (regions, plan-specific URLs, an Anthropic-compatible URL) live on one Provider, each created by name: `POST /api/providers/acme/endpoints {"name": "eu", "url": "...", "shape": "openai-chat"}`. Each has its own `auth_style`: `bearer` (default, `Authorization: Bearer <key>`), `x-api-key`, `header` (the header named in `auth_param`, e.g. `api-key`), `query` (the query parameter named in `auth_param`, e.g. `key`) or `none`; `static_headers` sent on every Attempt (for a fixed credential use `auth_style` `none` and put it here); and `renames` such as `{"glm-4.6": "glm-4.6-fp8"}` (the model a Caller names -> the model sent to this URL, applied per Attempt, so failing over to another Endpoint sends that Endpoint's name). Maps replace the whole set; `{}` clears one.
- **Upstream Keys** added without a name are matched by secret: pasting the same key twice never makes a duplicate, and new keys get the next free name `key-N`. A named key without a secret is a keyless slot that sends no credential in any auth style; a 401 to a keyless Attempt moves on without making the key invalid. `"endpoints": ["eu"]` on a key (create, bulk or `PATCH`) restricts it: it is only ever sent to those Endpoints; `[]` lifts it. Deleting an Endpoint takes it out of keys' restrictions in the same Audit Entry, and is refused with `409 endpoint_in_use` while a key may use that Endpoint alone. Secrets are always readable with `GET /api/providers/<handle>/keys`.
- **Gateway Key scopes** are `{"all": true}` or `{"providers": [{"provider": "acme"}, {"provider": "other", "models": ["glm-4.6"]}]}`. The answer contains the key's secret; it stays readable with `GET /api/gateway-keys/<name>`.

Iroha uses a Provider's Upstream Keys in turn (round-robin), skipping keys that are disabled, invalid or cooling, and keys with a Model Gap for the model; when an Attempt fails it moves on to the next key within the Request budget (see "Key States and Failure Rules").

## Calling the Gateway

Callers send the Gateway Key as `Authorization: Bearer <key>`, `x-api-key: <key>` or `api-key: <key>`; it is never forwarded upstream. A Caller's body reaches the Provider unchanged; the answer comes back with the Provider's status, the model named as the Caller asked for it, and an `x-request-id` header. Errors Iroha itself returns use the OpenAI error envelope with Iroha's `code`, `hint` and `request_id`:

- `401 gateway_key_missing` / `gateway_key_invalid` (unknown and revoked keys look the same).
- `403 provider_not_allowed`: the Provider does not exist, is disabled or archived, or is outside the key's scope. All four look the same on purpose.
- `403 model_not_allowed`: the key's scope narrows this Provider to other models.
- `400 invalid_request` / `model_required`: the body is not a JSON object or names no model.
- `502 upstream_redirect`, `endpoint_misconfigured`: the Endpoint needs fixing; no other key is tried.
- `503 no_candidate`: nothing can serve this until the Owner acts. `details.reason` is `no_endpoint`, `no_upstream_key` or `no_usable_key` (every key disabled, invalid or restricted to Endpoints that cannot serve the Request).
- `503 keys_cooling`: every usable key is cooling; `Retry-After` and `details.until` say when the first is back. No Attempt was made.
- `404 model_unavailable`: the Provider refused this model to every usable key (`details.reason` `model_gap`; `details.until` is when the first gap expires). Use another model.
- When every Attempt failed, the error lists them in `details.attempts` (key, status, rule, outcome, reason, action) and `details.summary` (one line): `400`-class `upstream_rejected` (the Provider refused the request itself, with its status and message; no other key is tried), `504 upstream_timeout` (no first byte within the time budget), `503 upstream_unavailable` with `Retry-After` (the keys tried are cooling), otherwise `502 upstream_failed`.

## Reading Requests

`GET /api/requests` lists Requests newest first (filter by `caller`, `provider`, `model`, `status` such as `429` or `5xx`, `since`); `GET /api/requests/<x-request-id>` adds every Attempt: Endpoint, Upstream Key name, wire model, upstream status or error, timings and token usage (streams included), and for a failed Attempt the Failure Rule it matched, its `outcome`, the `action` taken and the Provider's `failure_body` and `failure_headers`. A Request with a failed Attempt or several Attempts has a one-line `summary`. A Request's `status` is what the Caller received; `error.code` says why it failed when it did. Requests whose Caller could not be identified (401) are not recorded; read `GET /api/logs?kind=request,attempt` for the event trail.
