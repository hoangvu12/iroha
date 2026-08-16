# Show capacity certainty and useful attempt diagnostics

Status: Complete
Blocked by: 04, 06, 07

Render fresh authoritative usage, Exhausted, Unknown, stale retained readings, and Not available distinctly. Show sanitized Provider code/type, normalized classification, Capacity Scope, alternate attempts, evidence freshness, and retry/recheck timing in key details and request history.

Verify the UI contract through HTTP tests according to `docs/agents/ui-testing.md`.

## Comments

The Owner UI now distinguishes authoritative capacity, explicit exhaustion and limiting reason, Unknown, retained stale readings, and unsupported usage. Request attempts show sanitized Provider diagnostics, alternate position, evidence authority/freshness, and retry/recheck timing. Per repository policy, coverage is at the assembled HTTP seam; no DOM harness was added. UI typecheck/build and the Impeccable detector passed.
