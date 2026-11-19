# 18: Model Pools

**What to build:** Agents create Model Pools (name without a slash, ordered members of Provider and model, optional budget override). A Caller naming a Pool on the global routes is served by the first member with a candidate, failing over down the list within the Request's budget. Gateway Key scopes can include Pools. `/v1/models` lists the Pools a key may use, with metadata taken from the first member. The response echoes the Pool name; the Attempt records the serving Provider and model.

**Blocked by:** 12

**Status:** ready-for-agent

- [ ] Failover across members within the shared budget
- [ ] Reordering members changes routing on the next Request
- [ ] Pool scope on Gateway Keys enforced with the uniform refusal
- [ ] Pool names cannot collide with each other; changes are audited
- [ ] Route preview API: for a Pool or `provider/model` (optionally as a Gateway Key) returns members, Endpoints and keys in try order, each skipped key with its reason and until-time, using the same planner as live traffic and sending nothing
- [ ] Members can be switched off without removing them; switched-off members are reported, not planned
