# 40: An auth refusal on one Endpoint should not mark the key invalid everywhere

**What to build:** A key works on every Endpoint of its Provider unless restricted (ticket 09). When the Owner adds a second Endpoint (for example a DashScope region) and forgets to restrict keys that only work on the first, an Attempt on the new Endpoint answers 401/403 and the generic rule marks the key `invalid` for the whole Provider, taking it out of traffic on the Endpoint where it works. Decide whether `invalid` should be scoped to the key-and-Endpoint pair when the key has succeeded on another Endpoint (or is otherwise known good there), similar to how cooling can be scoped to key-and-model, or whether restricting keys is enough and the UI should instead warn when an Endpoint is added to a Provider with unrestricted keys.

**Blocked by:** none

**Status:** needs-decision (raised with the Owner 2026-11-19, not yet answered)

- [ ] Decision recorded here
- [ ] If built: gateway test where a key valid on Endpoint A gets 401 on Endpoint B and keeps serving A
