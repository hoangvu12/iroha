# 27: v1 import and cutover

**What to build:** A runbook in the served skill and an agent-run import that reads v1's configuration and recreates it in v2 through the admin API: Providers and their Endpoints (v1 per-key base URLs become Endpoints with the keys restricted to them), Upstream Keys the Owner holds, and Gateway Keys with the same names and scopes but new secrets. The cutover deploys v2, points the public hostname at it, keeps v1 runnable for rollback, and lists the new Gateway Keys for the Owner to hand out once.

**Blocked by:** 03, 18, 22, 23, 24, 25, 26

**Status:** done

- [x] Import is a dry run by default and reports what it would create
- [x] Re-running the import does not duplicate anything
- [x] Upstream Accounts, history, audit and Management Keys are not imported
- [x] Rollback to v1 documented and tested once

## Comments

Built `cmd/iroha-import-v1` (thin flags/env wrapper) over `internal/v1import`: reads a copy of v1's SQLite file read-only (older v1 schemas too), decrypts Upstream Keys and static headers with v1's master key (AES-256-GCM, checked against vectors made by v1's own cipher), maps them (`MakePlan`) and diffs against v2 over the admin API; `--apply` sends create-or-update calls. Matching: Providers by handle, Endpoints by URL+Shape, keys by secret (keyless slots by name), Gateway Keys by name; a second run is all `unchanged` with no Audit Entry. Secrets are never printed (every line is masked). Runbook, mapping table and rollback: `internal/api/skill/55_v1_import.md`. Tests: `internal/v1import/import_test.go` (synthetic v1 database, fake secrets, testkit).

Local real-data run (copy of v1's local `iroha.db`, local v2 on a temp dir with outbound traffic blocked): dry run and apply both 12 Providers, 28 Endpoints, 193 Upstream Keys (249 v1 key rows; 56 repeated a secret on the same Provider and became one key on several Endpoints), 6 Gateway Keys; re-run all unchanged; the v1 file's hash was unchanged. Rollback tested once: v1 (Bun) started on that same data afterwards and answered `/health/ready` (providers disabled in that throwaway copy and outbound traffic blocked, so it could not reach real Providers).

Not done: v1 model catalog Owner entries (exclusions, additions) are reported, not imported (the brief limited the import to Providers, Endpoints, Upstream Keys and Gateway Keys); archived Providers and revoked Gateway Keys are left out and listed. ADR-0007 says no CLI: this is an agent-run admin API client used once for cutover, which the ADR allows as a later thin client.
