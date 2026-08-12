# 09 — Round-robin key pools and Upstream Accounts

**What to build:** A Provider Connection can use multiple eligible Upstream Keys predictably and can understand when several keys share one account's capacity.

**Blocked by:** 05 — Single-key Chat Completions path.

**Status:** done

- [x] The Owner can add, test, disable, and remove multiple Upstream Keys on one Provider Connection.
- [x] Each key can allow all connection models by default and optionally allow or exclude exact models.
- [x] The Owner can create an optional Upstream Account and assign keys that share Provider billing or capacity.
- [x] The UI clearly explains shared-account behavior and keeps independent keys ungrouped by default.
- [x] Eligible Active keys are selected round-robin for each request.
- [x] Selection excludes disabled, unverified, model-ineligible, and otherwise unavailable candidates.
- [x] The round-robin cursor may reset on restart without affecting durable configuration.
- [x] Concurrent deterministic tests prove fair atomic selection without persisting a write per inference request.
