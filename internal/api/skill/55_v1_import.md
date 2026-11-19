## Moving from v1 (import and cutover)

Do this only when the Owner asks. The import recreates the configuration the Owner holds in Iroha v1 (Providers, their Endpoints, Upstream Keys, Gateway Keys) through this admin API, using `cmd/iroha-import-v1` from a checkout of the Iroha repository (Go needed). It is a client of the admin API like any other: it reads a **copy** of v1's SQLite file (opened read-only), compares it with what v2 already holds, and sends ordinary create-or-update calls, so every change is an Audit Entry naming your Admin Token.

```
IROHA_ADMIN_TOKEN=<v2 Admin Token> go run ./cmd/iroha-import-v1 \
  --v1-db <copy>/iroha.db --v1-env <copy>/.env --url http://127.0.0.1:18080           # dry run
IROHA_ADMIN_TOKEN=<v2 Admin Token> go run ./cmd/iroha-import-v1 ... --apply           # import
```

- **Dry run by default.** Without `--apply` only `GET` requests reach v2; the output says per record `would create`, `would update` or `unchanged`.
- **Safe to repeat.** Providers are matched by handle, Endpoints by URL and Shape, Upstream Keys by secret (keyless slots by name), Gateway Keys by name. A second run reports everything `unchanged` and writes no Audit Entry. A run re-asserts v1's values on the records it matches (for example a Gateway Key's scope), so run it before the Owner starts editing in v2, not after.
- **Secrets.** v1 encrypted Upstream Keys and static headers with its `IROHA_MASTER_KEY`; give it with `--v1-env` (v1's `.env`) or the `IROHA_V1_MASTER_KEY` variable. If any stored secret does not decrypt, the run stops before changing anything. The output never contains a secret (static header values are redacted), and the Admin Token is read only from the environment.
- **Output.** The last line is `IROHA_IMPORT dry_run|applied providers_create=N ... upstream_keys_disable=N skipped=N not_mapped=N failed=N`. Exit 0: done; 1: some records failed (each has a `failed:` line with the API's error; the rest were imported, so fix the cause and run again) or the run stopped; 2: bad arguments. Show the Owner the summary line and the "Not imported" and "v1 settings with no place in v2" sections.

What maps to what:

| v1 | v2 |
|---|---|
| Provider (not archived) | Provider with the same handle, display name and enabled flag. Discovery `none` when v1 discovery was unsupported, `provider` for templates whose keys share one model list, else `key` (v1's default). models.dev brand from the template (MiniMax `minimax`, DashScope `alibaba`, Z.ai `zai-coding-plan`, ...). Logo domain kept. A retry count other than 3 becomes `max_attempts`. |
| Provider base URL | Endpoint `default`: Shape `anthropic-messages` for Anthropic templates, else `openai-chat`; auth style from the auth header and prefix; the Provider's static headers. |
| Per-key base URL | One more Endpoint per distinct URL, named after its host. When a Provider ends up with several Endpoints, each key is restricted to the Endpoint(s) of its v1 base URL(s), so a key never goes to a URL it did not serve in v1. |
| Upstream Key | Upstream Key with the same secret, named `key-N`; key rows repeating a secret on one Provider become one key on all their Endpoints. Keys of a Provider that needed no key become keyless slots `keyless`, `keyless-2`, ... A key the Owner disabled stays disabled; cooling, exhausted or invalid keys start active (Key States are runtime). Per-key model rewrites become the Endpoint's renames when every key on that URL had the same ones. |
| Gateway Key (not revoked) | Gateway Key with the same name (characters v2 refuses become `-`) and scope, and a **new secret**: v1 stored only a hash (ADR-0006). Scope entries naming archived Providers, or allowing no model, are dropped. |

Never imported: archived Providers and their keys, revoked Gateway Keys, Upstream Accounts, request history, audit history, Management Keys, the Owner's password and sessions, model catalogs (the daily refresh rediscovers them; Owner exclusions are listed so you can hide those models again), usage snapshots. v1 settings without a v2 equivalent (per-key model allow/deny lists, transport timeouts, CORS origins) are listed in the output.

### Cutover runbook

1. **Deploy v2** beside v1 on the server ("Deploying Iroha"); v1 keeps serving the public hostname. Get an Admin Token for the import from the Owner (or the bootstrap token) and ask the Owner to set the Owner password (`PUT /api/owner-password`).
2. **Copy v1's data** to the machine running the import, into a new temp directory outside any repository: a consistent copy of v1's database (`sqlite3 <v1 data>/iroha.db ".backup '/tmp/iroha-v1.db'"` on the server, or `iroha.db` with its `-wal` and `-shm` files while v1 is stopped) and v1's `.env`. v1's `DATABASE_URL` says where its database is. Never copy them into a repository or paste the master key anywhere.
3. **Reach v2's admin API** without exposing it: `ssh -N -L 18080:127.0.0.1:8080 <user>@<server>`.
4. **Dry run**, read the report with the Owner, then run with `--apply`. Re-run until `failed=0`.
5. **Check v2**: `GET /api/providers` (Endpoints and key counts), `POST /api/providers/{provider}/keys/bulk/test` on a few Providers, `GET /api/route-preview?model=<handle>/<model>`, and a test chat as one of the new Gateway Keys.
6. **Point the public hostname at v2** (the reverse proxy or tunnel target moves from v1's port to v2's `127.0.0.1:8080`), confirm `GET /readyz` through the hostname, then stop v1's service. Leave v1's directory, database, `.env` and service unit in place: they are the rollback.
7. **Hand out the new Gateway Keys**: `GET /api/gateway-keys` lists them with their secrets; the Owner gives each Caller its new secret once. v1 secrets stop working when the hostname moves.
8. **Delete the copies** of v1's database and `.env` from the import machine.

### Rolling back to v1

Point the hostname back at v1's port and start v1's service. The import never writes to v1's database (it reads a copy, read-only), so v1 resumes with the configuration and Gateway Keys it had at cutover, and Callers use their old v1 secrets again. Changes made in v2 after cutover (keys added, Requests served) stay in v2 only. Tested once: after a real-data import, v1 started on that same data and answered `GET /health/ready`.
