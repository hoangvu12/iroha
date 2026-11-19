# 39: Prometheus metrics (optional)

**What to build:** v1 had opt-in Prometheus text at an admin route with bounded-cardinality series: Requests by outcome, failures by kind, a duration histogram, retries, Upstream Key counts per Key State, process memory (catalog MET-01, MET-02; MET-03 was a v1 bug: global routes were not counted). v2 has `/api/requests/stats` and the logs API instead, and the spec neither asks for metrics nor rules them out. If monitoring needs them, add `GET /api/metrics` (Admin Token, off by default through a setting), counting global and provider-scoped routes alike.

**Blocked by:** none

**Status:** needs-decision

- [ ] If built: HTTP test reading the text format after a few Requests on both route kinds; no per-key or per-model labels beyond bounded sets
