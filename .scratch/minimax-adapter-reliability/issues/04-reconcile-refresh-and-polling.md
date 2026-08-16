# Reconcile manual Refresh and scheduled usage polling

Status: Complete
Blocked by: 02, 03

Make manual Refresh perform one authentication probe, one entitlement poll, and one reconciliation. Remove the duplicate UI-triggered usage poll. Make background polling demote zero/negative active keys and reactivate only from fresh positive evidence.

Schedule subscription checks near the limiting advertised boundary with grace/jitter and a five-minute safety cadence; poll exhausted credit every 15 minutes.

## Comments

Manual Refresh and scheduled polling now share normalized reconciliation. Refresh performs one entitlement poll per key, authentication cannot clear exhaustion, failed polls preserve stale health, and fresh positive authority restores eligibility. Scheduled checks honor credit/window recheck timing; the duplicate UI poll was removed. Evidence: Wave 3 gate passed 252 tests and typecheck.
