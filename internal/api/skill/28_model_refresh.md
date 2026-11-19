## Daily model refresh

The `model_refresh` job refreshes each enabled Provider's model list once a day, each Provider at its own time of day (`daily_at`, UTC, fixed for the Provider), so refreshes are spread across the day. `GET /api/model-refreshes` shows every Provider's `daily_at`, `next_refresh_at` and `last_refresh` (time, outcome, summary).

- A Provider never refreshed is first refreshed within an hour of its creation (or of Iroha's start), at its own minute of that hour: a start never causes a burst of refreshes. A refresh that fell due while Iroha was down is spread the same way after the start.
- A refresh by hand (`POST /api/providers/acme/models/refresh`) counts as the day's: the next scheduled one is at the Provider's time at least 12 hours later.
- Disabled and archived Providers and Providers with `discovery` `none` are not scheduled (`not_scheduled` says why).
- The job runs every 15 minutes and refreshes the Providers that are due, one at a time; each run is a `job.run` event, each refresh `discovery` events (`GET /api/logs?kind=discovery&provider=acme`). `POST /api/jobs/model_refresh/run?dry_run=true` names the Providers due now without reading anything.
- A failed model list never changes a key: discovery never sets Key States, and no job changes or deletes Upstream Keys.
