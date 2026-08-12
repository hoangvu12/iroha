# Configuration

Iroha reads deployment configuration from environment variables. It reports all currently missing or malformed required values together and redacts secret values from errors and logs.

## Required

```env
DATABASE_URL=file:./data/iroha.db
IROHA_MASTER_KEY=replace-with-a-stable-random-secret
```

`DATABASE_URL` supports:

- `file:` for SQLite
- `postgres://` or `postgresql://` for PostgreSQL

The selected database must already be reachable and writable. SQLite paths should live on a persistent volume. Database choice does not migrate data from another engine.

`IROHA_MASTER_KEY` encrypts recoverable upstream secrets. It must remain stable across redeployments. Losing it requires re-entering encrypted Provider credentials. It must be at least 32 characters, and the `replace-with-…` placeholder from `.env.example` is rejected so that a copied template cannot become a live secret. Generate it with a cryptographically secure tool, for example:

```sh
openssl rand -hex 32
```

PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

## Required before initial setup

```env
IROHA_SETUP_TOKEN=replace-with-a-separate-random-secret
```

Generate this independently from the master key. Iroha refuses to start while no Owner exists and no setup token is configured, because an unclaimed installation would have no safe way to be claimed. Setup requires the token only while no Owner exists. Once setup completes, the route closes permanently — a second attempt is refused whether or not the token is correct — and the variable may be removed at the next restart.

## Optional

```env
IROHA_RECOVERY_TOKEN=
IROHA_SHUTDOWN_GRACE_MS=10000
HOST=0.0.0.0
PORT=3000
```

`IROHA_RECOVERY_TOKEN` enables browser-based Owner-password recovery. A permanently configured value is a reusable alternate root credential: protect, rotate, or remove it accordingly. Recovery is throttled and audited, and all Owner sessions are revoked after reset. Without it, the recovery form is not offered and a recovery attempt is refused exactly as a wrong token is.

`IROHA_SHUTDOWN_GRACE_MS` controls how long active inference may finish after a SIGINT or SIGTERM before its upstream request is aborted. It defaults to `10000`, accepts `0`, and is bounded between `0` and `60000` milliseconds. The process stops accepting new inference and background claims, waits for the grace period, aborts remaining upstream work, and closes storage before it exits.

Every secret variable follows the same rule as `IROHA_MASTER_KEY`: at least 32 characters, and never the shipped placeholder. `HOST` must be non-empty and `PORT` a whole number between 1 and 65535.

## Startup behaviour

Iroha validates configuration, opens the selected database, and applies every pending migration *before* it binds its port. A configuration or migration failure prints every current problem together and exits non-zero; nothing listens. Problem reports name the variable and what is wrong with it, never the value, and an unsupported `DATABASE_URL` is reported by scheme alone so that a URL carrying a password is not echoed into logs.

`/health/live` answers as soon as the process is up. `/health/ready` answers `200` only once configuration is valid, migrations have completed, and the database responds; otherwise it returns `503` with `configuration_invalid`, `migrations_pending`, `database_unavailable`, or `shutting_down`. Neither endpoint discloses the connection target.

`HOST` defaults to `0.0.0.0`; `PORT` defaults to `3000`.

## Signing in

The management application decides what to show from `/api/v1/auth/state`: an unclaimed installation offers first-run setup, a claimed one offers sign-in, and recovery appears only when a recovery token is configured.

Sessions are `HttpOnly`, `SameSite=Strict` cookies. Each use slides the seven-day idle expiry forward; a session left unused past it is refused and forgotten. The Owner can list every signed-in browser, revoke one, or sign out everywhere. Management requests must be same-origin, and every state-changing management request must repeat its session's CSRF token in the `x-iroha-csrf` header.

The cookie is marked `Secure` when the browser reached Iroha over HTTPS, including through a TLS-terminating proxy that sets `X-Forwarded-Proto`. Either signal alone is enough, so a client cannot strip the flag by claiming plain HTTP. A plain-HTTP installation still works, because a `Secure` cookie would never be sent back.

Setup, login, and recovery failures are throttled per calling address, and report nothing about which value was wrong or what is configured. Counting per address is what stops a stranger from locking the Owner out by failing on purpose; behind a reverse proxy that hides the caller, every caller looks like the proxy and the budget is shared. Counters live in memory and reset when Iroha restarts.

## Application-managed settings

The database-backed UI/API owns runtime policy, including:

- global and Provider Connection retry limits and time budgets;
- transport timeouts and redirect policy;
- model and Usage Adapter synchronization intervals;
- request-history retention;
- browser inference CORS allow-lists;
- metrics exposure;
- Gateway Key scopes.

These settings do not have simultaneous environment-variable ownership. Configuration export is redacted and excludes secret values.
