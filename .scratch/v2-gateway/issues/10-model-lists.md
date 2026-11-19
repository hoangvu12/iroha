# 10: Model lists and discovery

**What to build:** Each Provider keeps a model list whose entries can be discovered (per Provider or per key, from each Endpoint's discovery URL, or never), added by the Owner, and hidden, independently. Discovery never removes Owner additions; failures keep the previous list. Per-key discovered lists order carriers first and never exclude keys, and a list that includes a model clears that key's Model Gap for it. Unlisted models are forwarded unless the Provider is strict. Agents can trigger a refresh and reset discovered models. Provider-scoped `/models` lists the Provider's visible models within the Gateway Key's scope.

**Blocked by:** 08, 09

**Status:** done

- [x] Discovery accepts `data` or `models` arrays; failures are logged, not fatal
- [x] Owner-added models survive refreshes that omit them
- [x] Hidden models are refused and unlisted
- [x] Strict Providers refuse unlisted models before any Attempt; others forward them
- [x] Carriers ordered first; discovery clears matching Model Gaps
- [x] Reset discovered models without recreating the Provider

## Comments

Built in `internal/models` (tests `internal/models/models_test.go`, planner table test `TestKnownCarriersGoFirstAndOthersStay`):

- Provider `strict` and `discovery` (`none` / `provider` default / `key`), Endpoint `discovery_url` (`""` = `<url>/models`, `"none"`, or a URL); migration `10_01_model_lists.sql` (`provider_models`, `provider_model_sources`, `model_refreshes`).
- `POST /api/providers/{p}/models/refresh` (dry run supported), `POST .../models/reset`, `GET .../models` (search `q`, `filter` all/visible/discovered/added/hidden/gaps, `offset`/`limit`, per-filter `counts`, `last_refresh`) for the Models tab (22), audited `POST .../models` and `.../models/bulk` for add/hide/show (resource `model`, revertible).
- Discovery uses the Endpoint's auth style and static headers, follows Anthropic `has_more`/`last_id` and Gemini `nextPageToken`, strips Gemini's `models/` prefix, keeps each model's raw object in `provider_models.reported` for ticket 11. One `discovery` event per list and one per refresh.
- `models.Store.Prepare` runs before planning in the Gateway: hidden and (strict) unlisted models get 404 `model_not_found` with no Attempt; per-key lists set `planner.Key.Carries`, and `planTier` puts carriers first (stable, so round-robin holds within each group).
- `GET /providers/{handle}/v1/models` (Caller, OpenAI list shape): visible models, or exactly the scope's models (minus hidden) for a key narrowed to models. Added `gatewaykeys.Caller.ScopeModels`.
- For ticket 20: `Store.Refresh(ctx, providerRef, dryRun)` fits a `jobs.Job` body; `Store.LastRefreshOf` reads the last refresh per Provider.

Deferred: nothing triggers discovery automatically yet (creating a Provider, Endpoint or key does not, v1 MOD-45/47); the daily job (20) is the trigger, and it could treat a never-refreshed Provider as due at once. A refresh refused for every key leaves the list as it was rather than falling back to anything.
