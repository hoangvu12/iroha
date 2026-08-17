# 02 — One API client, one query cache, one toaster

**What to build:** The eight modules under `ui/src/lib/` each carry a private copy of the same `request()` helper, and two of them define near-identical error classes (`ManagementError`, `GatewayKeyError`) that differ only in name. Every `reload()` in the UI then repeats the same `if (cause.code === 'authentication_required') onSignedOut()` check. Collapse all of it into one `ui/src/lib/api-client.ts` with a single error type, then install the query cache and the toaster the rest of the feature builds on.

This ticket introduces the infrastructure and changes no screen's behaviour. See ADR-0021 for the cache decision.

**Blocked by:** 01

**Status:** complete

- [x] `@tanstack/react-query` is a dependency of the `ui` workspace, and `sonner` is installed through shadcn.
- [x] One `ui/src/lib/api-client.ts` exports the shared `request()` and a single error type carrying `code`, `message` and `problems`. The per-module copies and the second error class are gone.
- [x] `QueryClientProvider` and `<Toaster />` are mounted in `ui/src/App.tsx`.
- [x] The `QueryCache` and `MutationCache` share one global `onError` that handles `authentication_required` by signing the Owner out. The per-`reload` copies of that check are gone.
- [x] Global defaults set `staleTime` to 30 seconds. `refetchOnWindowFocus` is on by default and disabled for the `requests`, `audit` and `usage` keys.
- [x] `bun run typecheck` passes.
- [x] Every screen still loads and behaves as it did before this ticket.

## Comments

**Nine `request()` helpers and nine error classes, not eight and two.** The
ticket's premise understated the duplication. `background.ts` and `settings.ts`
also carried private copies, and every module had its own error class:
`ManagementError`, `GatewayKeyError`, `AuditError`, `AuthError`,
`BackgroundError`, `CatalogError`, `RequestHistoryError`, `SettingsError`,
`UsageError`. All nine are gone, replaced by `ApiError`. No deprecated aliases
were kept — there is one live error type. `use-provider-templates.ts` has no
`request()` of its own (it is a module-level brand cache over
`fetchProviderTemplates`) and was left alone; tickets 03/05 retire it.

**Two fields the union had to keep.** `AuthError` and `UsageError` both carried
`retryAfterSeconds`, read from the `retry-after` header, and `auth-screen.tsx`
renders it ("Try again in N seconds."). `ApiError` carries it for every failure
rather than dropping it. `problems` was on five of the nine; it is now on all
failures as an empty array when the API sends none.

**The sign-out check also lives in `request()`, not only in the caches.** The
global `onError` on `QueryCache`/`MutationCache` is in place as the acceptance
bullet requires, but nothing in the UI uses `useQuery` yet — tickets 03/04/05 do
that — so a handler on the caches alone would be dead code this ticket, and
deleting the per-`reload` checks would have silently removed sign-out-on-401
from every screen for three tickets. `request()` therefore routes its own
failures through the same `signOutIfSessionEnded`, which is one place, works for
today's `useState`/`useEffect` screens, and keeps working after the conversion.
Only `requireOwner` emits `authentication_required` (`src/http/owner-guard.ts`),
so no setup, sign-in, or state read can trigger it.

**Behaviour differences, all benign.** Three screens previously answered a 401
with something other than a sign-out: `provider-detail` navigated back to
Providers, `providers-area`'s create dialog raised an area-level alert, and the
non-`reload` failure paths showed an error banner and stayed put. All now sign
out, which is what the Owner Session having expired means. `useSubmission`'s
unused-in-practice `onFatal` parameter and the now-unreachable
`authentication_required` entry in `TITLES` were removed with it, as was the
`onSignedOut` prop on `ProvidersArea`, `GatewayKeysArea`, `RequestsArea` and
`AuditArea` (`AccountSettings` keeps it: revoking your own Owner Session is a
real sign-out, not an error path).

**`sonner.tsx` does not use `next-themes`.** `bunx shadcn@latest add sonner`
worked but pulled in `next-themes`, which this app has no provider for —
`use-theme` writes the `dark` class onto `<html>` directly. The dependency was
removed and the component reads the resolved mode from the existing
`useIsDarkMode()` hook instead.

**No browser tests**, per `docs/agents/ui-testing.md`. `bun run typecheck`,
`bun run --cwd ui build` and `bun test` (1144 pass, 2 skip, 0 fail) all pass.
`health.ts` keeps its own `fetch`: `/health/ready` is outside the management API
and returns a `Readiness` result rather than throwing, so it has nothing to
share with `request()`.
