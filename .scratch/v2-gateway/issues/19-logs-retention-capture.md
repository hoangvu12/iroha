# 19: Logs everywhere, retention and prompt capture

**What to build:** Every meaningful event (Attempt, rule match, Key State change, Model Gap, discovery run, job run, configuration change, startup, shutdown) is a structured log event readable through the logs API, filterable by time, level, kind, Request and Provider. Gateway Keys get a capture switch that stores full prompts and responses for their Requests. Retention is configurable per kind (history and logs 30 days, captures 3 days by default) and enforced by an hourly job.

**Blocked by:** 04

**Status:** done

- [x] Every event kind listed above appears in the logs API with Request and Provider links
- [x] Capture on stores bodies (streams reassembled); capture off stores none
- [x] Retention settings changeable via the API; the hourly job deletes expired data and logs its run

## Comments

Built:

- **Event kinds.** `attempt`, `request`, `config.change`, `startup` and `shutdown` already existed. The kinds later tickets emit are now registered once in `internal/logs/kinds.go`, each with its attribute conventions: `rule.match`, `key.state`, `model_gap`, `discovery` and `job.run`. In `docs/agents/architecture.md`, "Add a log event kind" has a table giving, for each kind, who emits it, at what level, and with which links and attributes. Tickets 05, 08, 10 and 20 should use `logs.KindRuleMatch` and the other shared kinds instead of registering their own, because registering a name twice panics at startup. This ticket does not build the behaviour behind rule matches, Key States, Model Gaps or discovery. A test shows that every kind is listed in `/skill.md` and that events of each kind can be filtered by Request and Provider.
- **Capture.** Gateway Keys have a `capture` flag, false by default. It can be set on create, through PATCH, or by create-or-update, and every change is audited and can be reverted. `exchange.begin` wraps the Caller's body and the response writer. Attempt code therefore never handles capture, and everything that reaches the Caller is captured, refusals included. Read a capture with `GET /api/requests/{id}/capture`. Each Request has a `captured` flag. A streamed response is stored as sent and also reassembled into one answer. For OpenAI Chat that answer is a `chat.completion`, with tool calls merged by index. For other Shapes it is a list of event payloads until tickets 13–15 add their own reassembly in `requests/capture.go`. Each body is capped at 16 MiB.
- **Settings.** `internal/settings` is the `settings` admin resource, built on the audit machinery. Its routes are `GET /api/settings`, `GET`, `PUT` and `DELETE /api/settings/{name}`, and `POST /api/settings/bulk`. A setting is declared with `settings.NewInt` in the package that reads it. There are three retention settings, in days, each between 1 and 3650: `retention.history_days` (default 30), `retention.logs_days` (default 30) and `retention.captures_days` (default 3).
- **Jobs.** `internal/jobs` is the runner that ticket 20 reuses:
  - Timers use the injected clock, and runs of one job never overlap.
  - Each run is stored in `job_runs`, which keeps the latest 100 per job, and logged as `job.run`.
  - A run stopped by shutdown has the outcome `canceled`. A run that panics has the outcome `failed`.
  - `jobs.Every(d)` keeps its rhythm across restarts. It does not run at startup unless a run is overdue.
  - The API is `GET /api/jobs`, `GET /api/jobs/{job}` and `POST /api/jobs/{job}/run?dry_run=`.
  - Tests use `testkit.Options{Jobs}`, `srv.SettleJobs()` and `srv.RunJob()`.
- **Retention job.** The `retention` job runs every hour and deletes in batches: first expired captures, then expired Requests (their Attempts and captures go with them by cascade), then expired log events. A dry run counts what it would delete.
- **Crash recovery.** At startup, before serving, every Request still `in_progress` becomes `interrupted` with error code `interrupted`, and a `request.interrupted` event is logged at warn level for each one.

Deferred and notes:

- v1 let retention be 0 to turn history off (LOG-10). In v2 the minimum is 1 day, because the spec does not ask for 0. Ticket 26 can decide.
- An interrupted Request names its Provider only if one of its Attempts had finished. Otherwise the Provider is recorded only when the Request finishes. Recording it earlier would mean changing the gateway, which belongs to ticket 05.
- A captured body is returned as a JSON value, so its whitespace is not kept. A body that is not JSON is returned as a string.
