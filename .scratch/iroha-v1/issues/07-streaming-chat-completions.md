# 07 — Streaming Chat Completions

**What to build:** OpenAI clients can consume Chat Completion streams through Iroha with correct event flow, timeout behavior, and cancellation safety.

**Blocked by:** 05 — Single-key Chat Completions path.

**Status:** ready-for-agent

- [ ] Streaming Chat requests reach the selected Provider Connection with exact model and safe headers.
- [ ] Upstream chunks and termination semantics are delivered in OpenAI-compatible order without buffering the complete response.
- [ ] Time-to-first-byte and streaming idle timeout are distinct from non-streaming total timeout.
- [ ] Downstream disconnect immediately aborts upstream work.
- [ ] No retry or key switch occurs after any downstream response bytes have been emitted.
- [ ] Pre-stream upstream errors retain the normal OpenAI-shaped error contract.
- [ ] Deterministic tests cover normal streaming, slow first byte, idle stall, malformed termination, disconnect, and cancellation through the official SDK.

