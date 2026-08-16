# Typed failure classification and generic 402 fallback

Status: In progress
Blocked by: none

## Acceptance

- [x] Inference Adapter exposes a small typed failure-classification interface.
- [x] The route uses the classification without Provider-specific status/body knowledge for buffered responses.
- [x] An unknown 402 tries at most one alternate Upstream Key.
- [x] An unknown 402 does not durably exhaust the failed key or account.
- [ ] Attempt history records the bounded trail.
- [x] Focused HTTP tests pass.

## Comments

Streaming non-2xx classification still loses the Provider response body. Keep this ticket open until the streaming helper returns typed pre-response failures/body evidence and request-history assertions cover the attempt trail.
