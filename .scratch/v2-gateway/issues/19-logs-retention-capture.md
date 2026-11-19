# 19: Logs everywhere, retention and prompt capture

**What to build:** Every meaningful event (Attempt, rule match, Key State change, Model Gap, discovery run, job run, configuration change, startup, shutdown) is a structured log event readable through the logs API, filterable by time, level, kind, Request and Provider. Gateway Keys get a capture switch that stores full prompts and responses for their Requests. Retention is configurable per kind (history and logs 30 days, captures 3 days by default) and enforced by an hourly job.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Every event kind listed above appears in the logs API with Request and Provider links
- [ ] Capture on stores bodies (streams reassembled); capture off stores none
- [ ] Retention settings changeable via the API; the hourly job deletes expired data and logs its run
