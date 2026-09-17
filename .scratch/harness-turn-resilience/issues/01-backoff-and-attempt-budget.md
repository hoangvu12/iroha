# Exponential backoff with jitter for same-key retries

Status: In progress
Blocked by: none

## Acceptance

- [x] Same-key retries sleep an exponential delay with jitter instead of a fixed 100ms. `retryBackoffMs` in `src/http/inference.ts`.
- [x] A Provider-supplied `Retry-After` (or adapter-supplied retry timing) is honored over the exponential when it is larger, capped per sleep.
- [x] The delay is computed from the attempt number, not a literal.
- [ ] `retryMaxAttempts` bounds same-key attempts per key, not a separate hard cap of one. **Deferred**: raising same-key repeats changes duplicate-request/cost semantics; needs an explicit decision.
- [x] No retry happens after response bytes are exposed (unchanged).
- [x] Focused HTTP tests assert a bounded, jittered delay and pass.

## Comments

Implemented the backoff half only. Sleep call sites now `retryBackoffMs(index, classification.retryAfterSeconds)` for `retry_same` and `retryBackoffMs(index)` for ambiguous network. The `sameKeyRetries < 1` cap is untouched on purpose: revisiting the pool in rounds (ticket 02) is the mechanism for "keep trying", and it is the part that needs a cost/duplicate decision.

## Notes

Six literal `retrySleep(100, ...)` call sites:
`src/http/inference.ts:950`, `:1026`, `:1127` (OpenAI) and `:1562`, `:1642`, `:1739` (Anthropic).
The `retrySleep` seam is declared at `src/http/inference.ts:123`; the delay must be computed at the call site or the seam signature extended.