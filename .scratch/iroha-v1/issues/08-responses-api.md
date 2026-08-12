# 08 — Responses API and streaming events

**What to build:** OpenAI clients can use non-streaming and streaming Responses through an explicit Provider Connection without losing tools, structured output, cancellation, or idempotency safety.

**Blocked by:** 05 — Single-key Chat Completions path; 07 — Streaming Chat Completions.

**Status:** ready-for-agent

- [ ] Non-streaming Responses preserve exact models, supported request fields, tools, structured output, and provider extensions.
- [ ] Streaming Responses preserve event ordering and termination expected by the official OpenAI client.
- [ ] Caller cancellation aborts upstream work for both response modes.
- [ ] Caller-supplied idempotency values are preserved through an attempt.
- [ ] Operations not known to be idempotent are not automatically replayed without adapter-declared safe behavior.
- [ ] No retry occurs after streamed bytes begin.
- [ ] Errors use the same sanitized OpenAI/Iroha contract as Chat Completions.
- [ ] Official SDK tests cover stored/non-stored request behavior, tools, structured output, streaming, cancellation, and malformed events.

