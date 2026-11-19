# 18: Model Pools

**What to build:** Agents create Model Pools (name without a slash, ordered members of Provider and model, optional budget override). A Caller naming a Pool on the global routes is served by the first member with a candidate, failing over down the list within the Request's budget. Gateway Key scopes can include Pools. `/v1/models` lists the Pools a key may use, with metadata taken from the first member. The response echoes the Pool name; the Attempt records the serving Provider and model.

**Blocked by:** 12

**Status:** done

- [x] Failover across members within the shared budget
- [x] Reordering members changes routing on the next Request
- [x] Pool scope on Gateway Keys enforced with the uniform refusal
- [x] Pool names cannot collide with each other; changes are audited
- [x] Route preview API: for a Pool or `provider/model` (optionally as a Gateway Key) returns members, Endpoints and keys in try order, each skipped key with its reason and until-time, using the same planner as live traffic and sending nothing
- [x] Members can be switched off without removing them; switched-off members are reported, not planned

## Comments

- New package `internal/pools` (tables `pools`, `pool_members`; audited resource `pool` at `/api/pools` with create-or-update, bulk, PATCH, DELETE, dry run, revert). Members are replaced as a whole list (reorder, switch off with `enabled: false`). Names: no slash, unique case-insensitively (409 `name_taken`). Optional `budget` (`max_attempts`, `first_byte_seconds`, capped like a Provider's). `maker` field for the logo: the Owner's, else guessed from the name (`GuessMaker`); logos themselves are ticket 22's.
- Routing: `(*exchange).global` sends a slash-less name to `poolRoute` (`gateway/pool.go`); members become planner Providers in order, each with `planner.Provider.Model`. Members switched off, on disabled/archived Providers or whose model is hidden/unlisted-on-strict are skipped (503 `no_candidate`, reason `no_member`, when none is left). One budget across members, the Pool's override winning. The answer echoes the Pool name; `requests.pool` is written; Attempts record the serving Provider and wire model. Works on every global route, Gemini included (`/v1beta/models/<pool>:generateContent`).
- Scopes: `scope.pools` on Gateway Keys (stored as IDs, shown as names). A Pool in scope is usable through all its members regardless of the key's Providers. Unknown and out-of-scope Pools get the same 400 `invalid_model_id`. A Pool named by an unrevoked key cannot be deleted (409 `pool_in_use`).
- `/v1/models` lists the key's Pools first, metadata from the first switched-on member on an enabled Provider, `owned_by` the maker.
- Route preview: `GET /api/route-preview?model=<pool or provider/model>&shape=&as=<gateway key>` runs the live resolver and `planner.Plan` with `Counter.Peek()` (next Request's rotation, not advanced); per member: candidates (Endpoint, key, wire model, translated, carrier), skipped keys with reason, until and seconds left, `empty` reason, `not_planned` for off/unusable members; `outcome` is the error a Caller would get. Sends and writes nothing. Not included: per-key last-used times shown in design C19 (the UI can take them from the Upstream Keys list) and the "Requests today / served by first member" stats of C06 (derivable from `/api/requests/stats?pool=`).
