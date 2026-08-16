# Derive health and Routing Eligibility in one reconciliation module

Status: Complete
Blocked by: 01

Build the deep reconciliation module that merges Owner state, Credential Evidence, Capacity Evidence, and existing durable state. It owns bidirectional exhaustion/reactivation, evidence freshness, stale preservation, next-check calculation, and selection eligibility.

Test through the module interface with fake evidence rather than through its internal seams.

## Comments

Implemented the pure reconciliation interface with deterministic clock/jitter seams. It owns evidence freshness, scope matching, durable exhaustion/reactivation, Routing Eligibility, and bounded credit/window rechecks. Evidence: Wave 2 gate passed 221 tests (1 PostgreSQL environment skip), typecheck, and UI production build.
