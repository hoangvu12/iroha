# 25: Requests page

**What to build:** A live feed of Requests with filters by caller, Provider or Pool, model, status and time range. Each row shows caller, requested model, serving Provider, Endpoint and wire model, Shape in and out, status, time to first token, total time, tokens and Attempt count. The detail view shows the one-line summary, each Attempt with its key, Endpoint, status, matched Failure Rule, action, error body and headers, related log events, and captured prompt and response when capture was on.

**Blocked by:** 21, 19

**Status:** ready-for-agent

- [ ] New Requests appear without reloading
- [ ] Filters combine and are reflected in the URL
- [ ] Detail links to the key and Provider involved
