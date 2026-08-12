# 02 — Secure single-Owner lifecycle

**What to build:** A protected first-run and authentication experience through which the sole Owner claims the installation, signs in normally, manages sessions, and recovers access without a shell.

**Blocked by:** 01 — Runnable dual-database application foundation.

**Status:** complete

- [x] When no Owner exists, setup requires the configured setup token and creates the sole username/password account.
- [x] Once an Owner exists, setup is permanently closed and cannot replace or recreate the Owner.
- [x] Passwords are securely hashed and never returned or logged.
- [x] Login uses secure HTTP-only same-site sessions with sliding renewal and CSRF protection for mutations.
- [x] The Owner can list, revoke, and log out all sessions.
- [x] Optional environment-token recovery works in the browser, is throttled and audited, changes the password, and revokes existing sessions.
- [x] Login, setup, and recovery failures reveal no sensitive configuration.
- [x] Browser and HTTP tests cover setup, repeat setup, login, logout, session revocation, and recovery.

## Comments

### What "browser test" means here

There is no headless browser in this repository's toolchain, and adding one
would introduce a downloaded binary and a running server to every test run.
`ui/test/auth-flows.test.tsx` instead renders the real React application into a
real DOM (happy-dom) whose `fetch` reaches the assembled Elysia application
through a cookie jar that behaves the way a browser's does. It drives the same
flows a person would: claim, mistyped setup token, short password, sign in,
wrong password, sign out, list and revoke another session, sign out everywhere,
and recovery followed by signing in with the new password.

What that harness cannot prove is the part only a browser enforces: `HttpOnly`,
`SameSite`, and `Secure` are asserted on the `Set-Cookie` header itself in
`test/http/setup.test.ts` and `test/http/login.test.ts`, and cross-origin
refusal is asserted at the HTTP layer rather than by a browser declining to
send the cookie. A real-browser suite remains worth adding when one of the
later UI tickets justifies the toolchain.

### What was built

- `src/persistence/` — `owner`, `owner_sessions`, and `audit_events` on both
  dialects with a shared contract and one conformance suite. A single Owner is
  enforced by a constant primary key, so two concurrent setup requests cannot
  both succeed; the loser is told setup is closed.
- `src/identity/` — password hashing (Argon2id, injectable cost), high-entropy
  secret generation and timing-safe comparison, credential rules that never
  quote the submitted value, a fixed-window attempt throttle, and
  `OwnerIdentity`, which owns the rules: setup closes permanently, failures stay
  indistinguishable, sessions are validated against a stored hash, and recovery
  revokes what it invalidates.
- `src/http/auth.ts` — `/api/v1/auth/*`: state, setup, login, logout, session
  list, revoke one, revoke all, and recover. Management traffic is same-origin
  only and mutations carry the session's CSRF token.
- `src/runtime/startup.ts` — `IROHA_SETUP_TOKEN` is now *required* while no
  Owner exists, which is the rule ticket 01 deferred. The check needs the
  migrated database, so it runs after migration and before the port binds.
- `ui/` — setup, sign-in, and recovery screens chosen by the gateway's own
  state rather than by navigation, plus a Settings area listing every signed-in
  browser with per-session revocation and sign-out-everywhere.

### Decisions worth knowing about

- **Audit is minimal on purpose.** Ticket 13 owns audit history and its UI. This
  ticket adds only the table and the auth events it must record — setup, login
  success and failure, logout, session revocation, and recovery — with detail
  that never contains a submitted value. A failed login records that it
  happened, not what was typed, because a mistyped password belongs in no
  record Iroha keeps.
- **Throttle counters live in memory and are keyed per calling address.** One
  counter for the whole installation would have handed any stranger a way to
  lock the Owner out by failing on purpose, so failures are counted per source,
  with a bounded map and eviction. Behind a reverse proxy that hides the caller
  every caller looks like the proxy, which is the shared-counter behaviour
  again; the real brake on guessing remains Argon2id's cost. Counters do not
  survive a restart, and nothing that must survive one lives here.
- **A rejected login always pays the hashing cost.** The password is verified
  even against a username that cannot match, and against a hash of a value
  nobody holds when there is no Owner, so how long a rejection takes says
  nothing about which half was wrong.
- **Sliding renewal reissues the cookie.** Moving only the stored expiry would
  still have signed a daily user out on the seventh day, because the browser's
  copy would have kept its original `Max-Age`.
- **No request body schemas on the auth routes.** Elysia's validation report
  quotes the offending value, which on these routes could be a password. Bodies
  are validated in the handler and validation errors return field rules only.
  Ticket 17 owns the documented request schemas for the generated OpenAPI.
- **`recoveryEnabled` is public.** The pre-login state says whether recovery
  exists so the screen can be honest, but never what the token is, and an
  attempt against an unconfigured installation is refused identically to a wrong
  token.
- **Recovery does not sign the browser in.** The Owner proves the new password
  by logging in with it, which also means a recovery response grants nothing.
- **Session expiry is idle-only.** Seven days of disuse ends a session; use
  slides it forward, at most once a minute so that reading a page does not write
  to the database. There is no absolute maximum lifetime in version one.

### Review

`/code-review` ran both axes over this work. Its findings were applied rather
than recorded: the cookie was not being reissued on renewal, a wrong username
skipped password verification, the installation-wide throttle was a lockout
vector, `X-Forwarded-Proto` could downgrade the `Secure` flag, the two dialects
declared `audit_events.detail` differently, and the HTTP tests repeated the
same response-unwrapping shape a dozen times. Each has a test above.

### Deferred to the tickets that own them

- Expired sessions are cleared opportunistically on login, session listing, and
  first use after expiry. Ticket 14 owns the bounded background cleanup job.
- `/docs` now lists the auth routes from their route definitions; ticket 17
  owns the documented request/response contract and its authentication metadata.
- PostgreSQL conformance for these repositories is written and runs with
  `IROHA_TEST_POSTGRES_URL`, but no PostgreSQL server was available here either,
  so it shares ticket 01's unverified status.
