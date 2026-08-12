# 11 — Usage Adapter and entitlement visibility

**What to build:** The Owner can distinguish unknown generic capacity from authoritative provider-specific credit or plan usage, and that evidence can safely influence Key Health.

**Blocked by:** 06 — Model catalog and scoped Models API; 10 — Scoped retries and durable Key Health.

**Status:** ready-for-agent

- [ ] Generic OpenAI-compatible connections expose `reactive_only` usage visibility and report authoritative remaining balance as Unknown.
- [ ] Typed Usage Adapters can normalize credit and subscription/coding-plan usage without assuming one Provider billing shape.
- [ ] Normalized results include units, Capacity Scope, freshness, reset time, authority/confidence, and raw-provider diagnostic boundaries.
- [ ] Confirmed zero remains distinct from Unknown and from a temporarily failed poll.
- [ ] Usage is fetched after relevant configuration changes, periodically, and through a manual Refresh action.
- [ ] Polling respects Provider limits, backs off, retains the last successful result, and displays the latest error separately.
- [ ] Authoritative recovery can reactivate an Exhausted or Cooling Down scope without a paid inference probe.
- [ ] UI and mock-adapter tests cover credit, plan windows, shared accounts, reset, stale results, unknown visibility, and recovery.

