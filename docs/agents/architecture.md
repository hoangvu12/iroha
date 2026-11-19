# Architecture (read first)

One Go binary (`cmd/iroha`), one SQLite file (`<data-dir>/iroha.db`), pure-Go driver `modernc.org/sqlite` (no CGO, so `GOOS=linux go build ./cmd/iroha` works from Windows). Stdlib `net/http` only. Module path `github.com/hoangvu12/iroha`.

## Package map

| Package | Owns |
|---|---|
| `cmd/iroha` | `main`: flags, signals, `server.Run`. Nothing else. |
| `internal/config` | Startup flags and `IROHA_*` env (`--data-dir`, `--addr`, `--log-level`, `--log-format`, `--drain-timeout`). Runtime settings live in the database, not here. |
| `internal/server` | Wiring: open store, migrate, logs, close interrupted Requests, bootstrap token, jobs, route table (`routes.go`, one line per module), serve, drain. Health routes. Keep thin. |
| `internal/api` | Route table type, Router (auth, JSON, error envelope, 404/405), OpenAPI and `/skill.md` generation, skill text in `internal/api/skill/*.md`. |
| `internal/store` | `Open`, `Tx`, `Migrate`, time helpers; every migration in `internal/store/migrations/`. Feature packages write their own SQL against `*store.DB`. |
| `internal/logs` | slog handler (console + `log_events`), event kinds (core ones and the shared ones later tickets emit), `GET /api/logs`. |
| `internal/clock` | `Clock` interface, `Real`, `Fake`, `WithTimeout`, `Sleep`. |
| `internal/audit` | The conventions every admin resource shares: name-or-ID `Resolve`, audited `Mutate` with `dry_run`, `Bulk` with per-item results, Audit Entries (`/api/audit-entries`, with `/api/audit-entries/filters` listing the actors and resources in use) and revert. See "Add an admin resource". |
| `internal/admintokens` | Admin Token storage, the admin authenticator, the bootstrap token, `/api/admin-tokens` (the reference resource for the audit conventions). |
| `internal/session` | The Owner password (PBKDF2), 30-day browser sessions (`iroha_session` cookie, SameSite=Strict, secrets stored as SHA-256), the session authenticator (actor kind `owner_session`, name `Owner`), `/api/session`, `/api/owner-password`, `/api/owner-sessions`. |
| `internal/webui` | Serves the embedded UI: `dist/` (Vite output, built from `web/`) and `brand/` (Iroha art, committed). Unknown page loads get `index.html`; other misses the JSON 404. |
| `internal/ids` | Record IDs (`at_xxxx`) and secrets. |
| `internal/shape` | The four Shape names. |
| `internal/testkit` | In-process server, clients, fake upstreams. |
| `internal/providers` | Providers, Endpoints (URL, Shape, auth style, static headers, renames; validated in `checkEndpoint`), Upstream Keys and their restriction to Endpoints (`upstream_key_endpoints`, `restrictions.go`): tables, audited admin routes (`/api/providers`, `.../{provider}/endpoints`, `.../{provider}/keys`, key `enable`/`disable` singly and in bulk, `.../{provider}/summary`, `.../{provider}/model-gaps` and key `clear-model-gaps` singly and in bulk in `gaps.go`), the per-Provider Request budget (`EffectiveBudget`), and `Store.Routing(handle)`, the routing view the Gateway plans over (Key States and restrictions included). `Routes(tr, db, log)`. |
| `internal/rules` | Failure Rules, pure and table-tested: a `Rule` is data (status, code, body regex, headers, scope, `Outcome`, reset sources); `Set.Classify(Failure, now)` gives a `Decision` (rule, outcome, reason, reset time, the status it read). `Builtin` (`builtin.go`; one entry per rule) holds the provider quirks of 07 and the generic fallbacks; `Merge(owner, builtin)` lets same-named rules override. A built-in for one Provider's quirk targets it by `Host` (comma-separated domains of the service, e.g. `aliyuncs.com`), never by handle; codes nothing else uses differently are global. Errors inside a 2xx answer (`EmbeddedError`) are read as the status they stand for, and an event-stream failure body by its first JSON payload, so streamed and buffered errors match the same rules. `builtin_test.go` has a recorded body for every built-in and fails when a rule has none. |
| `internal/failurerules` | Failure Rules managed through the admin API (`/api/rules`): the `failure_rules` table (Owner rules, overrides of built-ins by name, built-ins switched off; a row exists only while a rule differs from its built-in), the audited `failure_rule` resource whose record ID is the rule name (built-ins always exist, cannot be deleted), hit counts from `attempts.rule`, the dry-run `replay` of recent failed Attempts, and `Store.Set`, the live `rules.Set` passed as `gateway.Options.Rules` (reloaded when triggers bump `failure_rules_version`, so API changes and reverts apply to the next Request). |
| `internal/keystate` | Runtime Key States (`key_states`, `key_model_cooling`): `Store.Fail` applies a Decision (invalid, cooling with doubling to 1 h, reset times, escalation to the whole key, `model_gap`), `Succeeded`, `TestPassed`, `Reset` (on a secret change); `View` combines with the Owner's `disabled` into the one Key State the API shows. Logs `key.state`. Model Gaps (`gaps.go`, table `model_gaps`, 24 h): `Record.LiveGaps`/`GapsByModel`, `ClearGaps(ctx, tx, key, model, why, now, track)` (discovery in ticket 10 calls it with `track` nil), `Store.ExpireGaps`, `GapResource` (audit resource so clearing by hand is revertible), `LogGaps` (`model_gap`). |
| `internal/gatewaykeys` | Gateway Keys, their scope and capture switch: `/api/gateway-keys`, `Store.Authenticate(r)` (Bearer, `x-api-key`, `api-key`) returning a `Caller` with `AllowsProvider` / `AllowsModel` and `Capture`. |
| `internal/planner` | Candidate planning, pure: `Plan(Request, []Provider, Rotation)` gives the ordered (Provider, Endpoint, key, wire model) list or why there is none, leaving out disabled, invalid and cooling keys, keys with a live Model Gap for the wire model and keys restricted to other Endpoints (`Result.Skipped`; empty plan `no_usable_key`, `cooling` or `model_gap`, the last two with `Until`). Endpoints come in tiers (`endpointTiers`); the first tier with a candidate is used. Auth style constants and `Endpoint.WireModel` live here. `Counter` is live round-robin, `Fixed` is for previews. Table-tested. |
| `internal/gateway` | Inference routes. Orchestrates one Request across the seams below; owns Attempt execution (outbound request, header filtering, passthrough relay buffered or streamed, model echo; `embedded.go` turns an error sent as a 2xx answer, before anything reaches the Caller, into a failed Attempt), the budget loop over candidates (`budget.go`), key tests (`keytest.go`, `AdminRoutes`) and the Caller-facing error envelope. `Options.Rules` supplies the Failure Rule set (default `rules.Default`). Streams to the Caller (`stream.go`): early commit, keep-alives, error events, per Shape behind `streamShape`. `Abort` (`shutdown.go`) ends in-flight Requests when the drain limit runs out. |
| `internal/requests` | Request and Attempt history: `Recorder` (Begin, Attempt, Finish, SaveCapture), `Capture` (tees the Caller's body and response writer; streams reassembled per Shape in `capture.go`), `Recover` (at startup, Requests left in progress become `interrupted`), `/api/requests` (filters in `filter.go`, shared with `/api/requests/stats` and `/api/requests/filters` in `stats.go`; `changed_after` cursor to follow the feed) and `/api/requests/{request}/capture`. |
| `internal/settings` | Runtime settings: `settings.NewInt(...)` declares one (in the package that reads it), `.Get(ctx, db)` reads it; `/api/settings` with the audit conventions. |
| `internal/jobs` | The background job runner: `Job` (name, `Schedule`, `Run(ctx, dryRun)`), `Runner` (timers on the injected clock, runs of one job never overlap, each run stored in `job_runs` and logged as `job.run`), `/api/jobs` and `POST /api/jobs/{job}/run`. |
| `internal/retention` | The retention settings (`retention.history_days`, `.logs_days`, `.captures_days`) and the hourly `retention` job deleting older Requests (with Attempts), captures, log events and ended Owner sessions (revoked or expired longer ago than `.logs_days`). |
| `internal/usage` | Token usage parsing per Shape (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini), for bodies and stream events: `NewReader(shape)`, read from the Endpoint's answer before translation. |
| `internal/translate` | Shape translation (ADR-0004): the only importer of RelayKit. `New(from, to, Options)` per Attempt gives `Request`, `Response`, `Stream` (`Event`, `End`); `Targets(from)` feeds the planner. One `codec` per Shape (`codec.go`, `chat.go`, `anthropic.go`, `responses.go`, `gemini.go`); golden tests in `testdata/golden/`. See "Ticket 13: translation". |
| `internal/normalise` | Normalisers (16), pure and table-tested: content rewrites for Provider quirks, in the Endpoint's Shape. `For(endpointURL, shape)` gives a `Set` (`RequestBody`, `Body`, `Stream` with `Event`/`End`); `Builtin` lists them (name, side, Shape, `Host`, catalog cases); `Applying` feeds the Provider summary. See "Ticket 16: normalisers". |
| `internal/models` | Model lists (10): entries in `provider_models` with independent flags (discovered = a row in `provider_model_sources`; `added`/`hidden` = the Owner's, audited resource `model`), discovery (`Store.Refresh`, `Store.Reset`), `Store.Prepare` (refusals and carriers before planning), `/api/providers/{provider}/models[...]` and the Caller route `GET /providers/{handle}/v1/models`. See "Ticket 10: model lists". |
| `internal/modelmeta` | Model metadata (11), pure and table-tested: `Facts` (the fields Callers' model lists carry; also the Owner override format), `Normalize` (field aliases of Provider lists and models.dev), `Catalog.Lookup(brand, model)` (exact, dot-versus-dash, bare name to one numbered release; ambiguous gives nothing), `Resolve` (precedence), `Served` (chat ok unless known not to). `Source` reads models.dev (`--models-dev` base URLs, cache, single flight, ETag). See "Ticket 11: model metadata". |
| `internal/modelrefresh` | The daily model refresh (20): when each Provider is due (`DailyAt`, `nextRefresh`), the `model_refresh` job calling `models.Store.Refresh`, `GET /api/model-refreshes`. Scheduling only. See "Ticket 20: daily model refresh". |
| `internal/pools` | Model Pools (18): `pools`/`pool_members` tables, the audited `pool` resource (`/api/pools`, members replaced as a whole list), `Store.Lookup(name)` / `Store.All` (the `Routing` view: members in order, switched on or off, budget override), `ResolveID`/`Names` for Gateway Key scopes, `GuessMaker`. No routing logic. See "Ticket 18: Model Pools". |
| `deploy` | `deploy.sh` (run locally: build, copy, back up, swap, restart, readiness, rollback over SSH keys), `remote.sh` (its server half), `iroha.service` (systemd unit template), Go tests tying the unit's stop timeout to the drain limit and the runbook (`internal/api/skill/50_deploy.md`) to the script. `deploy/test/e2e.sh` runs the scripts against a local Docker container with systemd and sshd; run it after changing anything in `deploy/` (needs Docker; never point it at a real server). |

Suggested homes for later work (create when needed, one package per concern so parallel tickets do not collide): `rules` (provider built-ins in 07 are entries in `rules/builtin.go`; `failurerules` lists them and lets agents override them by name with no further work), `models` (lists, discovery, metadata; 10, 11; discovery clears Model Gaps with `keystate.ClearGaps`), `pools` (18), `translate` and `normalise` (13–16). The daily model refresh (20) is a `jobs.Job` added in `server.New` next to `retention.Job`. The UI is in `web/` (see "Frontend").

## The inference path

One Request runs through four seams, in this order. Change the seam that owns a behaviour; keep `internal/gateway` an orchestrator.

| Step | Owner | Today (04, 05, 09) | Who extends it |
|---|---|---|---|
| 1. Caller auth and scope | `gatewaykeys.Store.Authenticate`, `Caller.AllowsProvider/AllowsModel` | Gateway Key from Bearer, `x-api-key`, `api-key`; scope `all` or Providers each optionally narrowed to models. Unknown, disabled, archived and out-of-scope Providers get one 403 `provider_not_allowed`. | 12 (global routes, `/v1/models`), 15 (`x-goog-api-key`, `key=`), 18 (Pools in scope), 23 (Test caller) |
| 2. Candidate planning | `planner.Plan` over `providers.Store.Routing` | Endpoints in tiers (`endpointTiers`): the Endpoints of the Caller's Shape, then those of a Shape in `Request.Translate` (13); a later tier is used only when no earlier tier yields a candidate. Within a tier, keys round-robin (`Counter` per Provider ID), each key on every Endpoint of the tier it may use (`Key.Allows`: restriction to Endpoints, 09); renames applied per Endpoint (`Endpoint.WireModel`). Disabled, invalid, cooling, model-cooling, Model Gap and restricted keys are skipped (`Result.Skipped`, the serving tier's only). Keyless keys (empty secret) are planned like any other. Empty plan says why (`no_endpoint`, `no_upstream_key`, `no_usable_key`, `keys_cooling` until T, or `model_gap` → 404 `model_unavailable`). Expired gaps in the routing view are deleted and logged first (`gateway/gaps.go`). | 10 (carriers first), 13 (append the other-Shape Endpoints as a second tier in `endpointTiers`: that alone gives "translate when no same-Shape Endpoint has a candidate"), 18 (Pool members) |
| 3. Attempt execution | `gateway/budget.go`, `gateway/attempt.go` | `exchange.serve` walks the candidates within the budget (`max_attempts`, default 3; first byte within 60 s of arrival, per Provider up to 95 s, one deadline per Request so a timed-out Attempt ends it). Each failure goes through `rules.Set.Classify`; invalid/cooling/model-gap outcomes go to `keystate.Store.Fail` (a gap leaves the Key State alone), and those keys are out for the rest of the Request; when every Attempt was refused with `model_gap` the Caller gets 404 `model_unavailable`; a 5xx key+Endpoint is replayed once, last. `fail_request` answers the Caller; otherwise the error carries `details.attempts` and `summary`. One Attempt (`attempt`): `outbound` builds URL + op path, forwards Caller headers except credentials/hop-by-hop/`x-forwarded-*`/`cf-*`/`iroha-*`, applies static headers then the key per the Endpoint's auth style (`bearer`, `x-api-key`, `header` named by `auth_param`, `query` parameter named by `auth_param`, `none`); a keyless Attempt (`Key.Keyless`: empty secret or style `none`) sends no credential and drops any Caller header in the auth slot, and `noCredential` turns its `invalid` verdict into `retry_elsewhere`. Key tests (`keytest.go`) use the same `outbound`, with a tiny call per Shape (`testCall`) on the first Endpoint the key may use or `?endpoint=`. Redirects are never followed. Before relaying a 2xx answer, `embeddedError` (`embedded.go`) reads a stream up to its first data event (past comments) or a buffered body whole; if that is an error (`rules.EmbeddedError`), the Attempt fails with it (status 200, the event as `failure_body`) and is classified like any failure, else what was read is put back in front of the body. On a translated Attempt a whole 2xx answer that is not JSON (an HTML page) fails the same way (`notJSON`, read as a 502 by the rules); passthrough relays it as is. `relayStream` forwards SSE event by event with flush; `relayBuffered` otherwise. `passRelay` echoes the requested model, reads usage, drops the usage chunk Iroha injected (translated answers: see "Ticket 13: translation"). Streaming Requests (17, `stream.go`) run a keeper beside the budget loop: no upstream answer after `StreamCommitAfter` (10 s) commits 200 + stream headers, and `KeepAliveEvery` (15 s) of silence sends the Shape's keep-alive, before and during the stream. Every write to the Caller goes through `exchange.mu` (`writeHead`, `send`, `writeError`, `setHeader`); `x.fail` after commitment (or once a relayed stream began) writes the Shape's error event with the same envelope, the record keeping status 200 with the error code. A Shape that streams adds a `streamShape` (`keepAlive`, `errorEvent`) to `streamShapes`. | 07 (more built-in Failure Rules; agent rules from 06 arrive through `Options.Rules`), 13–16 (translate/normalise between relay and Caller; a `streamShape` per Caller Shape) |
| 4. Recording | `requests.Recorder`, log kinds `request` and `attempt` | Request inserted `in_progress` once the Caller is known (401s are not recorded), one row per Attempt, completed with status, error code, serving Provider/Endpoint/key/wire model, Shapes, first byte, duration, usage. Writes ignore the Caller's cancellation. With capture on, `exchange.begin` wraps `r.Body` and the response writer in a `requests.Capture` and `finish` stores it, so Attempt code never deals with capture: whatever reaches the Caller is captured. Failed Attempts store the matched `rule`, `outcome`, `reason`, `action`, `failure_headers` and `failure_body` (64 KiB); the Request gets a one-line `summary`. `NoteProvider` names the Provider as the first Attempt starts. Triggers (migration `25_01`) give every inserted or updated Request, and every stored capture, the next `rev`, so readers follow changes with `GET /api/requests?changed_after=<cursor>` and no writer has to know. | 13–15 (stream reassembly of other Shapes in `requests/capture.go`, `reassemblers`: Anthropic done in 13), 18 (write `requests.pool`, the Pool the Caller named; the feed already shows and filters it), 23 (Test Requests: `caller_kind = 'test'` (`requests.CallerTest`), name `Test` or `Test (as <key>)`, `gateway_key_id` may name the key: the `caller=<key ID>` filter never matches them) |

### Ticket 13: translation

- Routes: each provider-scoped inference route is `serveProvider(shape)`; the body is read by `readBody(r, shape)` into a `callerRequest` (Shape, model, stream, include_usage). Global routes: see "Ticket 12: global routes".
- Per Attempt, `exchange.prepare` picks passthrough (Endpoint Shape = Caller Shape: `preparePassthrough`, `passRelay`) or translation (`translate.New(...).Request`); the op path comes from `opFor(endpoint shape, wire model, stream)`. Translated answers go through `translatedBody` or `relayTranslatedStream`. Usage is always read from the upstream answer in the Endpoint's Shape (`usage.Reader`).
- Errors and keep-alives follow the Caller's Shape: `errorEnvelope(shape, ...)` in `exchange.go`, `streamShapes` in `stream.go` (Anthropic: `ping` events, `event: error`).
- Adding a Shape (14, 15): a `codec` in `internal/translate` (DTOs, request fix-ups, upstream event reading, answer tidy-up, stream writer), golden cases, its `streamShape`, `errorEnvelope` branch, `opFor`, `bodyHints`, `usage.Reader` and `requests.reassemblers` entries, and its route via `serveProvider`.
- Normalisers (16) hook on the upstream answer in the Endpoint's Shape, before `passRelay` or `translate` sees it, so both paths get them.

Body edits are byte-preserving: `gateway/jsonedit.go` (`setField`, `field`, `echoModel`) replaces one top-level value in place, so passthrough never re-serialises a body. Streams of OpenAI Chat get `stream_options.include_usage` added when the Caller did not ask, so usage is recorded for every stream.

### Ticket 15: Gemini

- **Route**: `POST /providers/{handle}/v1beta/models/{model...}` (`gateway/gemini.go`). The model and stream flag come from the URL: `readBody` calls `readGeminiTarget`, which splits the method off at the last colon (`generateContent`, `streamGenerateContent`; anything else is 404 `operation_not_supported`) and keeps the rest, slashes included, as the model. Ticket 12's global Gemini route can reuse it as is and split `handle/model` itself.
- **Upstream op**: `opFor(shape, model, stream)` (was `opFor(shape)`); for Gemini it is `geminiOp`: `/models/<wire model>:generateContent`, or `:streamGenerateContent?alt=sse`. Iroha always asks Gemini Endpoints for SSE and always answers Gemini Callers with SSE (no JSON-array stream). On passthrough the body is untouched (no model field to rewrite) and `modelVersion` is echoed as the Caller's model.
- **Caller auth**: `gatewaykeys.Credential` also reads `x-goog-api-key` and the `key` query parameter. Upstream URLs are built from the Endpoint and the op only, so the Caller's query never reaches a Provider.
- **Errors and keep-alives**: Google's envelope (`geminiError`: `code` = HTTP status, `status` = gRPC name, Iroha's code as `reason`, plus `hint`, `request_id`). The keep-alive is a data chunk with one empty text part, because the Google SDKs parse every SSE line as JSON and choke on comments.
- **Codec**: `codec.chatHop` makes a Gemini Caller's answers go Endpoint → Chat → Gemini in two RelayKit steps (`translate/hop.go`), because RelayKit's direct converters drop reasoning and usage details; the writer patches thought parts and `usageMetadata` from the Chat form. `codec.noteRequest` reads `includeThoughts` from the request. URL images become `fileData` with a MIME type guessed from the extension.
- **Usage**: input = `promptTokenCount` + `toolUsePromptTokenCount`, output = `candidatesTokenCount` + `thoughtsTokenCount`, reasoning = thoughts, cache read = `cachedContentTokenCount`. Each stream chunk's counts are the running total.

### Ticket 14: OpenAI Responses

- Per-Shape files, following "Adding a Shape": `translate/responses.go` (codec), `gateway/responses.go` (`responsesStream`, `opResponses`, route docs, `echoResponsesEvent` for passthrough: the model lives in the event's `response` object), `usage/responses.go`, `requests/capture_responses.go`; one line each in `codecs`, `streamShapes`, `opFor`, `bodyHints`, `reassemblers`, `usage.Reader` and `Routes`. The global `/v1/responses` waits for 12 (`serveScoped` with `shape.OpenAIResponses`).
- Two codec hooks were added for it, optional for other Shapes: `fixUp` (correct the decoded upstream DTO before conversion; Responses copies `output_tokens_details.reasoning_tokens` where RelayKit reads it) and `streamID` (name a stream converted to the Shape; Responses uses `resp_<Request ID>`, also for buffered answers). `Stream` passes `EmitSequenceNumber` (only Responses output uses it) and, before finalising, pushes the usage merged over every event into each converter step, so a two-step conversion (Anthropic → Chat → Responses) closes with the whole usage.
- The Responses stream writer renumbers `sequence_number`, adds the `content_part.added/done` events RelayKit leaves out (the SDKs' stream helpers need them), unwraps RelayKit's `{Type, Payload}` events and tidies every response object. Iroha's failure on a Responses stream is `event: error` (with a top-level `error` object, which the OpenAI SDKs raise) then `response.failed`.
- Responses stateful fields are refused by RelayKit toward Chat and Anthropic (→ 400 `untranslatable_request`); requests translated to Responses get `store: false` unless set; `store` is dropped toward Chat. The fake Responses upstream (`testkit`) now sends OpenAI's full event sequence for a message.

### Ticket 16: normalisers

- `exchange.prepare` takes `normalise.For(endpoint URL, endpoint Shape)` per Attempt and runs `RequestBody` on the body sent (passthrough or translated). The answer is normalised before anything reads it: a whole 2xx answer by `normaliseBody` (after `embeddedError`; a `normalise.Failure` makes it a failed Attempt with status 200), a stream event by event in `relayStream` (`normaliseEvent`, then `passRelay.data`) and `relayTranslatedStream` (before `translate.Stream.Event`). `Stream.End` runs only when the body ended without a transport error, and may add events (held text, a closing chunk, `[DONE]`).
- Selection: a normaliser for a model's quirk has no `Host` (relays pass it on); one for a service's own vocabulary has the service's hosts, like built-in Failure Rules. Each acts only when its construct is present and otherwise returns the same bytes, so passthrough stays byte-preserving. A rewritten JSON body is re-encoded (keys sorted, numbers kept, no HTML escaping).
- Adding one: an entry in `normalise.Builtin` and its code in the Shape's file (`chat.go`); a normaliser for another Shape needs `Set.Body`/`Stream` to dispatch on it, and `normaliseEvent` frames added events as data-only (enough for OpenAI Chat; a Shape with event names needs framing per Shape).

### Ticket 10: model lists

- **Configuration** lives on Providers and Endpoints (`internal/providers`): `strict` and `discovery` (`none`, `provider` default, `key`) on the Provider, `discovery_url` (`""` = `<url>/models`, `"none"`, or a URL) on the Endpoint. `providers.Routing` carries them (`Strict`, `Discovery`, `DiscoveryURLs`).
- **Before planning**, every inference route calls `models.Store.Prepare(ctx, &provider, model)` after the scope check: hidden models, and unlisted models of strict Providers (renamed Caller names count as listed), get 404 `model_not_found` before any Attempt; it then sets `planner.Key.Carries` from per-key lists, and `planTier` moves carriers of each Endpoint's wire model ahead of the other keys, keeping round-robin within both groups. Global routes (12) and Pools (18) call `Prepare` per Provider the same way.
- **Discovery** (`Store.Refresh(ctx, providerRef, dryRun)`, usable as a `jobs.Job` body for 20; `Store.LastRefreshOf` reads `model_refreshes` to find Providers that are due): per Endpoint (first usable key, up to 3 tried, keyless when the Provider has no key for it) or per key and Endpoint. Each successful list replaces its own rows in `provider_model_sources`; failed lists keep theirs. Lists of Endpoints set to `none`, of the other mode, and of keys restricted away are dropped; disabled or invalid keys' lists are kept unread. A key's list clears that key's Model Gaps for the models it names (`keystate.ClearGaps`, `track` nil). One `discovery` event per list plus one per refresh. `provider_models.reported` keeps each model's object as last discovered with metadata (a bare `{"id"}` keeps the earlier object; the first list in Endpoint and key order with facts wins), for metadata (11). Creating a Provider, Endpoint or key does not trigger discovery; the daily job (20) first refreshes a new Provider within the hour.
- **Entry IDs** are derived from (Provider ID, model) (`entryID`), so an entry dropped by discovery and found again keeps its ID and its Audit Entries. The audit snapshot holds only `added` and `hidden`; an entry with neither "does not exist" for audit, so adding a discovered model is a create and its revert only clears the flag.

### Ticket 11: model metadata

- **Layers** per `provider_models` entry: `overrides` (Owner, JSON `modelmeta.Facts`, in the `model` audit snapshot; keeps the entry like `added`/`hidden`), `reported` (raw object from discovery, normalised at read time) and `external` (models.dev facts, with `external_brand`, the brand they were looked up under; ignored once the Provider's `models_dev_brand` differs). `modelmeta.Resolve(overrides, reported, external)` then `modelmeta.Served`.
- **Lookups** (`models.Store.supplement`) run after every `Refresh` (skipped ones too) and after Owner changes commit, never inside a transaction holding the write lock across the network. The catalog comes from `modelmeta.Source`: off when `config.ModelsDev` is empty (`--models-dev none`; the zero `config.Config` and `testkit` default), so tests never reach models.dev; `testkit.NewModelsDev(t)` is a fake to pass as `testkit.Options{ModelsDev: md.URL}`. Failures only log `models_dev` events and leave stored facts as they were.
- **Serving**: `models.Store.Metadata(ctx, providerID)` reads a Provider's entries in one query; `Metadata.Of(model)` gives the served facts (chat ok for unknown models). `models.CallerModel` embeds `modelmeta.Facts`; ticket 12's global `/v1/models` should emit the same type per `provider/model`.
- The daily job (20) refreshes, and so re-looks up, every scheduled Provider; `discovery none` Providers are not scheduled, so theirs are looked up on Owner changes and on a refresh by hand.

### Ticket 12: global routes

- **Mounting**: each inference route is listed in `gateway.Routes` with its global variant beside it, `chat, g.globalRoute(shape.OpenAIChat, chat)`: the same route minus the `/providers/{handle}` prefix, its summary and description adapted, served with the `global` resolver. Chat, Responses and Messages are mounted; a new Shape (15) adds its global route with that one line; `globalRoute` panics on a path outside the prefix.
- **Resolvers**: `gateway.serve(w, r, sh, resolve)` runs every inference Request; a `resolver` turns the model the Caller named into the Provider (scope-checked, `models.Prepare` applied) and the model on that Provider. `(*exchange).scoped` takes the handle from the path; `(*exchange).global` (`gateway/global.go`) splits at the first slash (`splitModel`) and refuses an unqualified name with 400 `invalid_model_id`. That branch is the one place ticket 18 looks a Pool up (and will return several Providers). `cr.model` stays the name sent, so echoes (`passRelay`, `translate.Options.Model`) and `requests.model` carry the qualified name; planning, Key States and `wire_model` use the Provider's.
- **`GET /v1/models`** (`models/global.go`, `Store.CallerModels(ctx, caller)`): one query over every enabled, unarchived Provider and its entries, filtered by the Caller's scope in Go (narrowed Providers list exactly their scope models minus hidden ones), metadata resolved per row like `Store.Metadata`. 2,000 models answer in ~15 ms (`TestGlobalModelListAnswersQuicklyWith2000Models`). Ticket 18 appends Pools there.

### Ticket 20: daily model refresh

- **When**: each Provider has a fixed time of day, `DailyAt(id)` (hash of the Provider ID, whole minutes UTC). It is due at the first occurrence of that time at least 12 h after its last refresh (`model_refreshes`, so a refresh by hand counts). Never refreshed, or due while Iroha was down: due at `max(start, created) + DailyAt mod 1h`, i.e. spread over the hour after the start (no burst) and a new Provider is discovered within the hour. Disabled, archived and `discovery none` Providers are not scheduled.
- **How**: the `model_refresh` job runs `jobs.Every(15m)` and refreshes what is due, one Provider at a time, so a refresh lands at most 15 min after its time. No table of its own: `model_refreshes` (10) is the state.
- **Tests**: a test that creates a Provider with keys and advances the clock past an hour now sees model-list GETs on its fake (`gateway` tests' `bearers` skips GETs). Tests counting `job.run` events filter on `attrs.job`.

### Ticket 18: Model Pools

- **Resolving**: a resolver now returns a `route` (`gateway.go`): the `planner.Provider`s to plan over, in order, plus for a Pool the `pools.Routing` and a `memberNote` per member. `(*exchange).global` sends a name without a slash to `poolRoute` (`gateway/pool.go`): unknown or out-of-scope Pools get the same `errNotQualified`; each switched-on member on an enabled Provider whose model `models.Prepare` accepts becomes one Provider with `planner.Provider.Model` set (the planner asks each Provider `ModelFor(req)`); the others are noted (`off`, `provider_unavailable`, `model_not_offered`). No plannable member: 503 `no_candidate`, reason `no_member`. The Pool scope is the grant: members are not checked against the key's Providers.
- **Budget**: `exchange.pool` holds the Pool; `(*exchange).budget(p)` gives the Pool's override over the Provider's (Attempts fixed by the first candidate, first-byte deadline from the Request's arrival, 95 s ceiling), so one budget covers every member. `failAll` names the Pool ("Every Attempt on Model Pool p failed").
- **Recording**: `exchange.rec.Pool` goes to `requests.pool` in `NoteProvider` and `Finish`; Attempts already carry the serving Provider and wire model.
- **Scopes**: `gatewaykeys.Scope.Pools` (stored as Pool IDs, shown as names; `Caller.AllowsPool`). `pools` deletes refuse with 409 `pool_in_use` while an unrevoked key's scope holds the Pool (`json_each` over `gateway_keys.scope`).
- **`/v1/models`**: `models.Store.callerPools` lists the key's Pools first (by name), metadata from the first switched-on member on an enabled Provider (every enabled Provider's entries are read, not only the key's), `owned_by` the maker.
- **Route preview** (`gateway/preview.go`, `GET /api/route-preview?model=&shape=&as=`): runs `(*exchange).global` on an exchange that answers no one, then `planner.Plan` with `Counter.Peek()` (the next Request's round-robin start, without advancing it), and splits candidates and skips per member by `Candidate.Provider`/`Skip.Provider` pointer. `as` uses `gatewaykeys.Store.CallerOf`; no `as` is `gatewaykeys.Unrestricted`. `outcome` is the error a Caller would get before any Attempt. It does not expire gaps (planning already ignores expired ones), so it writes nothing. Last-used times per key are not in it (the Upstream Keys list has them).
- **Maker**: `pools.maker` is the Owner's; empty means `GuessMaker` on the Pool name, then the members' models. Logos are ticket 22's.

### Ticket 26: key order

- **Health first** (FAIL-104): within an Endpoint tier, `planTier` orders candidates by key health, then known carriers, keeping round-robin within each of the four groups. A key is "back from cooling" when `Key.Recovering(wire model)`: its own cooling ended (`CoolingUntil` past) or its cooling for that wire model ended, with no success since (`keystate.Succeeded` and `TestPassed` clear both, so the routing view already holds the fact; no migration). Such keys go after keys with no recent refusal, so a Provider with dozens of keys just out of a 15 min billing cooling serves from its healthy key at the first Attempt; they stay in the plan and are tried when the healthy keys fail. There is still no single-trial claim (FAIL-103).
- **Conformance**: `.scratch/v2-gateway/conformance.md` maps every essential and provider-quirk case of the v1 catalog to the test that covers it. A ticket that changes a mapped behaviour updates its rows; new conformance tests name their catalog IDs at the start of their doc comment (`// PRV-54, REQ-20: ...`).

Nested admin resources (Endpoints and Upstream Keys under a Provider) resolve their parent with the Provider resource and themselves by name or ID *within* that Provider (`resolveChild` in `internal/providers`); their audit names are `<handle>/<name>`, so `GET /api/audit-entries?record=acme/key-1` works.

## Rules everyone follows

- **Time**: never call `time.Now`, `time.After`, `time.NewTimer` or `context.WithTimeout` for anything behaviour depends on. Take a `clock.Clock` and use `c.Now()`, `c.NewTimer`, `clock.WithTimeout(ctx, c, d)`, `clock.Sleep`. Tests use `*clock.Fake`.
- **Stored times** are `INTEGER` unix milliseconds UTC named `*_at`; convert with `store.Millis` / `store.FromMillis` / `store.NullMillis`.
- **Writes** go through `db.Tx(ctx, func(tx *sql.Tx) error {...})` (takes the write lock up front).
- **JSON** fields are `snake_case`; times RFC 3339.
- **Errors** returned from handlers are `*api.Error` with a code, message and a hint naming the next action (`api.Errorf`, `api.BadRequest`, `api.NotFound`). Anything else becomes a 500 and is logged as `http.error`.
- **Secrets** (Admin Tokens, Gateway Keys, Upstream Keys) are stored readable (ADR-0006) but never written to logs.
- Modules take their dependencies explicitly (`*store.DB`, `*slog.Logger`, `clock.Clock`, `*http.Client`); no globals, no service locator.

## Add a route

1. In your package, export `func Routes(deps...) []api.Route` (see `internal/logs/query.go`):

   ```go
   {Method: http.MethodGet, Path: "/api/providers/{provider}", Tag: "Providers",
    Summary: "Read a Provider", Query: []api.Param{...},
    Request: nil, Response: Provider{},
    Handle: func(c *api.Call) (any, error) { ... c.Path("provider") ... }}
   ```

   `Auth` defaults to `api.AuthAdmin` (Admin Token or Owner session); `c.Actor` says who called. Use `api.AuthPublic` for health/login, `api.AuthCaller` for Gateway routes (the handler checks the Gateway Key). Use `Raw` instead of `Handle` for streams and non-JSON bodies. Decode bodies with `c.Decode(&v)` (rejects unknown fields). Use `c.SetStatus(201)` to change the success status. The Owner session authenticator is the second one passed to `api.NewRouter` in `server.New`; the UI calls your route with the cookie, so a route needs nothing UI-specific. A route that changes configuration must also follow "Add an admin resource" below.
2. Add one line to `internal/server/routes.go`.
3. Done: the route is served and appears in `/api/openapi.json` (schemas reflected from `Request`/`Response`; struct tags `json`, `doc:"..."`, `enum:"a,b"`) and in `/skill.md`. `TestDocumentsDescribeEveryRegisteredRoute` fails if anything drifts. Hand-written guidance for agents goes in a new file `internal/api/skill/NN_topic.md` (files are concatenated in name order before the generated route reference).

## Add an admin resource

Every configuration record the API changes (Provider, Endpoint, Upstream Key, Model Pool, Gateway Key, Failure Rule, setting) goes through `internal/audit`, so it gets name-or-ID addressing, `dry_run`, bulk, create-or-update, Audit Entries and revert without new machinery. `internal/admintokens/routes.go` is the worked example; copy its shape.

1. **Snapshot type.** A struct of the record's *configuration* fields as JSON (`snapshot` in admintokens). Leave runtime state out (last used, Key State, counters, discovered lists): it changes without Audit Entries and would make every revert a conflict. When you later add a field, give it a zero value that means the old behaviour; old entries are compared only on the fields they have.
2. **Register the resource** at package level:

   ```go
   var Resource = audit.Register(&audit.Resource[snapshot]{
       Name: "provider", Label: "Provider", Plural: "Providers", Path: "/api/providers",
       Table: "providers", NameColumn: "handle", Secrets: nil,   // Secrets: snapshot fields masked in Audit Entry views
       NameOf:  func(s snapshot) string { return s.Handle },
       Load:    func(ctx, q audit.Querier, id string) (*snapshot, error) { /* nil, nil when absent */ },
       Restore: func(ctx, tx *sql.Tx, id string, s *snapshot) error { /* nil: delete; else upsert */ },
   })
   ```

   `Restore` must update in place (`INSERT ... ON CONFLICT (id) DO UPDATE`), never delete and re-insert, or foreign-key cascades take children with it. Return an `*api.Error` (409) when the current state forbids the restore (name now taken, children present).
3. **Read routes** address records with `Resource.Resolve(ctx, db, c.Path("provider"))` (ID or name; uniform 404 with a hint) or `Resource.Get`.
4. **Mutating routes** put `audit.DryRun` in `Query` (`TestDocumentsDescribeTheConventionsOnce` fails otherwise) and run their writes inside the Trail:

   ```go
   var out Provider
   res, err := tr.Mutate(c, "provider.update", "Edited", func(m *audit.Mutation) error {
       id, err := Resource.Resolve(m.Ctx, m.Tx, c.Path("provider"))
       if err != nil { return err }
       if err := m.Track(Resource, id); err != nil { return err } // before every write, also before an insert of a new ID
       // ... writes on m.Tx, using m.Now for times ...
       out, err = read(m.Ctx, m.Tx, id)
       return err
   })
   return ProviderResult{Result: res, Provider: out}, err   // type ProviderResult struct { audit.Result; Provider Provider `json:"provider"` }
   ```

   `Mutate` handles `dry_run` (runs everything, rolls back), computes `changes` and `outcome` from the first tracked record, writes one Audit Entry when anything changed, logs `config.change`, and answers 201 when the record was created. `Track` every record the change touches, children included (deleting a Provider tracks its Endpoints and keys), parents before children: revert re-creates in tracking order and deletes in reverse. Call `m.Irreversible(reason)` for changes that must not be undone (revoking a secret); `m.Summarize(text)` replaces the generated summary ("Edited Provider acme", "Disabled 3 Upstream Keys").
5. **Create-or-update by name**: `POST /api/<resource>` looks the name up in `m.Tx`; if found, apply only the fields sent (pointer fields in the body) to that record, else insert. The second identical call is then `unchanged` with no Audit Entry.
6. **Bulk**: `POST /api/<resource>/bulk` (create-or-update many) and `POST /api/<resource>/bulk/<action>`, body `audit.BulkRequest[T]`, response `audit.BulkResult[Out]`, implemented by reusing the single-item function: `return audit.Bulk(tr, c, "upstream_key.disable", "Disabled", in.Items, h.disable)`. Each item runs in a savepoint; an `*api.Error` rolls back that item only; any other error aborts the call. One Audit Entry covers the applied items.
7. **Errors**: return `*api.Error` with a code and a hint (`api.BadRequest`, `api.NotFound`, `api.Conflict(code, hint, ...)`, `api.CheckName` for names). Add a new code to the list in `internal/api/skill/10_conventions.md` only if agents should branch on it.

Do not describe these conventions again in your routes' text; `internal/api/skill/10_conventions.md` and the OpenAPI `info.description` say them once. Tests: drive the routes through `testkit` (`srv.NewAdminToken(name)` gives a second actor); assert outcomes, `changes`, `GET /api/audit-entries?record=...`, and that `POST /api/audit-entries/{id}/revert` restores the before-state.

## Add a migration

Add `internal/store/migrations/<ticket>_<seq>_<slug>.sql`, e.g. `04_01_providers.sql`, `04_02_upstream_keys.sql`. Use your ticket number so parallel branches never pick the same name; work outside the ticket list uses the next number above the highest ticket. Files apply in numeric (ticket, seq) order, each once, tracked by name in `schema_migrations`, so a file merged later with a lower number is still applied. Never edit a migration after it has shipped to the server; add another. Each file runs in one transaction.

## Add a setting

Declare it at package level in the package that reads it; it appears in `GET /api/settings` and is changed with `PUT /api/settings/{name}` (audited, revertible):

```go
var HistoryDays = settings.NewInt(settings.Int{Name: "retention.history_days", Unit: "days", Default: 30, Min: 1, Max: 3650, Description: "..."})
days, err := HistoryDays.Get(ctx, db)   // the Owner's value, else the default
```

Read it where it is used, every time, so a change takes effect without a restart. A row exists only while the value differs from the default.

## Add a background job

Iroha runs only the jobs the spec names (hourly retention, daily model refresh). A job is a name, a schedule and a function; add it in `server.New` next to `retention.Job`:

```go
jobs.Job{Name: "model_refresh", Description: "...", Schedule: jobs.Every(15 * time.Minute),
    Run: func(ctx context.Context, dryRun bool) (jobs.Outcome, error) {
        // do what is due; with dryRun, report what would be done and change nothing
        return jobs.Outcome{Summary: "Refreshed 2 Providers.", Details: map[string]any{"refreshed": 2}}, nil
    }}
```

`jobs.Every(d)` first runs `d` after the first start (no burst at startup), then keeps its rhythm across restarts (next = last stored start + `d`, at once when overdue). Write your own `Schedule` (`Next(last, now)`) for anything else; for per-Provider times spread across the day, run often and act on what is due, keeping per-Provider results in your own table. The runner passes `ctx` (cancelled at shutdown: outcome `canceled`), recovers panics (outcome `failed`), never overlaps runs of one job, stores each run (latest 100 per job; dry runs are not stored) and logs `job.run` with your `Details` as attributes (set `Outcome.Provider` to link the event to a Provider). `GET /api/jobs` shows schedule, next run and last run; `POST /api/jobs/{job}/run` runs one now. In tests, add jobs with `testkit.Options{Jobs: ...}`, advance the clock, then `srv.SettleJobs()` waits for the runs that time triggered; `srv.RunJob(name)` runs one through the API.

## Add a log event kind

Kinds several tickets emit are registered once in `internal/logs/kinds.go`; use them and do not register them again (a duplicate name panics at startup):

| Kind | Emitted by | Level | Links | Attributes |
|---|---|---|---|---|
| `attempt`, `request` | gateway (04) | info | Request, Provider | see `gateway.go` |
| `rule.match` (`logs.KindRuleMatch`) | 05–07 | info | Request, Provider | `rule`, `outcome`, `action`, `attempt` (seq), `upstream_key`, `model`, `status`, `reason` |
| `key.state` (`logs.KindKeyState`) | 05 | warn into invalid or cooling, info otherwise | Provider; Request when one caused it | `upstream_key`, `from`, `state`, `model` (pair cooling), `until`, `reason` |
| `model_gap` (`logs.KindModelGap`) | 08, 10 | info | Provider; Request when one caused it | `op` (created, cleared, expired), `upstream_key`, `model`, `reason`, `until` |
| `discovery` (`logs.KindDiscovery`) | 10, 20 | info, warn on failure | Provider | `endpoint`, `upstream_key`, `outcome`, `found`, `added`, `removed`, `error` |
| `job.run` (`logs.KindJobRun`) | `jobs.Runner` only | info, error on failure | Provider when `Outcome.Provider` is set | `job`, `trigger`, `dry_run`, `outcome`, `duration_ms`, `summary`, the job's details |
| `key.test` (`gateway.KindKeyTest`) | gateway (05) | info | Provider | `upstream_key`, `endpoint`, `model`, `passed`, `status`, `rule`, `reason` |
| `config.change` | `audit` | info | none | `audit_entry`, `action`, `actor`, `summary` |
| `request.interrupted` | `requests.Recover` | warn | Request, Provider | none |
| `startup`, `shutdown`, `migration` | server | info (`shutdown` warn when the drain limit ran out) | none | see `server.go`; `shutdown` has `drained` and, when the limit ran out, `requests_ended` |

Name Upstream Keys by `upstream_key` (their name, never the secret) and models by `model`. Declare any other kind next to the code that emits it, at package level:

```go
var KindKeyCooling = logs.NewKind("key.cooling", "An Upstream Key entered Cooling; says until when and why.")

log.Info("key cooling", logs.Kind(KindKeyCooling), logs.Provider(handle), logs.Request(reqID), "until", until)
```

`kind`, `request_id` and `provider` are lifted into indexed columns and filterable on `GET /api/logs`; other attributes land in `attrs`. Kinds are listed in `/skill.md` automatically. Event times come from the injected clock.

## Write a test

Tests go through HTTP only (spec "Testing Decisions"). Table tests are for deep pure modules (planner, rules, metadata).

```go
func TestSomething(t *testing.T) {
    srv := testkit.Start(t)                    // temp SQLite, fake clock at testkit.Epoch, real HTTP
    up := testkit.NewOpenAIChat(t)             // or NewOpenAIResponses / NewAnthropic / NewGemini
    up.Enqueue(up.Error(429, "slow down").Header("Retry-After", "30"), up.Text("hi"))

    srv.Admin.Post("/api/providers", body).Expect(201)        // Admin = bootstrap Admin Token
    caller := srv.Client(gatewayKeySecret)                     // Bearer; srv.Anon.WithHeader("x-api-key", k) for others
    resp := caller.Post("/providers/acme/v1/chat/completions", req).OK()
    resp.JSON(&out); resp.Events()                             // SSE parsed; srv.Anon has no credentials

    got := up.Last()   // Method, Path, Header, Body, Model, Stream; got.Bearer(); got.Map(t)
    srv.Clock.Advance(61 * time.Second)                        // cooling, gaps, budgets
    events := srv.Logs("kind=key.*&since=5m")
    srv.SettleJobs()                                           // let runs the clock triggered finish
    srv.Restart()                                              // same data dir and clock
}
```

Fake upstream replies: `up.Text` (streams automatically when the request asks; OpenAI Chat includes usage only with `stream_options.include_usage`), `up.Stream(pieces...)`, `up.Error` / `up.ErrorCode` (the Shape's error envelope), `up.SetModels`, `up.SetUsage`, `up.Handle(method, path, r)` for other routes, generic `testkit.JSON`, `Raw`, `SSE`, `Hang`, `Drop`, and modifiers `.Header`, `.After(d)`, `.HoldUntil(ch)` (with `up.Await(n)` to know the request arrived), `.ThenDisconnect()`. For finer control build a `testkit.Reply` with `Chunks` (each may `Delay` or `Wait`). `up.URL()` is the Endpoint URL including `/v1` (or `/v1beta` for Gemini). To give an Endpoint a real Provider host (built-in Failure Rules match on it), start with `testkit.Start(t, testkit.Options{HTTPClient: up.Client()})` and use `up.URLAt("dashscope-intl.aliyuncs.com")`: every outbound call reaches the fake whatever its host (`internal/gateway/quirks_test.go`). Use `srv.Clock.BlockUntil(ctx, n)` before `Advance` when the server must be waiting on a timer first. `srv.App.DB()` exists only for state no API can reach yet; prefer the API.

`srv.OwnerSession()` sets the Owner password (`testkit.OwnerPassword`) if needed, signs in like the UI, and returns a client sending the session cookie; its changes are audited as the Owner. `client.WithCookie(c)` and `resp.Cookie(name)` handle other cookies.

To test behaviour that needs a route production lacks (a deliberately slow handler, say), pass it in `server.Options.Routes` and drive `server.Run` directly; `internal/server/drain_test.go` does this to prove the SIGTERM drain.

`go build ./... && go vet ./... && go test ./...` must pass. `go test -short` skips the binary build test in `cmd/iroha`.

## Frontend

React 19 + TypeScript + Vite in `web/`, Tailwind CSS 4, React Router (declarative `<Routes>`), TanStack Query for server state, Radix for dialogs and menus, Sonner for toasts, lucide-react icons, Inter bundled (no third-party requests). The design to build is `.scratch/v2-gateway/design/v2-clean/`; `/states` in the running UI shows every shared component in every state (C25).

### Build and embed

- `npm --prefix web ci && npm --prefix web run build` type-checks and writes the bundle to `internal/webui/dist/`, which `go:embed` puts in the binary on the next `go build`. Only `internal/webui/dist/.gitkeep` is committed, so a fresh clone builds and tests with Go alone; that binary serves a page saying the UI was not built, and `GET /healthz` reports `"ui": false`.
- **Release builds** must run those two npm commands before the `go build` in `deploy/deploy.sh`, and should refuse to switch over when `/readyz` on the new binary says `"ui": false`. Node 22+ is needed on the build machine only. (Not wired into `deploy/deploy.sh` yet: ticket 21 left ticket 03's files alone.)
- Development: run Iroha (`go run ./cmd/iroha --addr 127.0.0.1:8080`), then `npm --prefix web run dev`; Vite proxies `/api`, `/brand`, `/readyz`, `/healthz` and `/skill.md` to `IROHA_URL` (default `http://127.0.0.1:8080`).
- If the ticket touches `web/`, `npm --prefix web run build` must pass (it runs `tsc` first). There are no DOM unit tests (spec); behaviour lives behind the API and is tested in Go.

### Layout of `web/src`

| Path | Owns |
|---|---|
| `app/` | The shell: `App.tsx` (providers and the route table, one line per page), `AuthGate` (setup, login, or the app), `Shell` (sidebar, phone tab bar, chat slot), `nav.ts` (items and shortcuts P, G, R, C), `shortcuts.ts`, `health.ts` (polls `/readyz`), `theme.tsx`, `chat-panel.tsx`, `PageHeader`, `brand.tsx`. |
| `api/` | `client.ts` (the only `fetch`: JSON, 10 s timeout, `ApiError` with `code`, `hint` and `call`, signed-out detection), `types.ts` (shared shapes: `AuditResult`, `BulkResult`, `AuditEntry`...), `session.ts`, `audit.ts` (`revertEntry`). Add `api/<resource>.ts` for types and hooks other pages also need; otherwise keep them in your page folder. |
| `ui/` | Shared components, no data fetching: `Button`/`IconButton`/`buttonClass`, `Input`/`PasswordInput`/`SearchInput`/`Field`, `Table` primitives and `TableSkeleton`, `Dialog`/`ConfirmDialog`/`TypeToConfirmDialog`, `Menu`, `toast` (`notify`, `notifyChange` with Undo), `LogoTile`, `States` (`EmptyState`, `NoResults`, `Chip`, `ErrorState`), `bits` (`StatusDot`, `Status`, `Kbd`, `Tabs`, `Mono`). |
| `lib/` | `format.ts` (numbers, percents, durations, "4 min ago"), `media.ts` (`useIsPhone`). |
| `pages/<page>/` | One folder per page, owned by its ticket: `providers` (22), `chat` (23), `gateway-keys` (24), `requests` (25), `settings` (28), plus `login`, `states`, `not-found`. Each `index.tsx` default-exports the page, mounted at `/<page>/*`; sub-pages go in a `<Routes>` inside the folder, so parallel tickets never edit the same file. |
| `styles/index.css` | Design tokens (light and dark values of each colour) mapped to Tailwind colours: `bg-bg`, `bg-subtle`, `bg-muted`, `bg-elevated`, `text-fg`, `text-fg-muted`, `text-fg-subtle`, `border-border`, `border-border-strong`, `bg-primary`/`text-primary-fg`, `bg-danger`/`text-danger-text`/`bg-danger-tint`, `success`, `warning`, `info`, `bg-selected`. Never hard-code a colour. |

### Conventions

- UI addresses share the path space with the Gateway (`/providers/{handle}/v1/...`): registered routes always win, and the UI only gets GETs no route matched. Keep UI paths free of `v1`/`v1beta` segments (`/providers/acme/keys`, never `/providers/acme/v1`).
- Only the public admin API: `api.get/post/put/patch/delete` from `@/api/client`, cached with TanStack Query (`useQuery`, `useMutation`). A 401 that means the session ended brings the login back automatically.
- Loading shows `TableSkeleton` (no spinners), empty shows `EmptyState` with the one action, filtered-to-nothing shows `NoResults` with chips, failure shows `ErrorState` with Try again, inside the page (C25).
- Confirm only deletes (`ConfirmDialog`, naming what goes) and revokes (`TypeToConfirmDialog`). Everything else acts at once and toasts `notifyChange(message, result)`, which offers Undo through `POST /api/audit-entries/{id}/revert`.
- One primary button per page; status colour only from `StatusDot`; one fact per cell. Logos via `LogoTile` with a URL served by Iroha (round for Providers, square for Pools, first-letter fallback).
- Chat: call `useChatPanel().open(target)` from Test buttons; ticket 23 renders the content in `pages/chat/ChatPanel.tsx` and reads `request`.
- Requests (`pages/requests`, ticket 25): the feed's filters, time range, hidden columns and open Request live in the URL (`/requests?caller=linh&status=failed&range=24h&hide=key,shape&request=req_...`), so other pages can link to a filtered feed or one Request; `/requests/<id>/route` (and `/details`, `/captured`) is the full-page Route view. Live updates poll `changed_after` every 2 s (`useRequestFeed` in `pages/requests/api.ts`). What a failed Attempt means (Failure Rule, Key State effect, the pill on the Route view's lines) is derived in one place, `pages/requests/attempt-info.ts`. Provider logos come from `providerLogo()` in `pages/requests/bits.tsx` (letter tiles until ticket 22 serves logos). Replay opens `useChatPanel().open({ kind: "request", request: id })`.
- Settings (`pages/settings`, ticket 28) has three tabs, each a route: Admin Tokens, Audit Entries and Sign-in (Owner password and signed-in browsers). Audit Entry filters live in the URL (`/settings/audit-entries?actor=Owner&resource=admin_token&q=...`), so other pages can link to a filtered history.
- Checking pages in a headless browser: `iroha-v2-notes/ui-screenshots/` (outside the repo) has a seed test template (testkit with a fake clock near real time) and a Chrome-over-CDP screenshot script.
- Phones (< 768 px): bottom tab bar, `PageHeader` shows the avatar linking to Settings; design tables as two-line rows there (C31, C32). Inputs use 16 px text on phones so focusing does not zoom.
