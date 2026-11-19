# 40: An auth refusal on one Endpoint should not mark the key invalid everywhere

**What to build:** A key works on every Endpoint of its Provider unless restricted (ticket 09). When the Owner adds a second Endpoint (for example a DashScope region) and forgets to restrict keys that only work on the first, an Attempt on the new Endpoint answers 401/403 and the generic rule marks the key `invalid` for the whole Provider, taking it out of traffic on the Endpoint where it works. Decide whether `invalid` should be scoped to the key-and-Endpoint pair when the key has succeeded on another Endpoint (or is otherwise known good there), similar to how cooling can be scoped to key-and-model, or whether restricting keys is enough and the UI should instead warn when an Endpoint is added to a Provider with unrestricted keys.

**Blocked by:** none

**Status:** done

- [x] Decision recorded here
- [x] If built: gateway test where a key valid on Endpoint A gets 401 on Endpoint B and keeps serving A

## Comments

**Decision (Owner, 2026-11-19): build it.** An `invalid` verdict on one Endpoint, for a key that has worked on another Endpoint of the same Provider, records an **Endpoint Gap** (key and Endpoint, no expiry) instead of making the key invalid. The key is skipped on that Endpoint only and keeps serving the others; the refused Request moves on as with `retry_elsewhere`. A key with no success elsewhere goes invalid as before. Cleared by the Owner, by a secret or Endpoint-restriction edit, by a passing key test on that Endpoint. Shown in the Keys table, the key dialog (with "Restrict to working Endpoints"), the route preview (skip `endpoint_gap`), logs, API, skill, OpenAPI; glossary term added.

Implemented on `agent/t40` (details in `docs/agents/architecture.md`, "Ticket 40: Endpoint Gaps"; tests in `internal/gateway/endpointgaps_test.go`):

- **"Has worked"**: table `key_endpoint_successes` (migration `40_01_endpoint_gaps.sql`, with `endpoint_gaps`), the latest 2xx Attempt or passing key test per key and Endpoint, written at most once a minute per pair like `last_used_at` (the routing view carries it, so a recent success costs no write). Only Endpoints the key may still use and has no gap on count. A new secret forgets them.
- **Owner rules**: the refinement is in `keystate.Store.Fail`, so any rule whose outcome is `invalid` behaves the same, built-in or the Owner's (`TestAnOwnerRuleSayingInvalidAlsoMakesAnEndpointGap`). No reason found to differ: the rule says the key was refused; where it was refused is the same evidence either way. Keyless 401s stay `retry_elsewhere` (`noCredential` runs first).
- **Going invalid clears the gaps**: a key refused on the last Endpoint it worked on becomes invalid and loses its Endpoint Gaps (the refusals were the key's, e.g. a suspended account), so a later passing test leaves no stale gaps. With N Endpoints this costs at most one extra Attempt per Endpoint before the key is invalid.
- **Also cleared** by a successful Attempt on the gapped Endpoint (only a test chat pinned to that key and Endpoint gets there), as evidence that disproves the gap. Rename and enable/disable do not clear.
- **Restrict to working Endpoints** (`POST .../keys/{key}/restrict-to-working-endpoints`, and bulk): restriction = the Endpoints the key may use now (all of them for an unrestricted key) minus the gapped ones, applied through the normal key edit, which clears the gaps in the same Audit Entry; one revert restores the old restriction and the gaps. `unchanged` without gaps; 409 `no_working_endpoint` when nothing would remain.
- **Attempt record**: outcome stays `invalid` (the rule's verdict, so rule hit counts and replays are unchanged); the action says "Endpoint Gap on <endpoint>", which the UI reads in `attempt-info.ts`.
- Key tests without `?endpoint=` now use the first Endpoint the key may use and has no gap on.
- Not done: deleting an Endpoint drops its gaps and success rows (cascade), and reverting that delete does not bring them back (runtime state). No UI warning when an Endpoint is added to a Provider with unrestricted keys (the gap makes it unnecessary).
