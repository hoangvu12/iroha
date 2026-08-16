# Normalize Provider capacity and diagnostic evidence

Status: Complete
Blocked by: None

Define the small evidence interface shared by Inference and Usage Adapters. Include availability, authority, Capacity Scope, normalized reason, observation/freshness time, recheck time, safe numeric capacity facts, and bounded allow-listed Provider Diagnostics. Rename the probe concept from `usable` to `authenticated` without treating authentication as Routing Eligibility.

Verification covers malformed and unknown Provider fields and proves raw bodies/messages cannot enter persisted diagnostics.

## Comments

Implemented normalized Credential and Capacity Evidence plus bounded allow-listed Provider Diagnostics. Renamed successful probes to `authenticated` across persistence and HTTP contracts. Evidence: 194 focused tests passed across provider, usage, history, and HTTP seams; `bunx tsc --noEmit` passed.
