## Setting up a Provider and a Caller

A Provider is one upstream service; Callers reach it at `/providers/<handle>/v1/...`. Four calls take it from nothing to a working Caller, and each is safe to repeat (`PUT` creates the record named by the path, or updates it; a repeat answers `unchanged`):

```
PUT /api/providers/acme                     {"name": "Acme AI"}
PUT /api/providers/acme/endpoints/default   {"url": "https://api.acme.example/v1", "shape": "openai-chat"}
PUT /api/providers/acme/keys/bulk           {"items": [{"name": "team-1", "secret": "sk-..."}, {"name": "team-2", "secret": "sk-..."}]}
PUT /api/gateway-keys/discord-bot           {"scope": {"all": true}}
```

Use `POST` (`POST /api/providers {"handle": "acme"}`, `POST /api/providers/acme/keys/bulk {"items": [{"secret": "sk-..."}]}`) when you mean "new": a name already in use is refused with `409 name_taken` instead of changing that record.

- **Handles** are lowercase letters, digits and single hyphens (at most 63). They never change and are never reused, so choose them with care. Retire a Provider with `PATCH /api/providers/<handle>` `{"archived": true}`.
- **Endpoint URLs** carry the version path (`.../v1`, `.../api/paas/v4`); Iroha appends the operation path such as `/chat/completions`. Endpoints speaking the Caller's Shape serve it first; others are used through translation (see "Shapes and translation").
- **Several Endpoints** (regions, plan-specific URLs, an Anthropic-compatible URL) live on one Provider, each by name: `PUT /api/providers/acme/endpoints/eu {"url": "...", "shape": "openai-chat"}`. Each has its own `auth_style`: `bearer` (default, `Authorization: Bearer <key>`), `x-api-key`, `header` (the header named in `auth_param`, e.g. `api-key`), `query` (the query parameter named in `auth_param`, e.g. `key`) or `none`; `static_headers` sent on every Attempt (for a fixed credential use `auth_style` `none` and put it here); and `renames` such as `{"glm-4.6": "glm-4.6-fp8"}` (the model a Caller names -> the model sent to this URL, applied per Attempt, so failing over to another Endpoint sends that Endpoint's name). Maps replace the whole set; `{}` clears one. A Provider holds each URL once per Shape: a second Endpoint with the same URL and Shape (by `POST`, `PUT` under another name, bulk or `PATCH`) is refused with `409 endpoint_duplicate`, whose hint names the Endpoint that has it.
- **Upstream Keys** added without a name (`POST .../keys`, `POST .../keys/bulk`) get the next free name `key-N`. A secret the Provider already holds is refused with `409 upstream_key_duplicate` naming the key that has it (never the secret), so pasting the same key twice never makes a duplicate; in bulk only that item fails. A named key without a secret is a keyless slot that sends no credential in any auth style; a 401 to a keyless Attempt moves on without making the key invalid. `"endpoints": ["eu"]` on a key (`POST`, `PUT`, bulk or `PATCH`) restricts it: it is only ever sent to those Endpoints; `[]` lifts it. Deleting an Endpoint takes it out of keys' restrictions in the same Audit Entry, and is refused with `409 endpoint_in_use` while a key may use that Endpoint alone. Secrets are always readable with `GET /api/providers/<handle>/keys`.
- **Gateway Key scopes** are `{"all": true}` or `{"providers": [{"provider": "acme"}, {"provider": "other", "models": ["glm-4.6"]}]}`. The answer contains the key's secret; it stays readable with `GET /api/gateway-keys/<name>`.

Iroha keeps the turns of one conversation on one of a Provider's Upstream Keys and spreads conversations over the keys (see "Conversation affinity"); Requests with no conversation, and Providers with affinity off, use the keys in turn (round-robin). Keys that are disabled, invalid or cooling, and keys with a Model Gap for the model, are skipped; when an Attempt fails it moves on to the next key within the Request budget (see "Key States and Failure Rules"). A key that answered 5xx is tried once more, after every other key and a short pause (about 250 ms, longer when the Provider's `Retry-After` asks, up to 60 s); a replay that could not start before the first-byte budget runs out is not made.

Every Attempt of a Request carries the same `Idempotency-Key` header: the Caller's own when it sent one (forwarded unchanged), otherwise a UUID Iroha makes for the Request. A Provider that honours it never bills a replayed Attempt twice.

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
- `503 shutting_down`: Iroha restarted while the Request was in flight and it outlived the drain limit; retry.

### Streams

A streaming Caller (`"stream": true`) never waits in silence, so proxies in between (Cloudflare's 100 s limit, idle timeouts) do not close it:

- If no upstream answer has arrived 10 s after the Request, Iroha commits the response: `200`, `text/event-stream` and a keep-alive comment (`: keep-alive`). Iroha keeps trying keys within the budget meanwhile.
- Whenever the stream is silent for 15 s (waiting for the first byte, or a model pausing mid-answer) another keep-alive goes out. Streams have no overall time limit.
- Before commitment, failures get the HTTP statuses above. After it, the failure is the stream's last event, in the Caller's Shape, with the same `code`, `hint`, `request_id` and `details` (for OpenAI Chat: `data: {"error": {...}}`, with no `[DONE]` after it). Besides the codes above: `upstream_stream_broken` (the Provider's stream broke off mid-answer) and `upstream_not_streamed` (the Provider answered with a single body after the stream had begun).
- The Request records `status` 200 (what the Caller received) with `error.code` saying why it failed.

## Reading Requests

`GET /api/requests` lists Requests newest first (filter by `caller`, `provider`, `model`, `status` such as `429` or `5xx`, `since`); `GET /api/requests/<x-request-id>` adds every Attempt: Endpoint, Upstream Key name, wire model, upstream status or error, timings and token usage (streams included), and for a failed Attempt the Failure Rule it matched, its `outcome`, the `action` taken and the Provider's `failure_body` and `failure_headers`. A Request with a failed Attempt or several Attempts has a one-line `summary`. A Request's `status` is what the Caller received; `error.code` says why it failed when it did. Requests whose Caller could not be identified (401) are not recorded; read `GET /api/logs?kind=request,attempt` for the event trail.
