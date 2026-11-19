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
| `internal/admintokens` | Admin Token storage, the admin authenticator, the bootstrap token. Ticket 02 adds its routes here. |
| `internal/ids` | Record IDs (`at_xxxx`) and secrets. |
| `internal/shape` | The four Shape names. |
| `internal/testkit` | In-process server, clients, fake upstreams. |
| `deploy` | `deploy.sh` (run locally: build, copy, back up, swap, restart, readiness, rollback over SSH keys), `remote.sh` (its server half), `iroha.service` (systemd unit template), Go tests tying the unit's stop timeout to the drain limit and the runbook (`internal/api/skill/50_deploy.md`) to the script. `deploy/test/e2e.sh` runs the scripts against a local Docker container with systemd and sshd; run it after changing anything in `deploy/` (needs Docker; never point it at a real server). |

Suggested homes for later work (create when needed, one package per concern so parallel tickets do not collide): `audit` (02), `providers` (Providers, Endpoints, Upstream Keys; 04, 09), `gatewaykeys` (04, 12), `requests` (Request and Attempt history; 04), `gateway` (inference routes, passthrough, streaming; 04, 13–17), `planner` (candidate planning, pure; 05, 09, 18), `rules` (Failure Rules, pure matching; 05–07), `keystate` (Key States, Cooling, Model Gaps; 05, 08), `models` (lists, discovery, metadata; 10, 11), `pools` (18), `translate` and `normalise` (13–16), `jobs` (19, 20), `session` (Owner login; 21). The UI goes in `web/` (21), deploy files in `deploy/` (03).

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

   `Auth` defaults to `api.AuthAdmin` (Admin Token or, later, Owner session); `c.Actor` says who called. Use `api.AuthPublic` for health/login, `api.AuthCaller` for Gateway routes (the handler checks the Gateway Key). Use `Raw` instead of `Handle` for streams and non-JSON bodies. Decode bodies with `c.Decode(&v)` (rejects unknown fields). Use `c.SetStatus(201)` to change the success status. A second authenticator (Owner session, ticket 21) is passed to `api.NewRouter` in `server.New`.
2. Add one line to `internal/server/routes.go`.
3. Done: the route is served and appears in `/api/openapi.json` (schemas reflected from `Request`/`Response`; struct tags `json`, `doc:"..."`, `enum:"a,b"`) and in `/skill.md`. `TestDocumentsDescribeEveryRegisteredRoute` fails if anything drifts. Hand-written guidance for agents goes in a new file `internal/api/skill/NN_topic.md` (files are concatenated in name order before the generated route reference).

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
    caller := srv.Client("sk-iroha-...")                       // Bearer; .WithHeader("x-api-key", k) for others
    resp := caller.Post("/providers/acme/v1/chat/completions", req).OK()
    resp.JSON(&out); resp.Events()                             // SSE parsed; srv.Anon has no credentials

    got := up.Last()   // Method, Path, Header, Body, Model, Stream; got.Bearer(); got.Map(t)
    srv.Clock.Advance(61 * time.Second)                        // cooling, gaps, budgets
    events := srv.Logs("kind=key.*&since=5m")
    srv.Restart()                                              // same data dir and clock
}
```

Fake upstream replies: `up.Text` (streams automatically when the request asks; OpenAI Chat includes usage only with `stream_options.include_usage`), `up.Stream(pieces...)`, `up.Error` / `up.ErrorCode` (the Shape's error envelope), `up.SetModels`, `up.SetUsage`, `up.Handle(method, path, r)` for other routes, generic `testkit.JSON`, `Raw`, `SSE`, `Hang`, `Drop`, and modifiers `.Header`, `.After(d)`, `.HoldUntil(ch)` (with `up.Await(n)` to know the request arrived), `.ThenDisconnect()`. For finer control build a `testkit.Reply` with `Chunks` (each may `Delay` or `Wait`). `up.URL()` is the Endpoint URL including `/v1` (or `/v1beta` for Gemini). Use `srv.Clock.BlockUntil(ctx, n)` before `Advance` when the server must be waiting on a timer first. `srv.App.DB()` exists only for state no API can reach yet; prefer the API.

To test behaviour that needs a route production lacks (a deliberately slow handler, say), pass it in `server.Options.Routes` and drive `server.Run` directly; `internal/server/drain_test.go` does this to prove the SIGTERM drain.

`go build ./... && go vet ./... && go test ./...` must pass. `go test -short` skips the binary build test in `cmd/iroha`.
