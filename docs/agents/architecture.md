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
| `internal/session` | The Owner password (PBKDF2), 30-day browser sessions (`iroha_session` cookie, SameSite=Strict, secrets stored as SHA-256), the session authenticator (actor kind `owner_session`, name `Owner`), `/api/session`, `/api/owner-password`, `/api/owner-sessions`. |
| `internal/webui` | Serves the embedded UI: `dist/` (Vite output, built from `web/`) and `brand/` (Iroha art, committed). Unknown page loads get `index.html`; other misses the JSON 404. |
| `internal/ids` | Record IDs (`at_xxxx`) and secrets. |
| `internal/shape` | The four Shape names. |
| `internal/testkit` | In-process server, clients, fake upstreams. |

Suggested homes for later work (create when needed, one package per concern so parallel tickets do not collide): `providers` (Providers, Endpoints, Upstream Keys; 04, 09), `gatewaykeys` (04, 12), `requests` (Request and Attempt history; 04), `gateway` (inference routes, passthrough, streaming; 04, 13–17), `planner` (candidate planning, pure; 05, 09, 18), `rules` (Failure Rules, pure matching; 05–07), `keystate` (Key States, Cooling, Model Gaps; 05, 08), `models` (lists, discovery, metadata; 10, 11), `pools` (18), `translate` and `normalise` (13–16), `jobs` (19, 20). The UI is in `web/` (see "Frontend"), deploy files in `deploy/` (03).

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

`srv.OwnerSession()` sets the Owner password (`testkit.OwnerPassword`) if needed, signs in like the UI, and returns a client sending the session cookie; its changes are audited as the Owner. `client.WithCookie(c)` and `resp.Cookie(name)` handle other cookies.

`go build ./... && go vet ./... && go test ./...` must pass. `go test -short` skips the binary build test in `cmd/iroha`.

## Frontend

React 19 + TypeScript + Vite in `web/`, Tailwind CSS 4, React Router (declarative `<Routes>`), TanStack Query for server state, Radix for dialogs and menus, Sonner for toasts, lucide-react icons, Inter bundled (no third-party requests). The design to build is `.scratch/v2-gateway/design/v2-clean/`; `/states` in the running UI shows every shared component in every state (C25).

### Build and embed

- `npm --prefix web ci && npm --prefix web run build` type-checks and writes the bundle to `internal/webui/dist/`, which `go:embed` puts in the binary on the next `go build`. Only `internal/webui/dist/.gitkeep` is committed, so a fresh clone builds and tests with Go alone; that binary serves a page saying the UI was not built, and `GET /healthz` reports `"ui": false`.
- **Release builds** (deploy script, ticket 03) must run those two npm commands before `GOOS=linux GOARCH=amd64 go build ./cmd/iroha`, and should refuse to ship when `/healthz` on the new binary says `"ui": false`. Node 22+ is needed on the build machine only.
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

- Only the public admin API: `api.get/post/put/patch/delete` from `@/api/client`, cached with TanStack Query (`useQuery`, `useMutation`). A 401 that means the session ended brings the login back automatically.
- Loading shows `TableSkeleton` (no spinners), empty shows `EmptyState` with the one action, filtered-to-nothing shows `NoResults` with chips, failure shows `ErrorState` with Try again, inside the page (C25).
- Confirm only deletes (`ConfirmDialog`, naming what goes) and revokes (`TypeToConfirmDialog`). Everything else acts at once and toasts `notifyChange(message, result)`, which offers Undo through `POST /api/audit-entries/{id}/revert`.
- One primary button per page; status colour only from `StatusDot`; one fact per cell. Logos via `LogoTile` with a URL served by Iroha (round for Providers, square for Pools, first-letter fallback).
- Chat: call `useChatPanel().open(target)` from Test buttons; ticket 23 renders the content in `pages/chat/ChatPanel.tsx` and reads `request`.
- Phones (< 768 px): bottom tab bar, `PageHeader` shows the avatar linking to Settings; design tables as two-line rows there (C31, C32). Inputs use 16 px text on phones so focusing does not zoom.
