# Adaptive bounded usage polling

Status: Complete
Blocked by: —

Remove post-success entitlement polling, retain stale-evidence refreshes for capacity failures, and bound each Provider's per-key polling concurrency to four.

## Acceptance

- [x] Successful inference does not start a usage refresh.
- [x] Capacity failure can request a deduplicated refresh when evidence is stale or absent.
- [x] Fresh authoritative evidence suppresses the expedited refresh.
- [x] At most four key polls run concurrently for one Provider.
- [x] Polling remains independent per Upstream Key and does not depend on Upstream Accounts.
