# 07 — Probe Upstream Keys through a bounded pool

**What to build:** `#probeConnectionKeys` (`src/providers/provider-registry.ts:1676`) loops over every unverified Upstream Key and awaits a network probe for each one in turn. `addKey`, `createProvider` and `duplicate` all await it before responding, so adding a Key to a Provider holding N unverified Keys costs N sequential upstream round trips, and a bulk import of forty Keys costs forty. This is the real latency behind those mutations, and no amount of UI work removes it.

Run the probes through a bounded pool of five rather than sequentially. Unbounded parallelism is the wrong fix: forty simultaneous authentication probes against the very upstream being tested is a reliable way to earn a 429 and record forty valid Keys as rate-limited.

This is the only server-side change in the feature, and unlike the UI tickets it carries real tests.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `#probeConnectionKeys` probes at most five Keys concurrently.
- [ ] A Provider with more unverified Keys than the pool size still has every one of them probed exactly once.
- [ ] Each Key is still probed against its own effective base URL — its override when set, the Provider's otherwise.
- [ ] A single probe failing does not prevent the rest from running or recording their verdicts.
- [ ] Health verdicts recorded are identical to those the sequential loop produced; no test depends on probe ordering.
- [ ] `bun test` reports zero failures.
- [ ] Adding a Key to a Provider holding several unverified Keys is measurably faster than before.
