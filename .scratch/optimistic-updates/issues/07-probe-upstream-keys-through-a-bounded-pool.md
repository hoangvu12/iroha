# 07 — Probe Upstream Keys through a bounded pool

**What to build:** `#probeConnectionKeys` (`src/providers/provider-registry.ts:1676`) loops over every unverified Upstream Key and awaits a network probe for each one in turn. `addKey`, `createProvider` and `duplicate` all await it before responding, so adding a Key to a Provider holding N unverified Keys costs N sequential upstream round trips, and a bulk import of forty Keys costs forty. This is the real latency behind those mutations, and no amount of UI work removes it.

Run the probes through a bounded pool of five rather than sequentially. Unbounded parallelism is the wrong fix: forty simultaneous authentication probes against the very upstream being tested is a reliable way to earn a 429 and record forty valid Keys as rate-limited.

This is the only server-side change in the feature, and unlike the UI tickets it carries real tests.

**Blocked by:** 01

**Status:** done

- [x] `#probeConnectionKeys` probes at most five Keys concurrently.
- [x] A Provider with more unverified Keys than the pool size still has every one of them probed exactly once.
- [x] Each Key is still probed against its own effective base URL — its override when set, the Provider's otherwise.
- [x] A single probe failing does not prevent the rest from running or recording their verdicts.
- [x] Health verdicts recorded are identical to those the sequential loop produced; no test depends on probe ordering.
- [x] `bun test` reports zero failures.
- [x] Adding a Key to a Provider holding several unverified Keys is measurably faster than before.

## Comments

Implemented as a module-local `forEachWithConcurrency` helper in
`src/providers/provider-registry.ts`, mirroring the existing
`mapWithConcurrency` precedent in `src/usage/usage-service.ts` rather than
adding a dependency. Five workers share one cursor, so a slow upstream never
idles the rest of the pool, and `PROBE_CONCURRENCY = 5` carries the reasoning
for the bound.

Two things checked before changing the loop:

- **Effective base URL.** The loop never advanced shared state: it read
  `key.baseUrl ?? connection.baseUrl` from the loop variable and a Provider
  record fetched once before the loop, neither of which is mutated. Resolving it
  inside the pool callback keeps it per-Key correct.
- **Verdict recording.** Each verdict is a single-row `updateKey` by primary key,
  with the patch computed by `probedPatch` from the Key's pre-pass snapshot. No
  read-modify-write, no shared accumulator, disjoint rows — concurrent
  completion cannot interleave into a corrupt state or lose a write. The
  sequential loop relied on ordering for nothing, so behaviour is unchanged.
  (`recordInferenceFailure` already writes Key Health through `Promise.all`, so
  concurrent Key writes were an accepted pattern here.)

The failure path changed deliberately: a throw used to abandon the remaining
Keys. The pool now collects failures, lets every Key take its turn, and re-raises
the first one afterwards — so an unexpected internal error still surfaces to the
caller, but never before the verdicts already earned have been written.

Tests: `test/http/upstream-key-probe-pool.test.ts` (5 tests, HTTP seam,
`createTestApp({ upstreamKeyProbe })`). Measured on the `addKey` path with a
30 ms probe and 12 unverified Keys: **565 ms sequential → 139 ms pooled** (~4x;
ideal is ceil(12/5) x 30 ms). Narrowing the pool to 1 or widening it to 100 both
fail the suite, so the bound is genuinely under test.
