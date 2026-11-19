# 20: Daily model refresh job

**What to build:** Each enabled Provider's model list refreshes once a day, with start times spread across the day rather than at startup. Each run is logged. No job ever changes or deletes Upstream Keys. Agents can see the schedule and last result per Provider through the API.

**Blocked by:** 10, 19

**Status:** done

- [x] Refresh times spread deterministically across Providers
- [x] Startup does not trigger a burst of refreshes
- [x] Last run time and outcome per Provider visible through the API

## Comments

Built `internal/modelrefresh`: job `model_refresh` (every 15 min, refreshes the Providers that are due via `models.Store.Refresh`) and `GET /api/model-refreshes` (per Provider: `daily_at`, `scheduled`/`not_scheduled`, `next_refresh_at`, `last_refresh`). Each Provider's time of day is a hash of its ID; it is due at that time at least 12 h after its last refresh, so a refresh by hand counts as the day's.

Decision on never-refreshed Providers (ticket 10's open point): due soon, at `max(Iroha start, Provider creation) + (daily_at mod 1 h)`. A new Provider is discovered within the hour, and after a start the first refreshes (and ones that fell due while Iroha was down) are spread over that hour instead of a burst. Disabled, archived and `discovery none` Providers are not scheduled.

A failed refresh is not retried before the next day (the spec asks for a daily refresh; an agent can refresh by hand). `TestNoJobChangesOrDeletesUpstreamKeys` runs both jobs for three days over keys that are active, invalid, disabled and refused by their model list, and checks the keys, Key State events and Audit Entries are unchanged. Gateway tests' `bearers` helper now ignores model-list GETs; retention tests filter `job.run` events by job.
