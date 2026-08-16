# Persist sanitized Provider Diagnostics per attempt

Status: Complete
Blocked by: 01

Extend attempt persistence and HTTP views with bounded allow-listed Provider code/type, Failure Classification, Capacity Scope, retry/recheck timing, and safe capacity facts. Apply request-history retention and prohibit raw bodies, arbitrary messages, prompts, completions, headers, and secrets.

## Comments

Added backward-compatible SQLite/PostgreSQL diagnostics JSON columns and sanitized write/read/HTTP mappings. Only the fixed bounded allow-list survives; arbitrary body/message/prompt/completion/header/secret fields are discarded. Existing cascade retention owns diagnostics. Evidence: Wave 2 gate passed 221 tests (PostgreSQL live conformance skipped without `IROHA_TEST_POSTGRES_URL`), typecheck, migrations conformance, and UI build.
