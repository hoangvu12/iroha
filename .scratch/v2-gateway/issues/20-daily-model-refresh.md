# 20: Daily model refresh job

**What to build:** Each enabled Provider's model list refreshes once a day, with start times spread across the day rather than at startup. Each run is logged. No job ever changes or deletes Upstream Keys. Agents can see the schedule and last result per Provider through the API.

**Blocked by:** 10, 19

**Status:** ready-for-agent

- [ ] Refresh times spread deterministically across Providers
- [ ] Startup does not trigger a burst of refreshes
- [ ] Last run time and outcome per Provider visible through the API
