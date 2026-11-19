# 39: Test that a slow Caller slows the upstream read

**What to build:** The relay reads one upstream event and blocks on writing it to the Caller (`relayStream`, `relayTranslatedStream` in `internal/gateway/attempt.go`), so a Caller that stops reading stops the upstream read and memory stays bounded (catalog REQ-68, TIME-10). The behaviour is right by construction but untested, and a future buffering change could break it silently. Add a gateway test: the fake upstream streams tens of MB in many chunks while the Caller reads nothing for a while; assert the bytes the fake managed to write stay bounded (well under the total), then that the Caller still receives the whole stream once it reads. Needs a way to see how far the fake got (a counter in a small testkit addition) and must not depend on real-time sleeps beyond a short bounded wait.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Test passes reliably (run with `-count=20`), passthrough and translated
