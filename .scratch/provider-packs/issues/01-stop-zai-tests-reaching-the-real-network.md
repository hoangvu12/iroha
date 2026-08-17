# 01 — Stop Z.ai tests reaching the real network

**What to build:** The assembled-app test harness constructs each typed Inference Adapter with the stub upstream transport, but the Z.ai one was never added to that list. Every assembled test that exercises a Z.ai Provider therefore issues real network calls through the runtime's own `fetch`, so those tests prove nothing and may hit a live upstream. Inject the stub transport into the Z.ai Inference Adapter, and add a guard so this cannot pass silently again.

This is a live defect, independent of the rest of this feature. It should land before the other tickets so their tests can be trusted.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The test harness builds the Z.ai Inference Adapter with the same stub upstream transport it gives the generic, Anthropic, DashScope and MiniMax adapters.
- [ ] A test drives inference against a Z.ai Provider through the assembled app and asserts the call was recorded by the stub transport.
- [ ] A test fails if the harness constructs any built-in typed Inference Adapter without the stub transport. Point it at the current set; ticket 05 makes it structural.
- [ ] No test in the suite performs a real network call. Verify by running the suite with outbound network unavailable.
- [ ] No production behaviour changes.
