# 04 — Gateway Keys read from the cache and mutate optimistically

**What to build:** Move `gateway-keys-area` onto a `['gateway-keys']` query and convert its mutations. `updateGatewayKey`, `revokeGatewayKey` and `deleteGatewayKey` become optimistic; `createGatewayKey` keeps a pending indicator because its response carries the one-time secret, which nothing can predict.

The edit path uses optimistic concurrency: the server accepts a `revision` and stores `expectedRevision + 1` (`src/keys/gateway-key-registry.ts:242`). The optimistic patch must apply the same increment, or the Owner's next edit fails a concurrency check against a stale revision.

**Blocked by:** 02

**Status:** done

- [x] `gateway-keys-area` reads from `['gateway-keys']`.
- [x] `updateGatewayKey`, `revokeGatewayKey` and `deleteGatewayKey` apply optimistically and roll back on failure.
- [x] The optimistic patch for an edit sets `revision` to the submitted revision plus one, and a second consecutive edit succeeds without an intervening refetch.
- [x] `createGatewayKey` shows a pending indicator, and the one-time secret is still shown exactly once on success.
- [x] A failed mutation restores the previous state and raises a toast naming the Gateway Key. No success toast is raised.
- [x] Copy actions confirm inline — the control swaps to a check reading "Copied" for about 1.5 seconds — rather than raising a toast.
- [x] A row's actions are disabled while its own mutation is in flight.
- [x] On settle, mutations invalidate `['gateway-keys']` and `['audit']`.
- [x] `bun run typecheck` passes.

## Comments

Per `docs/agents/ui-testing.md` this ships without browser tests. `bun test`
stays at 1144 pass / 2 skip / 0 fail across 89 files; nothing under `src/` or
`test/` changed.

Three decisions worth recording:

**The edit dialog closes on submit.** An optimistic patch behind an open modal
is invisible, which defeats the point. The row redrawing is the confirmation;
a refusal rolls the row back and toasts. The cost is that the Owner's typed
input is gone if the Gateway refuses — accepted, because the toast carries the
reason and a `gateway_key_conflict` is worded to send the Owner back in.

**A failed creation reports inline, not as a toast.** The convention's toast
exists to reach an Owner who has moved on from a row; creation has no row yet
and its dialog is still open in front of the Owner with the input in it. The
inline alert stays where the form is.

**The plaintext credential never enters the query cache.** `onSuccess` writes
the created key stripped of its `secret`. The cache outlives the dialog, so a
secret written into it would be re-servable on a later render, and "shown
exactly once" would stop being true.

The Providers list is read through `useQuery` on `queryKeys.providers()` inside
`gateway-keys-area`, sharing ticket 03's cache entry without depending on its
files. Ticket 03 has since added `ui/src/lib/use-providers.ts` exporting an
identical `useProviders()`; collapsing the four duplicated lines onto it is a
safe follow-up once both tickets have landed.
