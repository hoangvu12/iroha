# 17: Streaming resilience behind proxies

**What to build:** A streaming Caller never waits silently: if no upstream byte has arrived after a short wait, Iroha commits the response and sends keep-alive comments; failures after commitment arrive as an error event in the Caller's Shape with the Attempt summary; long pauses mid-stream are kept alive; no server-wide write or idle timeout cuts long streams. Graceful drain keeps in-flight streams alive through a restart up to a limit.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] A Request whose upstream stays silent past the budget ends with a clear error event, never a bare disconnect
- [ ] Keep-alives sent during upstream silence before and during the stream
- [ ] Before commitment, failures return proper HTTP statuses
- [ ] A 3-minute stream with long pauses completes in tests
- [ ] Drain on shutdown covered by a test
