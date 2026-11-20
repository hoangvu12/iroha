## Model lists

Each Provider keeps a model list. An entry has three independent flags: **discovered** (some Endpoint's or key's `/models` list names it), **added** and **hidden** (yours). Discovery never touches your flags, and an entry leaves the list only when no flag keeps it.

```
POST /api/providers/acme/models/refresh                       discover now (dry_run=true: say what would be read)
GET  /api/providers/acme/models?q=glm&filter=visible&limit=100 search, filter (all, visible, discovered, added, hidden, gaps) and page
GET  /api/providers/acme/models/meta-llama/llama-3.3-70b        one entry by model ID (slashes as is or escaped); 404 when the list doesn't hold it
POST /api/providers/acme/models   {"model": "glm-4.6"}                 add a model discovery misses; refreshes never remove it
POST /api/providers/acme/models   {"model": "old-model", "hidden": true} hide any model, even one never discovered
POST /api/providers/acme/models   {"model": "old-model", "hidden": false} show it again ({"added": false} undoes an addition)
POST /api/providers/acme/models/reset                          forget every discovered model (yours stay; Gateway Key scopes untouched)
```

- **Discovery** reads `GET <Endpoint url>/models` with the Endpoint's auth style and static headers (Anthropic and Gemini pages are followed). An Endpoint's `discovery_url` replaces that URL, or `"none"` skips the Endpoint (relays without `/models`). Answers with a `data` or a `models` array are understood. A list that fails (non-2xx, not JSON, no array) keeps the models it named before; read the error in the refresh answer or `GET /api/logs?kind=discovery&provider=acme`. The daily refresh first discovers a new Provider within an hour (see "Daily model refresh"); run a refresh by hand after setting up a Provider's Endpoints and keys to see its models at once.
- **Discovery mode** (`PATCH /api/providers/acme {"discovery": ...}`): `provider` (default) reads each Endpoint once, with the first usable key; `key` reads it with every key, for Providers whose keys see different models (DashScope, plan tiers). A key's own list only puts that key first for the models it names (it never excludes a key, because some Providers under-report), and clears that key's Model Gap for a model the list names. `none` never discovers.
- **Unlisted models are forwarded** unless the Provider is strict: `PATCH /api/providers/acme {"strict": true}` refuses them before any Attempt with `404 model_not_found` (typos fail fast). Your additions and every Endpoint rename's Caller-side name count as listed. A hidden model gets the same `404 model_not_found` whether or not the Provider is strict.
- Callers list a Provider's visible models with `GET /providers/<handle>/v1/models` (OpenAI list shape, Gateway Key auth). A Gateway Key narrowed to some models of the Provider lists exactly those, hidden ones excepted.
- Adding, hiding and showing models are audited (resource `model`, record `acme/<model>`) and revertible. Refresh and reset change only discovered state: they write no Audit Entry, and are logged as `discovery` events instead.
