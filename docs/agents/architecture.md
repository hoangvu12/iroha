# Architecture (read first)

One Go binary (`cmd/iroha`), one SQLite file (`<data-dir>/iroha.db`), pure-Go driver `modernc.org/sqlite` (no CGO, so `GOOS=linux go build ./cmd/iroha` works from Windows). Stdlib `net/http` only. Module path `github.com/hoangvu12/iroha`.

## Package map

| Package | Owns |
|---|---|
| `cmd/iroha` | `main`: flags, signals, `server.Run`. Nothing else. |
| `internal/config` | Startup flags and `IROHA_*` env (`--data-dir`, `--addr`, `--log-level`, `--log-format`, `--drain-timeout`). Runtime settings live in the database, not here. |
| `internal/server` | Wiring: open store, migrate, logs, bootstrap token, route table (`routes.go`, one line per module), serve, drain. Health routes. Keep thin. |
| `internal/api` | Route table type, Router (auth, JSON, error envelope, 404/405), OpenAPI and `/skill.md` generation, skill text in `internal/api/skill/*.md`. |
| `internal/store` | `Open`, `Tx`, `Migrate`, time helpers; every migration in `internal/store/migrations/`. Feature packages write their own SQL against `*store.DB`. |
| `internal/logs` | slog handler (console + `log_events`), event kinds, `GET /api/logs`. |
| `internal/clock` | `Clock` interface, `Real`, `Fake`, `WithTimeout`, `Sleep`. |
| `internal/audit` | The conventions every admin resource shares: name-or-ID `Resolve`, audited `Mutate` with `dry_run`, `Bulk` with per-item results, Audit Entries (`/api/audit-entries`) and revert. See "Add an admin resource". |
| `internal/admintokens` | Admin Token storage, the admin authenticator, the bootstrap token, `/api/admin-tokens` (the reference resource for the audit conventions). |
| `internal/ids` | Record IDs (`at_xxxx`) and secrets. |
| `internal/shape` | The four Shape names. |
| `internal/testkit` | In-process server, clients, fake upstreams. |
| `internal/providers` | Providers, Endpoints, Upstream Keys: tables, audited admin routes (`/api/providers`, `.../{provider}/endpoints`, `.../{provider}/keys`), and `Store.Routing(handle)`, the routing view the Gateway plans over. |
| `internal/gatewaykeys` | Gateway Keys and their scope: `/api/gateway-keys`, `Store.Authenticate(r)` (Bearer, `x-api-key`, `api-key`) returning a `Caller` with `AllowsProvider` / `AllowsModel`. |
| `internal/planner` | Candidate planning, pure: `Plan(Request, []Provider, Rotation)` gives the ordered (Provider, Endpoint, key, wire model) list or why there is none. `Counter` is live round-robin, `Fixed` is for previews. Table-tested. |
| `internal/gateway` | Inference routes. Orchestrates one Request across the seams below; owns Attempt execution (outbound request, header filtering, passthrough relay buffered or streamed, model echo) and the Caller-facing error envelope. |
| `internal/requests` | Request and Attempt history: `Recorder` (Begin, Attempt, Finish) and `/api/requests`. |
| `internal/usage` | Token usage parsing per Shape (OpenAI Chat today), for bodies and stream events. |

Suggested homes for later work (create when needed, one package per concern so parallel tickets do not collide): `rules` (Failure Rules, pure matching; 05–07), `keystate` (Key States, Cooling, Model Gaps; 05, 08), `models` (lists, discovery, metadata; 10, 11), `pools` (18), `translate` and `normalise` (13–16), `jobs` (19, 20), `session` (Owner login; 21). The UI goes in `web/` (21), deploy files in `deploy/` (03).

## The inference path

One Request runs through four seams, in this order. Change the seam that owns a behaviour; keep `internal/gateway` an orchestrator.

| Step | Owner | Today (04) | Who extends it |
|---|---|---|---|
| 1. Caller auth and scope | `gatewaykeys.Store.Authenticate`, `Caller.AllowsProvider/AllowsModel` | Gateway Key from Bearer, `x-api-key`, `api-key`; scope `all` or Providers each optionally narrowed to models. Unknown, disabled, archived and out-of-scope Providers get one 403 `provider_not_allowed`. | 12 (global routes, `/v1/models`), 15 (`x-goog-api-key`, `key=`), 18 (Pools in scope), 23 (Test caller) |
| 2. Candidate planning | `planner.Plan` over `providers.Store.Routing` | Endpoints of the Caller's Shape only; keys round-robin (`Counter` per Provider ID), each key on every such Endpoint; renames applied per Endpoint. Empty plan says why (`no_endpoint`, `no_upstream_key`). | 05 (exclude invalid/cooling keys, "cooling until T"), 08 (Model Gaps), 09 (key-to-Endpoint restrictions), 10 (carriers first), 13 (other-Shape Endpoints after same-Shape), 18 (Pool members) |
| 3. Attempt execution | `gateway/attempt.go` | One Attempt: `outbound` builds URL + op path, forwards Caller headers except credentials/hop-by-hop/`x-forwarded-*`/`cf-*`/`iroha-*`, applies static headers then bearer auth (empty secret = no header). Redirects are never followed. `relayStream` forwards SSE event by event with flush; `relayBuffered` otherwise. `chatRelay` echoes the requested model, reads usage, drops the usage chunk Iroha injected. | 05 (budget loop + Failure Rules decide retry), 09 (auth styles in `outbound`), 13–16 (translate/normalise between relay and Caller), 17 (keep-alives, error events after commit) |
| 4. Recording | `requests.Recorder`, log kinds `request` and `attempt` | Request inserted `in_progress` once the Caller is known (401s are not recorded), one row per Attempt, completed with status, error code, serving Provider/Endpoint/key/wire model, Shapes, first byte, duration, usage. Writes ignore the Caller's cancellation. | 05 (matched rule, action, failure body and headers on Attempts), 19 (capture, retention), 25 (stats) |

Body edits are byte-preserving: `gateway/jsonedit.go` (`setField`, `field`, `echoModel`) replaces one top-level value in place, so passthrough never re-serialises a body. Streams of OpenAI Chat get `stream_options.include_usage` added when the Caller did not ask, so usage is recorded for every stream.

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

   `Auth` defaults to `api.AuthAdmin` (Admin Token or, later, Owner session); `c.Actor` says who called. Use `api.AuthPublic` for health/login, `api.AuthCaller` for Gateway routes (the handler checks the Gateway Key). Use `Raw` instead of `Handle` for streams and non-JSON bodies. Decode bodies with `c.Decode(&v)` (rejects unknown fields). Use `c.SetStatus(201)` to change the success status. A second authenticator (Owner session, ticket 21) is passed to `api.NewRouter` in `server.New`. A route that changes configuration must also follow "Add an admin resource" below.
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

## Add a log event kind

Declare it next to the code that emits it, at package level:

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
    srv.Restart()                                              // same data dir and clock
}
```

Fake upstream replies: `up.Text` (streams automatically when the request asks; OpenAI Chat includes usage only with `stream_options.include_usage`), `up.Stream(pieces...)`, `up.Error` / `up.ErrorCode` (the Shape's error envelope), `up.SetModels`, `up.SetUsage`, `up.Handle(method, path, r)` for other routes, generic `testkit.JSON`, `Raw`, `SSE`, `Hang`, `Drop`, and modifiers `.Header`, `.After(d)`, `.HoldUntil(ch)` (with `up.Await(n)` to know the request arrived), `.ThenDisconnect()`. For finer control build a `testkit.Reply` with `Chunks` (each may `Delay` or `Wait`). `up.URL()` is the Endpoint URL including `/v1` (or `/v1beta` for Gemini). Use `srv.Clock.BlockUntil(ctx, n)` before `Advance` when the server must be waiting on a timer first. `srv.App.DB()` exists only for state no API can reach yet; prefer the API.

`go build ./... && go vet ./... && go test ./...` must pass. `go test -short` skips the binary build test in `cmd/iroha`.
