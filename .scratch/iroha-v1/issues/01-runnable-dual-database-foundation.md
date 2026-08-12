# 01 — Runnable dual-database application foundation

**What to build:** A runnable Bun application that serves an Elysia backend and fresh React/Vite/shadcn management shell, validates deployment configuration, selects SQLite or PostgreSQL, migrates before accepting traffic, and reports liveness/readiness.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Bun development, build, start, test, and migration-generation commands work without deployment-specific packaging.
- [x] The backend serves the built frontend and typed HTTP routes from one process.
- [x] The UI starts from a fresh shadcn initialization and establishes the agreed nyanis-inspired tokens, Geist typography, and responsive app shell.
- [x] Startup requires `DATABASE_URL` and `IROHA_MASTER_KEY`, recognizes only supported SQLite/PostgreSQL schemes, and reports all configuration errors together without exposing values.
- [x] SQLite and PostgreSQL use separate Drizzle schema/migration tracks behind one repository boundary.
- [x] Pending migrations complete before the server listens; migration failure stops startup.
- [x] Liveness and readiness endpoints distinguish a running process from a migrated, traffic-ready application.
- [ ] Automated tests exercise startup and repository behavior against both supported database engines.

## Comments

### Repository conformance is written for both engines but has only run against SQLite

`test/persistence/repository-conformance.test.ts` is one suite parameterised by
engine, and `test/persistence/engines.ts` supplies both. PostgreSQL runs when
`IROHA_TEST_POSTGRES_URL` names a disposable database; otherwise its cases are
skipped with a warning rather than silently reported as passing.

No PostgreSQL server, `psql`, or Docker was available in the environment this
ticket was implemented in, so the PostgreSQL half has never executed. The
PostgreSQL repository and migration track are therefore unverified. The last
box stays unchecked until the suite runs green against a real server:

```sh
IROHA_TEST_POSTGRES_URL=postgres://iroha:iroha@localhost:5432/iroha_test bun test
```

The suite drops and recreates the `public` schema on that database, so it must
not point at anything an Owner cares about.

### What was built

- `src/config/` — configuration parsing that aggregates every problem and never
  echoes a secret. An unsupported `DATABASE_URL` is reported by scheme alone.
- `src/persistence/` — one `Database` contract with separate SQLite and
  PostgreSQL schemas, migration tracks, and implementations. Dialect types do
  not escape the module. A `settings` table is the foundation record; later
  tickets extend the schema on both tracks.
- `src/http/` — Elysia app with typed `/health/live` and `/health/ready`,
  generated OpenAPI at `/docs`, and SPA-aware static serving with path
  traversal rejected.
- `src/runtime/startup.ts` — validate, open, migrate, then listen. Failure at
  any step leaves nothing bound and no database handle open.
- `ui/` — fresh shadcn (new-york, neutral) initialization, Geist, neutral OKLCH
  tokens over a gray canvas, blue active accent, light/dark/system themes, and
  a responsive sidebar shell using the version-one navigation.

### Deferred to the tickets that own them

- `IROHA_SETUP_TOKEN` is parsed and validated but not yet *required*; that rule
  depends on the Owner record from ticket 02.
- `src/main.ts` stops on `SIGINT`/`SIGTERM` without a drain grace period.
  Ticket 17 owns graceful shutdown.
- `/docs` currently describes only the health routes. Ticket 17 owns the
  generated documentation contract and its authentication metadata.
