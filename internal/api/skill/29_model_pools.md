## Model Pools

A Model Pool is one model name Callers send to the global routes (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1beta/models/<pool>:generateContent`), served in order by members, each a model on one Provider. Use one for cross-Provider failover under a stable name.

```
PUT   /api/pools/glm-4.6  {"members": [{"provider": "zai", "model": "glm-4.6"}, {"provider": "chutes", "model": "zai-org/GLM-4.6"}]}   create it, or replace its members
PATCH /api/pools/glm-4.6  {"members": [...]}                       replace the list: reorder, add, remove, or "enabled": false to switch one off
PATCH /api/pools/glm-4.6  {"budget": {"max_attempts": 4, "first_byte_seconds": 90}}   0 restores the Providers' own
GET   /api/route-preview?model=glm-4.6[&shape=anthropic-messages][&as=<gateway key>]
```

- **Routing**: members are tried top to bottom. Each switched-on member whose Provider is enabled and offers the model contributes its usable keys (planned exactly as on the Provider's own route); when they all fail or are skipped, the next member's are tried. One Request budget covers all members: the Pool's override if set, else the first serving Provider's Attempt count and each Provider's first-byte wait, counted from the Request's arrival and never over 95 s. A new member order applies to the next Request.
- **Answers and history**: the answer's model reads the Pool name; the Request records `pool`, and each Attempt the Provider and `wire_model` that served it (`GET /api/requests?pool=glm-4.6`). When no member can be planned (all off, Providers disabled, models hidden) the Caller gets `503 no_candidate` naming each member's reason.
- **Names**: no slash, unique across Pools whatever their case (`POST /api/pools` refuses a name in use with `409 name_taken`), stable while members change. `maker` (for the logo) is guessed from the model name unless you set it, to a maker ID (`openai`) or a website (`chatgpt.com`).
- **Gateway Keys**: `{"scope": {"pools": ["glm-4.6"], "providers": [...]}}`. A Pool in scope is usable through every member, whatever Providers the key names; scope `all` includes every Pool. A Pool outside the scope is refused exactly like one that does not exist (`400 invalid_model_id`). `GET /v1/models` lists the key's Pools first, each with its first switched-on member's metadata. A Pool an unrevoked key names cannot be deleted (`409 pool_in_use`).
- **Route preview** (`GET /api/route-preview`): for a Pool or `<provider>/<model>`, every member in order (switched-off and unusable ones with `not_planned` and why), each member's candidates (Endpoint, key, wire model, whether translated) in the order the next Request would try them, and each key left out with its `reason` (`cooling`, `cooling_model`, `model_gap`, `disabled`, `invalid`, `restricted`) and `until`/`seconds_left`. `outcome` holds the error a Caller would get before any Attempt (out of scope with `as`, everything cooling...). It sends nothing and changes nothing; use it after every routing change.
