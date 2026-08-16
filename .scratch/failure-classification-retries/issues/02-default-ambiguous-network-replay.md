# Opt-in bounded ambiguous network replay

Status: In progress
Blocked by: 01

## Acceptance

- [x] New Providers default ambiguous network replay off.
- [x] The Owner can enable replay for buffered requests.
- [x] At most one same-key replay occurs within attempt and total-time budgets for buffered requests.
- [ ] No replay occurs after a response has started.
- [x] A stable idempotency value is reused only when the adapter declares generation safe.
- [ ] Owner-facing copy and telemetry disclose ambiguity and duplicate-request risk.
- [x] Focused HTTP tests pass.

## Comments

Owner copy now discloses duplicate-request/charge risk. Telemetry still has only the generic retry counter. Streaming transport failures are currently collapsed to HTTP 502 and can bypass the Owner setting; keep this ticket open until transport and status retry remain separate through the streaming helper and the response-start invariant has HTTP coverage.
