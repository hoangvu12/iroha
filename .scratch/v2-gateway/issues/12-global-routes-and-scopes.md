# 12: Global routes and Gateway Key scopes

**What to build:** Global `/v1/...` routes accept `handle/model`, split at the first slash. Gateway Keys can be scoped to all, or to chosen Providers each optionally narrowed to models. Global `/v1/models` lists exactly what the key may use, qualified, with metadata, from one batched read. Anything out of scope gets the uniform refusal.

**Blocked by:** 11

**Status:** done

- [x] Unqualified names that are not Pools are refused with a hint
- [x] Model IDs with slashes after the handle work end to end
- [x] Global `/v1/models` answers well under 3 s with 2k models
- [x] Response model field echoes the requested qualified name

## Comments

- Built: global `POST /v1/chat/completions`, `POST /v1/responses` (14 merged meanwhile) and `POST /v1/messages` (passthrough and translation), `GET /v1/models`. A global route is the provider-scoped route minus `/providers/{handle}`, mounted with one line per Shape in `gateway.Routes` (`g.globalRoute(sh, scoped)`); 15 adds the Gemini routes the same way. Model addressing lives in `(*exchange).global` (`internal/gateway/global.go`): split at the first slash; unqualified, `/x` and `x/` get 400 `invalid_model_id` with a hint; that branch is where 18 looks Pools up. Unknown, disabled, archived, out-of-scope and malformed handles get the same 403 `provider_not_allowed`; narrowed scopes 403 `model_not_allowed`; hidden models 404 `model_not_found` (as on scoped routes).
- Answers (buffered, streamed, translated) and `requests.model` carry the qualified name; `wire_model` is the Provider's ID (after renames). Scopes keep naming models without the handle; the existing scope column (`gateway_keys.scope`, ticket 04) needed no change.
- `GET /v1/models`: one query over all enabled Providers and their entries, filtered by scope, metadata as `models.CallerModel`; 2,000 models in ~15 ms locally, test bound 1.5 s.
- Deferred: Pools in addressing and in `/v1/models` (18).
