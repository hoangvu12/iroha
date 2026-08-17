# 02 — One API client, one query cache, one toaster

**What to build:** The eight modules under `ui/src/lib/` each carry a private copy of the same `request()` helper, and two of them define near-identical error classes (`ManagementError`, `GatewayKeyError`) that differ only in name. Every `reload()` in the UI then repeats the same `if (cause.code === 'authentication_required') onSignedOut()` check. Collapse all of it into one `ui/src/lib/api-client.ts` with a single error type, then install the query cache and the toaster the rest of the feature builds on.

This ticket introduces the infrastructure and changes no screen's behaviour. See ADR-0021 for the cache decision.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `@tanstack/react-query` is a dependency of the `ui` workspace, and `sonner` is installed through shadcn.
- [ ] One `ui/src/lib/api-client.ts` exports the shared `request()` and a single error type carrying `code`, `message` and `problems`. The per-module copies and the second error class are gone.
- [ ] `QueryClientProvider` and `<Toaster />` are mounted in `ui/src/App.tsx`.
- [ ] The `QueryCache` and `MutationCache` share one global `onError` that handles `authentication_required` by signing the Owner out. The per-`reload` copies of that check are gone.
- [ ] Global defaults set `staleTime` to 30 seconds. `refetchOnWindowFocus` is on by default and disabled for the `requests`, `audit` and `usage` keys.
- [ ] `bun run typecheck` passes.
- [ ] Every screen still loads and behaves as it did before this ticket.
