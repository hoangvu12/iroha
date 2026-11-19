# 25: Requests page and Request route view

**What to build:** Following `design/v2-clean/` (C03, C04, C18):
- A stats row for the current filters: Requests, succeeded, retried, median duration, median time to first token, tokens.
- A live feed with filters (caller including Test callers, Provider or Pool, model, status, time range) and configurable columns: time, status, caller, model with Pool tag, Provider with logo, Upstream Key, Shape in and out, Attempts, time to first token, duration, input and output tokens. Failed rows tinted; retried Requests marked.
- A drawer with Details, Attempts and Captured tabs; arrow keys step through Requests; a Replay button opens the test chat with the prompt when captured.
- A full-page Route view: the Request's Attempts as a top-to-bottom chain of cards from Start to End, each connection labelled with why Iroha moved on ("Cooling, tried the next key", "Model Gap, tried the next key"), the selected card's details (what happened, matched Failure Rule, Key State effect, Endpoint, raw error) beside it.

**Blocked by:** 21, 19

**Status:** ready-for-agent

- [ ] New Requests appear without reloading; pausing the feed is possible
- [ ] Filters and visible columns are reflected in the URL
- [ ] Stats row is computed by the API for the same filters
- [ ] Route view and drawer read the same Attempt data as the API explanation
