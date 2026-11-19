# 01: Walking skeleton: binary, SQLite, Admin Token, logs, served skill

**What to build:** A Go binary that starts on a SQLite file beside it, runs its migrations, serves liveness and readiness endpoints, and on first start prints a bootstrap Admin Token. An agent holding that token can call an authenticated admin route, read `GET /skill.md` and `GET /api/openapi.json` (both minimal but generated from the real route definitions), and read structured startup log events through the logs API. Includes the in-process HTTP test harness (temporary SQLite, injectable clock, programmable fake upstream servers) that every later ticket uses.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Binary starts with only a data directory; migrations apply on start
- [x] Liveness and readiness routes answer
- [x] First start creates a named Admin Token and prints it once; later starts do not
- [x] Admin routes refuse missing or revoked tokens with a hinting error
- [x] `/skill.md` and `/api/openapi.json` are served and cannot drift from the routes
- [x] Startup and shutdown are logged as structured events, readable via the logs API with time and level filters
- [x] Test harness: server in-process, fake upstreams per Shape, controllable clock

## Comments

Built the foundation described in `docs/agents/architecture.md` (read it first): `cmd/iroha`, `internal/{config,server,api,store,logs,clock,admintokens,ids,shape,testkit}`.

- Routes: one `[]api.Route` table; the Router registers handlers and generates `/api/openapi.json` (OpenAPI 3.1, schemas reflected from Go types) and `/skill.md` (hand-written `internal/api/skill/*.md` + log kinds + generated route reference). `TestDocumentsDescribeEveryRegisteredRoute` checks both against the registered routes. Both documents and `/healthz`, `/readyz` are public; `GET /api/whoami` and `GET /api/logs` need an Admin Token. Unknown `/api/` paths and wrong methods answer JSON 404/405 with hints.
- Migrations: `internal/store/migrations/<ticket>_<seq>_<slug>.sql`, applied in numeric order, tracked by name, so parallel tickets never collide and late merges still apply.
- Bootstrap Admin Token `bootstrap` is created once per installation (remembered in `meta`, so it is not re-issued even after revocation) and printed to the console only; never logged.
- Logs: slog to stdout (JSON or text) and the `log_events` table via a batched writer; `GET /api/logs` filters by since/until (RFC 3339 or a duration), minimum level, kind (exact or `prefix*`), `request_id`, `provider`, with `before` paging. Kinds are registered per package with `logs.NewKind`.
- Harness: `testkit.Start(t)` runs the real server on a temp SQLite with `clock.Fake`; `Admin`/`Anon`/`Client(token)` clients; `Restart`; `Logs(query)`; fake upstreams for all four Shapes with realistic bodies, streams, error envelopes, model lists, queued replies, holds, delays and disconnects, recording what they received.
- Deferred: Admin Token management routes (create/list/revoke over HTTP) are ticket 02; the revoked-token test revokes through `admintokens.Store` until then. The "drains in-flight requests" behaviour is wired (`http.Server.Shutdown` with `--drain-timeout`) but its tests belong to tickets 03/17.
