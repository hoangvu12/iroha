# Server-side Overview aggregation

Status: Complete
Blocked by: 01-request-lifecycle.md

Add an authenticated aggregation endpoint and use it for selectable 12-hour, 24-hour, and 7-day Overview charts.

## Acceptance

- [x] Aggregates include completed Requests only.
- [x] Request status classes, latency percentiles, totals, top models, and recent failures come from the server contract.
- [x] The UI defaults to 24 hours and can select all supported ranges.
- [x] HTTP tests cover bucket counts, aggregation, and range validation.

## Comments

No browser harness is used per `docs/agents/ui-testing.md`; the authenticated HTTP contract, UI typecheck, and production build cover this change.
