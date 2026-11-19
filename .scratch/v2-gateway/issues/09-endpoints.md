# 09: Multiple Endpoints per Provider

**What to build:** A Provider can have several Endpoints, each with URL (including its version path), Shape, auth style (bearer, `x-api-key`, custom header, query parameter, none), static headers, and optional model renames applied per Attempt after the Endpoint is chosen. Upstream Keys can be restricted to some Endpoints; keys may have empty secrets for keyless Endpoints, which send no auth header. Candidate planning prefers Endpoints that speak the Caller's Shape (translation itself arrives in 13–15; until then only same-Shape Endpoints are candidates).

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] A key restricted to some Endpoints is never sent to others
- [ ] Renames apply per Attempt, so failover to a differently named Endpoint sends the right wire model
- [ ] Keyless Endpoints send no auth header; key test uses each auth style correctly
- [ ] Endpoint changes write Audit Entries
