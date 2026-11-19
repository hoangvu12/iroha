# 04: First Request end to end (OpenAI Chat passthrough)

**What to build:** Through the admin API an agent creates a Provider with one OpenAI Chat Endpoint, adds Upstream Keys, and creates a Gateway Key. A Caller with that Gateway Key sends streamed and non-streamed OpenAI Chat requests to `/providers/<handle>/v1/chat/completions` and gets the upstream answer passed through, with the requested model name echoed. The Request and its Attempt are recorded with caller, route, Shape, model, key, status, timings and token usage (streams included), readable through the admin API.

**Blocked by:** 01, 02

**Status:** done

- [x] Provider handles are unique, immutable and validated
- [x] Gateway Keys and Upstream Keys are readable through the API
- [x] Caller auth accepted via Bearer, `x-api-key` and `api-key`; Caller credentials never reach the upstream
- [x] Upstream keys chosen round-robin
- [x] Streams flow chunk by chunk; usage is captured for streams
- [x] Request and Attempt records readable via the requests API, with route and Shape recorded
- [x] Unknown or out-of-scope Provider gets the uniform refusal

## Comments

Built (packages and the inference-path seams are in `docs/agents/architecture.md`, "The inference path"):

- `internal/providers`: Providers (`/api/providers`, handle `^[a-z0-9]+(-[a-z0-9]+)*$`, max 63, immutable, `enabled`, `archived`), Endpoints (`/api/providers/{provider}/endpoints`, name/url/shape; table already has `auth_style`, `auth_param`, `static_headers`, `renames` for ticket 09, read by the Gateway, not yet exposed), Upstream Keys (`/api/providers/{provider}/keys`, create-or-update by name, or by secret when unnamed so a repeated paste is `unchanged`; auto names `key-N`; duplicate secrets refused; empty secret = keyless; bulk create and bulk delete). All audited, dry-run, bulk, revertible; audit names are `<handle>/<name>`.
- `internal/gatewaykeys`: `/api/gateway-keys` (issue, read, patch, revoke, bulk), secret `sk-iroha_...`, scope `{"all": true}` or Providers each optionally narrowed to models (stored by Provider ID, shown by handle; ready for Pools in 18). `Authenticate` reads Bearer, `x-api-key`, `api-key`.
- `internal/planner`: pure candidate planning with table tests; same-Shape Endpoints only; round-robin `Counter` per Provider.
- `internal/gateway`: `POST /providers/{handle}/v1/chat/completions`. Body forwarded byte for byte (only `model` on rename, and `stream_options.include_usage` on streams the Caller did not ask usage for; that injected usage chunk is dropped before the Caller). Caller credentials, cookies, hop-by-hop, `x-forwarded-*`, `cf-*`, `iroha-*` headers stripped; redirects never followed; only content type and `x-request-id` returned. SSE relayed event by event with flush. Iroha's own errors use the OpenAI envelope plus `code`, `hint`, `request_id`.
- `internal/requests`: Request rows (in progress, then completed) and Attempt rows; `/api/requests` (filters caller, provider, model, status/class, since, until, paging) and `/api/requests/{request}` with Attempts.
- `internal/usage`: OpenAI Chat usage (input, output, cache read, reasoning).
- Log kinds `request` and `attempt`, linked by `request_id` and `provider`.

Decisions worth knowing:

- Uniform refusal is 403 `provider_not_allowed` for unknown, disabled, archived, out-of-scope and malformed handles; a model outside a narrowed scope is 403 `model_not_allowed`.
- 401s (no identifiable Caller) are not recorded as Requests; everything after authentication is, including refusals and bad bodies.
- A new Gateway Key must state its scope (`{"all": true}` is not implied).
- Providers cannot be deleted (handles are never released); archive instead.

Deferred, by ticket: one Attempt only, upstream errors passed through as-is, no budget, Key States or failure bodies on Attempts (05); auth styles, static headers, renames and key-to-Endpoint restriction through the API (09); keep-alives and error events after commit (17); capture and retention, including abandoned `in_progress` rows after a crash (19); global routes and `/v1/models` (12).
