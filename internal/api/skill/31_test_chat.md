## Testing a model (the test chat API)

`POST /api/test` sends one chat turn through the Gateway exactly as a Caller of the chosen Shape would: the global route, translation, Failure Rules, Key States, the budget. Use it to check a Provider, a Pool, one Upstream Key or one Endpoint after a change, or what a Gateway Key can reach. The UI's chat panel uses the same calls.

```
POST /api/test   {"model": "acme/qwen3-max", "messages": [{"role": "user", "content": "Hi"}]}
POST /api/test   {"model": "glm-4.6", "shape": "anthropic-messages", "reasoning": "high", "stream": false}
POST /api/test   {"model": "acme/qwen3-max", "upstream_key": "team-3", "endpoint": "intl"}     every Attempt on that key and Endpoint
POST /api/test   {"model": "glm-4.6", "as": "zeron-fleet", "tools": ["get_weather", "calculate"]}   that key's scope applies
GET  /api/test/tools                               the test tools: name, description, JSON schema
GET  /api/test/models?q=qwen&as=zeron-fleet        Pools first, then <provider>/<model>, with counts
GET  /api/test/models?prefer=acme/                  acme's models first; suggested: the model to test acme with
GET  /api/test/snippets?model=glm-4.6&shape=openai-chat&as=zeron-fleet&tools=calculate,web_search   curl, Python and TypeScript for the same request
```

- **Recorded as** the Caller `Test`, or `Test (as <name>)` with `as` (`caller.kind` `test`; `GET /api/requests?caller_kind=test`). A test sent as a Gateway Key uses its scope (a model outside it gets the refusal that key would get) but never counts as its traffic: not in `recent_requests`, `last_used_at` or `caller=<key ID>`. Test Requests are always captured.
- **The answer** is the Gateway's own, in the Shape: its server-sent events (`stream` defaults to true) or JSON, its error envelope on failure, and `x-request-id`. Read `GET /api/requests/{request}` for the serving key, Endpoint, timings, tokens and, on failure, every Attempt with its Failure Rule and what it did to the key.
- **Pins** (`upstream_key`, `endpoint`, by name or ID) need `<provider>/<model>` (`400 pin_needs_provider` for a Pool) and narrow every Attempt to that key and/or Endpoint. A pinned key is tried whatever its Key State (disabled, invalid, cooling, Model Gaps), as key tests do; a failure still changes its Key State, a success ends its cooling.
- **Reasoning** (`off`, `low`, `medium`, `high`) is written in the Shape's own field, so it reaches the Provider translated like any Caller's.
- **Test tools**: `tools: [...]` offers made-up tools by name (`GET /api/test/tools`): `get_weather(city)`, `get_time(timezone)`, `calculate(expression)`, `web_search(query, max_results?)`, `fetch_url(url)`, `lookup_order(order_id)`; an unknown name is `400 unknown_tool`. `tool_check: true` without `tools` still means `["get_weather"]`. The verdict `{"passed", "reason", "name", "arguments", "id", "calls"}` ends a stream as the comment line `: iroha-tool-check {...}` and is the `Iroha-Tool-Check` header of a JSON answer: it passes when the model made at least one call and every call names an offered tool with arguments valid against its schema (required properties present and of their type); `name` and `arguments` are the first call, or the first failing one. To go on after a call, send the assistant turn back with `tool_calls: [{"id", "name", "arguments"}]` and the same `tools`; Iroha answers each call: `get_time` with the real current time in that IANA zone, `calculate` by computing it (`+ - * / % ^`, parentheses, `sqrt abs round floor ceil min max`, `pi`, `e`), the others with plausible made-up results (nothing is searched or fetched; the same order ID gives the same record). A call it cannot answer gets `{"error": ...}` as its result.
- **Model search**: `prefer=<provider>/` (or any `<provider>/<model>`) lists that Provider before the Pools (and fills `limit` with it first) and sets `suggested`: the model it served most in the last 7 days, else its first listed. `prefer=<pool>` puts that Pool first. The UI's chat opened from a Provider or one of its keys starts on `suggested`.
- **Multi-turn**: `messages` alternate `user` and `assistant`, oldest first; `system` is the system prompt.
- **Snippets** call the Gateway as a Caller would (global route, the Shape's usual key header), with the secret of `as`, else `$IROHA_KEY`, offering `tools` (comma-separated) like the test would. Pins are test-only and not carried (a Caller cannot pin). Pass `base_url` when Iroha sits behind a proxy that changes the host.
- `dry_run=true` on `POST /api/test` sends nothing and returns the request body, route and recorded Caller.
