# Request observability and efficient capacity polling

Status: Accepted

## Outcome

- Request history exposes only completed Requests.
- A Request reports the final caller-visible outcome; Attempts retain their individual upstream outcomes.
- Recovered Requests remain successful and advertise their retry trail.
- Abandoned internal Requests stay outside normal history and analytics.
- Overview reads server-side aggregates for 12-hour, 24-hour, and 7-day ranges; 24 hours is the default.
- Usage polling remains per Upstream Key, runs with concurrency four, and is scheduled or prompted by stale capacity evidence rather than every inference success.
- Existing placeholder history rows are not backfilled.

## Verification

- SQLite and PostgreSQL repository contracts enforce terminal-only reads.
- HTTP tests cover Request detail/list semantics and Overview aggregation.
- Usage service tests cover success no-op, failure-triggered deduplication, freshness gating, and bounded concurrency.
- UI ships without a DOM harness per `docs/agents/ui-testing.md`; its API contracts and production build are verified instead.
