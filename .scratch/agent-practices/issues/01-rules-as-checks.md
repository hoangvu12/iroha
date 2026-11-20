# 01: Rules as checks

Status: done
Blocked by: none

## Why

`docs/agents/architecture.md` "Rules everyone follows" and the package map state rules in prose ("never call `time.Now`", "`internal/translate` is the only importer of RelayKit", "stdlib `net/http` only", pure packages, `hosts.Of` as the one way to read an Endpoint's host). Agents copy what the code does, not what a doc says; a rule nothing checks drifts. pstack's lesson: encode each repeated correction in structure, with an error message that says what to do instead (`docs/research/pstack-agent-practices.md`, item 1).

## What

- A test-only package (suggested `internal/archtest`) that loads the module's non-test Go files with `go/parser` (or `golang.org/x/tools/go/packages` only if already a dependency; prefer stdlib) and checks rules. Each failure names the file:line, the rule, and the fix (e.g. "use clock.Clock's Now / clock.WithTimeout; see architecture.md, Time").
- Go through "Rules everyone follows" and the package map, and encode every rule a program can check reliably. At least:
  - **Time**: no `time.Now`, `time.Since`, `time.Until`, `time.After`, `time.AfterFunc`, `time.NewTimer`, `time.NewTicker`, `time.Tick`, `time.Sleep`, `context.WithTimeout`, `context.WithDeadline` outside `internal/clock` and `internal/testkit` (and `cmd/` if justified; say why). Find out first which calls exist today; an existing use that is legitimate gets an explicit, commented allow-list entry, not a weakened rule.
  - **Imports**: RelayKit imported only by `internal/translate`; no third-party HTTP router or web framework; the driver `modernc.org/sqlite` only where the store opens it; pure packages named as pure in the package map (`rules`, `planner`, `affinity`, `caching`, `normalise`, `modelmeta`, others it lists) import no `internal/store`, `database/sql` or `net/http` server code (check what "pure" means for each in the map; `net/http` types like `http.Header` may be fine).
  - **Errors** from handlers being `*api.Error`, **secrets never logged**, **JSON snake_case**: encode only if a reliable static check exists (e.g. every `json:"..."` tag in non-test code is snake_case). Skip the rest and say why in the ticket's Comments.
- Then edit "Rules everyone follows": each rule now checked says so in a few words and names the test; drop wording the test makes redundant. Keep rules that need judgement.
- Verify each check catches what it should: for each rule, temporarily introduce a violation, see the test fail with the intended message, remove it. Record that in Comments (no violating code committed).

## Done when

`go vet ./...` and `go test ./...` pass. `## Comments` here lists the rules encoded, the allow-list entries and why, the rules skipped and why, and how each check was seen failing. Commit on your branch; don't merge, push or deploy.

## Comments

### Done (agent-practices-01)

`internal/archtest` (tests only, plus a `doc.go`): parses every non-test `.go` file of the module with `go/parser` (skipping `web/`, `docs/`, `testdata`, hidden dirs; build tags are not read, so an `//go:build ignore` file is checked too) and the migrations. Each failure prints `file:line: rule` then `fix: ...`. "Rules everyone follows" in `architecture.md` now marks each checked rule and names its test; the package map has an `internal/archtest` row.

**Rules encoded**

| Test | Rule |
|---|---|
| `TestTimeComesFromTheInjectedClock` | No `time.Now/Since/Until/After/AfterFunc/NewTimer/NewTicker/Tick/Sleep`, `context.WithTimeout/WithDeadline` (and the `*Cause` forms) outside `internal/clock` and `internal/testkit`; each message names the `clock` replacement. |
| `TestImportsStayInTheirPackages` | A module outside the standard library needs an entry in `thirdParty`: RelayKit only in `internal/translate`, `modernc.org/sqlite` only in `internal/store` and `internal/v1import`. Anything else fails with "stdlib net/http only (no router or web framework)". This is an allow-list instead of a list of known routers, so it also catches routers nobody thought to list. |
| `TestPurePackagesStayPure` | `rules`, `planner`, `affinity`, `caching`, `normalise` (strict), and every module package they import, don't import `database/sql`, sqlite, `internal/store`, `internal/api`, `internal/server`, `internal/logs`, `internal/clock`, `log/slog` or `os`, and use no net/http server names (`Handler`, `ResponseWriter`, `Request`, `Server`, ...) and no outbound HTTP (`Client`, `NewRequest`, `Get`, ...). `http.Header`, `http.CanonicalHeaderKey` and `http.ParseTime` stay allowed. `modelmeta` (not strict): only its own imports are checked, against database, routes, server and the net/http server names. Its `Source` fetches models.dev with an injected client, clock and logger, as the package map says. |
| `TestEndpointHostsComeFromHostsOf` | No `.Hostname()` call outside `internal/hosts`; use `hosts.Of`. |
| `TestDependenciesArePassedExplicitly` | No `slog.Default/SetDefault/Info/...`, `log.Print*/Fatal*/Panic*`, `http.DefaultClient/Get/Post/PostForm/Head`, and no package-level var typed `*sql.DB`, `*store.DB`, `*slog.Logger`, `*http.Client`, `clock.Clock/Real/Fake`. `internal/testkit` is exempt. |
| `TestStoredTimesAreIntegerMillis` | In `internal/store/migrations/*.sql` (comments stripped), a column definition named `*_at` must be `INTEGER`. |
| `TestAPIJSONIsSnakeCase` | Starts a testkit server and checks the OpenAPI of every route except `AuthCaller` ones: every schema property, query parameter and path parameter is snake_case. Caller routes are left out because they speak their Shape's wire format; `gateway.GenerateContentRequest` documents Gemini's camelCase body. Checking the generated OpenAPI is reliable, while grepping `json:` tags is not: 17 camelCase tags in non-test code all mirror upstream wire formats (Gemini, usage parsing, v1 import). |

**Allow-list entries**

- Wall clock, whole packages: `internal/clock` (it is `clock.Real`) and `internal/testkit` (harness waits in real time for the server and fake upstreams, never for behaviour under test). `wallClockAllowed` is empty: no other non-test code reads the wall clock today. `cmd/` is not exempt because nothing there needs it (`cmd/iroha` leaves `server.Run` to default to `clock.Real`). **For ticket 02:** a launcher under `cmd/` that polls for readiness should use `clock.Real{}` with `clock.Sleep`/`clock.WithTimeout`, or add an entry with its reason.
- `thirdParty`: RelayKit → `internal/translate` (ADR-0004); `modernc.org/sqlite` → `internal/store` and `internal/v1import`, which opens the retired v1 database read-only to import it.
- `hostnameAllowed`: `internal/testchat/answers.go page` (a URL the model asked the test tool to fetch, not an Endpoint) and `internal/v1import/plan.go mapProvider` (a Gateway Key name hint from a v1 URL that keeps the host as v1 wrote it and compares nothing).
- Two existing uses were real violations and are now fixed instead of allowed. `failurerules.providerScope` read Endpoint hosts with `url.Parse(...).Hostname()` plus `ToLower`, which is exactly `hosts.Of`. `logos.SiteOf` now calls `NormalizeDomain(hosts.Of(raw))`, with the same results (an unreadable URL still gives "").

**Skipped, and why**

- **Errors from handlers are `*api.Error`.** Handlers rightly pass on store and I/O errors, which become 500s, so "returns a non-`*api.Error`" isn't a fault in itself. Deciding which returns should have been 4xx needs judgement, and checking the error's type needs type information (`go/types` over the whole module), which `go/parser` alone doesn't have.
- **Secrets never logged.** This is a data-flow question (does a value that came from a secret reach a log attribute?), and no reliable static check exists without taint analysis. A name-based grep would give both false hits and misses.
- **Writes go through `db.Tx`.** Telling `(*store.DB).ExecContext` apart from `(*sql.Tx).ExecContext` needs types. Left as prose.
- **Stored times named `*_at`:** only the column type is checked. Whether an INTEGER column without `_at` holds a time is judgement.
- **JSON times are RFC 3339:** `time.Time` already marshals that way. An int-millis field in a response would need judgement to spot.
- `testchat` ("pure apart from routes") and `usage`/`hosts`/`shape` aren't in the pure set: the map doesn't call the latter pure, and `testchat` imports `store`, `models`, `requests` and `api` for its routes.

**How each check was seen failing.** For each rule I added a violation temporarily, ran `go test ./internal/archtest`, saw the intended message, and removed it. No violating code is committed. Files that wouldn't compile used `//go:build ignore`, which the loader still parses.

- Time: `internal/gateway/zz_violation.go` with `time.Now()`, `time.Sleep`, `context.WithTimeout` → three failures, e.g. `zz_violation.go:20: time.Now reads the wall clock ... fix: use c.Now() with the injected clock.Clock`.
- Imports: same file importing `relaykit/dto` and `github.com/go-chi/chi/v5` → "imports ... outside internal/translate" and "a module outside the standard library nothing has agreed to ... stdlib net/http only".
- Pure: `internal/rules` file importing `internal/store` and using `http.ResponseWriter`/`http.Request`; `internal/hosts` file importing `log/slog` (caught transitively: "reached from internal/caching -> internal/hosts", reported once); `internal/planner` using `http.DefaultClient`; `internal/modelmeta` importing `internal/api` and using `http.Handler` (flagged), while a `http.Client` var there was not flagged as impure (as intended).
- Hosts: `u.Hostname()` in gateway → flagged. Before the fixes, the check also flagged the real uses in failurerules and logos. A wrong allow-list key for v1import (`plan`) failed until it was corrected to `mapProvider`, which showed the allow-list works.
- Dependencies: `slog.Info`, `http.Get`, `var globalDB *store.DB`, a `var _ http.Client` in modelmeta → four failures.
- Stored times: `99_99_zz_violation.sql` with `seen_at TEXT` and `ADD COLUMN gone_at DATETIME` → two failures with line numbers.
- JSON: `FooBar string json:"fooBar,omitempty"` on `admintokens.Token` → `openapi /components/schemas/Token: field "fooBar" is not snake_case`. A query parameter `sinceWhen` on `GET /api/logs` → `query parameter "sinceWhen" is not snake_case`.

After removal, `go build ./...`, `go vet ./...` and `go test ./...` pass.
