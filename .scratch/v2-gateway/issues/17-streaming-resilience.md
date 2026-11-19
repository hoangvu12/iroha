# 17: Streaming resilience behind proxies

**What to build:** A streaming Caller never waits silently: if no upstream byte has arrived after a short wait, Iroha commits the response and sends keep-alive comments; failures after commitment arrive as an error event in the Caller's Shape with the Attempt summary; long pauses mid-stream are kept alive; no server-wide write or idle timeout cuts long streams. Graceful drain keeps in-flight streams alive through a restart up to a limit.

**Blocked by:** 05

**Status:** done

- [x] A Request whose upstream stays silent past the budget ends with a clear error event, never a bare disconnect
- [x] Keep-alives sent during upstream silence before and during the stream
- [x] Before commitment, failures return proper HTTP statuses
- [x] A 3-minute stream with long pauses completes in tests
- [x] Drain on shutdown covered by a test

## Comments

- `internal/gateway/stream.go`: a keeper goroutine runs beside the budget loop for streaming Requests. With no upstream answer 10 s (`StreamCommitAfter`) after arrival it commits 200 + `text/event-stream` + a keep-alive; any 15 s (`KeepAliveEvery`) of silence, before or during the stream, sends another. All Caller writes go through `exchange.mu`. After commitment (or once a relayed stream began) `x.fail` sends the Shape's error event carrying the same envelope as the HTTP error (code, hint, request_id, `details.attempts`, `summary`); the Request records status 200 with the error code. A broken upstream stream now ends with `upstream_stream_broken`; a non-stream answer after commitment with `upstream_not_streamed`.
- Per-Shape seam: `streamShape` (`keepAlive`, `errorEvent`) in `streamShapes`; only OpenAI Chat exists (`: keep-alive` comment, `data: {"error": ...}` with no `[DONE]`). Tickets 13–15 add one implementation each (Anthropic would use `event: ping` / `event: error`).
- Drain: `Gateway.Abort` (`shutdown.go`) tracks in-flight Requests; when the drain limit runs out the server aborts them (cause `ErrShuttingDown`, 503 `shutting_down` or an error event), gives them up to 2 s to answer and be recorded, then closes connections. `shutdown` log gets `requests_ended`. The HTTP server has no read/write/idle timeout (white-box test guards it).
- Tests: `internal/gateway/stream_test.go` (fake clock; the 3-minute stream takes ~50 ms), `internal/server/drain_test.go` (stream finishes during drain with keep-alives; stream outliving the limit gets `shutting_down`, recorded as such after restart).
- Not done: no idle limit mid-stream (a stalled-but-open upstream connection is kept alive until the Caller leaves); the spec asks for none and long thinking pauses must survive. Commit and keep-alive intervals are constants, not settings.
