# 25: Requests page and Request route view

**What to build:** Following `design/v2-clean/` (C03, C04, C18):
- A stats row for the current filters: Requests, succeeded, retried, median duration, median time to first token, tokens.
- A live feed with filters (caller including Test callers, Provider or Pool, model, status, time range) and configurable columns: time, status, caller, model with Pool tag, Provider with logo, Upstream Key, Shape in and out, Attempts, time to first token, duration, input and output tokens. Failed rows tinted; retried Requests marked.
- A drawer with Details, Attempts and Captured tabs; arrow keys step through Requests; a Replay button opens the test chat with the prompt when captured.
- A full-page Route view: the Request's Attempts as a top-to-bottom chain of cards from Start to End, each connection labelled with why Iroha moved on ("Cooling, tried the next key", "Model Gap, tried the next key"), the selected card's details (what happened, matched Failure Rule, Key State effect, Endpoint, raw error) beside it.

**Blocked by:** 21, 19

**Status:** done

- [x] New Requests appear without reloading; pausing the feed is possible
- [x] Filters and visible columns are reflected in the URL
- [x] Stats row is computed by the API for the same filters
- [x] Route view and drawer read the same Attempt data as the API explanation

## Comments

- **API** (`internal/requests`, tested through HTTP in `feed_test.go`): `GET /api/requests` gained `caller_kind` (`gateway_key`, `test`), `pool`, `retried`, `q` (ID, model, Caller, Provider), `status=failed`, and repeated values (`caller=a&caller=b`); a Gateway Key ID matches only that key's own traffic, never tests sent as it. `GET /api/requests/stats` takes the same filters (requests, in progress, succeeded, failed, retried, median duration and first byte over succeeded Requests, tokens). `GET /api/requests/filters?since=` lists Callers (with kind), Providers, Pools and models seen. Live: every page carries a `cursor`; `GET /api/requests?changed_after=<cursor>` returns what started or changed since, oldest change first (an in-progress Request comes again when it finishes). The change counter `rev` is kept by SQLite triggers (migration `25_01`), so no writer changes. Polling, not SSE: it is plain for agents and holds no connection open during a drain. Documented in `/skill.md` (40_history.md).
- **Pool**: migration `25_01` adds `requests.pool` (empty today) with its filter and the "Pool" tag; ticket 18 only has to write it. **Test callers**: `requests.CallerTest` is declared; ticket 23 records them. Both were exercised by inserting rows in the test.
- **UI** (`web/src/pages/requests`): stats row, live feed (pause with the Live toggle; new rows fade in), Filter menu (Caller, Provider or Pool, Model, Status; Time on phones), Columns menu, time range, chips, URL state, loading/empty/no results/error states, phone two-line rows; drawer with Details / Attempts / Captured, arrow keys or j/k, Escape; full-page Route view (`/requests/<id>/route`, `/details`, `/captured`) with pan and zoom, connection pills from the Attempt outcome, and the selected card's panel (result, Failure Rule, Key State, Then, Sent to, upstream error and headers). Attempt fields from ticket 05 are read in `attempt-info.ts` only. Checked in headless Chrome, light, dark and phone.
- **Not done / for later**: the Captured tab shows "Caller sent" and "Response" only; Iroha does not capture the body sent upstream, so the design's "Sent upstream" segment needs a capture change first. Provider logos are letter tiles until ticket 22 serves them (`providerLogo()` in `bits.tsx`). "Open team-3" in the Route view links to `/providers/<p>/keys?q=<key>` (ticket 22's page).
