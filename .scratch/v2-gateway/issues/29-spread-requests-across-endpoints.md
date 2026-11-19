# 29: Spread Requests across a Provider's Endpoints

**What to build:** Within one tier the planner pairs each key with the tier's Endpoints in creation order (`planner/planner.go`, `planTier`), so with unrestricted keys, or one keyless key over several relay URLs, every Request's first Attempt goes to the first Endpoint. v1 spread traffic because each key carried its own base URL (catalog PRV-03, PRV-08). Decide whether same-Shape Endpoints of a Provider are a preference order or a pool. If a pool: rotate the Endpoint start per Request (a second round-robin group per Provider in `planner.Counter`, also read by `Counter.Peek` in the route preview), keeping the key order rules of ticket 26 (health, then carriers). Data imported from v1 (keys restricted to one Endpoint each, ticket 27) already spreads, so this only affects new setups.

**Blocked by:** none

**Status:** needs-decision (preference order or pool)

- [ ] Decision recorded in `docs/agents/architecture.md` ("The inference path", step 2)
- [ ] If pool: planner table case and a gateway test showing two Endpoints each receive first Attempts; route preview shows the next Request's start
