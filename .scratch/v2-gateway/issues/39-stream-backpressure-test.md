# 39: Test that a slow Caller slows the upstream read

**What to build:** The relay reads one upstream event and blocks on writing it to the Caller (`relayStream`, `relayTranslatedStream` in `internal/gateway/attempt.go`), so a Caller that stops reading stops the upstream read and memory stays bounded (catalog REQ-68, TIME-10). The behaviour is right by construction but untested, and a future buffering change could break it silently. Add a gateway test: the fake upstream streams tens of MB in many chunks while the Caller reads nothing for a while; assert the bytes the fake managed to write stay bounded (well under the total), then that the Caller still receives the whole stream once it reads. Needs a way to see how far the fake got (a counter in a small testkit addition) and must not depend on real-time sleeps beyond a short bounded wait.

**Blocked by:** none

**Status:** done

- [x] Test passes reliably (run with `-count=20`), passthrough and translated

## Comments

`testkit.Upstream.Written()` counts reply body bytes the fake has flushed to its connections. `gateway TestASlowCallerSlowsTheUpstreamRead`: an OpenAI Chat fake streams 1,538 events (48 MiB); the Caller (a raw `http.Client`, so nothing reads the body) gets its 200 and reads nothing; the test polls `Written` until it has not changed for 300 ms (at most 10 s) and asserts it is under a third of the total (it stalls at 0.5 to 1 MB, about 1%, the socket buffers); then the Caller reads everything (every piece, the stream's last event) and the fake has written it all. Passthrough (`/v1/chat/completions`) and translated (`/v1/messages` to the Chat Endpoint). `-count=20`: 20/20 pass, about 1.8 s per run.
