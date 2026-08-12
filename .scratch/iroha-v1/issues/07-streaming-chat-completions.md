# 07 — Streaming Chat Completions

**What to build:** OpenAI clients can consume Chat Completion streams through Iroha with correct event flow, timeout behavior, and cancellation safety.

**Blocked by:** 05 — Single-key Chat Completions path.

**Status:** complete

- [x] Streaming Chat requests reach the selected Provider Connection with exact model and safe headers.
- [x] Upstream chunks and termination semantics are delivered in OpenAI-compatible order without buffering the complete response.
- [x] Time-to-first-byte and streaming idle timeout are distinct from non-streaming total timeout.
- [x] Downstream disconnect immediately aborts upstream work.
- [x] No retry or key switch occurs after any downstream response bytes have been emitted.
- [x] Pre-stream upstream errors retain the normal OpenAI-shaped error contract.
- [x] Deterministic tests cover normal streaming, slow first byte, idle stall, malformed termination, disconnect, and cancellation through the official SDK.

## Comments

Implemented: `InferenceForwardResult` became a tagged union (`buffered`/`stream`), the generic adapter returns the live upstream body on `stream: true`, and the route pipes it through guarded by injected first-byte and idle deadlines (new `Timer` seam in `src/runtime/timer.ts`). 13 HTTP streaming tests and 2 official OpenAI SDK streaming tests added. Full suite 383 pass / 1 skip / 0 fail; typecheck clean. Retry responsibility (ticket 10) lands on `deadlineGuard(...).started()`.


