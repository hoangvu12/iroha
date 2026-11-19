## Logs, captures and retention

Everything Iroha does leaves a log event: each Attempt and Request, Failure Rule matches, Key State changes, Model Gaps, discovery runs, background job runs, configuration changes, startup and shutdown. Events about a Request carry its `request_id`, events about a Provider its `provider` handle, so `GET /api/logs?request_id=<x-request-id>` gives a Request's whole story and `GET /api/logs?provider=acme&level=warn&since=1h` what went wrong with one Provider. The kinds are listed at the end of this document.

**Watching Requests.** `GET /api/requests` filters by `caller` (Gateway Key name or ID, or a test caller such as `Test (as zeron-fleet)`), `caller_kind`, `provider`, `pool`, `model`, `status` (`429`, `5xx`, `failed`), `retried`, `q` and `since`/`until`; repeat a filter to match any of its values. `GET /api/requests/stats` takes the same filters and answers counts, success, retries, median duration and time to first token, and tokens; `GET /api/requests/filters?since=24h` lists the Callers, Providers, Pools and models seen. To follow traffic, keep the `cursor` of any page and poll `GET /api/requests?changed_after=<cursor>&<same filters>` every few seconds: each answer holds only the Requests that started or changed since (an in-progress Request comes again when it finishes) and the next `cursor`.

A Request that was still running when Iroha stopped hard (crash, forced restart) is marked `"state": "interrupted"` at the next start, with a `request.interrupted` event.

**Prompt capture** is off by default. Turn it on for one Gateway Key, typically your own client while debugging, with `PATCH /api/gateway-keys/<name>` `{"capture": true}`; from then on each of its Requests shows `"captured": true` and `GET /api/requests/<id>/capture` returns the body the Caller sent and the answer it received (a streamed answer both as sent and reassembled into one answer). Keys of other people should stay off: capture stores their conversations.

**Retention** is three settings, read with `GET /api/settings` and changed with `PUT /api/settings/<name>` `{"value": <days>}` (audited and revertible like any change):

- `retention.history_days` (default 30): Requests and their Attempts.
- `retention.logs_days` (default 30): log events, and Owner sessions counted from when they were revoked or expired.
- `retention.captures_days` (default 3): captured prompts and responses.

The `retention` job applies them every hour. `GET /api/jobs` shows each background job's schedule, next run and last result; `POST /api/jobs/retention/run?dry_run=true` reports what it would delete now, and without `dry_run` runs it. No job ever changes or deletes Upstream Keys.
