# Reconcile MiniMax failures during bounded failover

Status: Complete
Blocked by: 02, 03

Use authoritative evidence no older than 60 seconds when MiniMax returns 402/429. Otherwise start one deduplicated entitlement refresh, exclude the failed key from the current request, and continue within the Provider attempt/time budget. Return `provider_capacity_exhausted` only when authoritative evidence establishes it.

Keep generic bare-402 behavior under `.scratch/failure-classification-retries/`.

## Comments

Inference now consumes authoritative evidence no older than 60 seconds, reconciles known exhaustion/cooldown, triggers deduplicated refresh asynchronously for stale/missing evidence, persists sanitized attempt diagnostics, and preserves bounded alternate selection. Generic bare 402/429 remains provisional. Evidence: Wave 3 gate passed 252 tests and typecheck.
