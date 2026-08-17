# 04 — Gateway Keys read from the cache and mutate optimistically

**What to build:** Move `gateway-keys-area` onto a `['gateway-keys']` query and convert its mutations. `updateGatewayKey`, `revokeGatewayKey` and `deleteGatewayKey` become optimistic; `createGatewayKey` keeps a pending indicator because its response carries the one-time secret, which nothing can predict.

The edit path uses optimistic concurrency: the server accepts a `revision` and stores `expectedRevision + 1` (`src/keys/gateway-key-registry.ts:242`). The optimistic patch must apply the same increment, or the Owner's next edit fails a concurrency check against a stale revision.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `gateway-keys-area` reads from `['gateway-keys']`.
- [ ] `updateGatewayKey`, `revokeGatewayKey` and `deleteGatewayKey` apply optimistically and roll back on failure.
- [ ] The optimistic patch for an edit sets `revision` to the submitted revision plus one, and a second consecutive edit succeeds without an intervening refetch.
- [ ] `createGatewayKey` shows a pending indicator, and the one-time secret is still shown exactly once on success.
- [ ] A failed mutation restores the previous state and raises a toast naming the Gateway Key. No success toast is raised.
- [ ] Copy actions confirm inline — the control swaps to a check reading "Copied" for about 1.5 seconds — rather than raising a toast.
- [ ] A row's actions are disabled while its own mutation is in flight.
- [ ] On settle, mutations invalidate `['gateway-keys']` and `['audit']`.
- [ ] `bun run typecheck` passes.
