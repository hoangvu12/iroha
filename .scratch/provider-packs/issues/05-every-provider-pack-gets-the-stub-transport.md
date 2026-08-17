# 05 — Every Provider Pack gets the stub transport, structurally

**What to build:** Ticket 01 fixed one Provider that escaped the stub upstream transport. This ticket makes that class of defect impossible.

The test harness currently names each typed Inference Adapter by hand when it injects the stub transport, so adding a Provider means remembering to add a line — and forgetting it fails silently, because the tests still pass while calling the real network. Replace the hand-written list with one mechanism that applies the injected transport across the whole Pack list, and add a conformance test over that list.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] The test harness applies the injected upstream transport to every Provider Pack's adapters through one mechanism, with no per-Provider list to maintain.
- [ ] A conformance test iterates every built-in Pack and asserts its Inference Adapter and Usage Adapter resolve.
- [ ] The same test asserts that, under test construction, every Pack's adapters are the injected ones and none is the production adapter.
- [ ] The test fails if a Pack is added to the list without receiving the injected transport. Demonstrate this by temporarily excluding one Pack.
- [ ] The narrower guard added in ticket 01 is replaced by this test rather than kept alongside it.
- [ ] The suite passes with outbound network unavailable.
- [ ] No production behaviour changes.
