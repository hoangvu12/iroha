# Feature map

Where each part of Iroha lives, how to reach it, and where it is explained. It points; the explanations live in the running instance's `/skill.md` (sections named below by heading) and `/api/openapi.json`. UI paths are relative to `base_url`; pass them to `screenshot.cjs` without the leading slash. Code: the package map in `docs/agents/architecture.md`; UI routes in `web/src/app/App.tsx` and each `web/src/pages/*/index.tsx`.

When a ticket adds a page, a tab or an admin resource, add its row here in the same change.

## UI pages

Every page needs the Owner session (`screenshot.cjs` signs in). The shared components in every state are on `/states`.

| Page | Path | What it shows and does | Demo data to look at | `/skill.md` |
|---|---|---|---|---|
| Providers and Model Pools | `/providers` | Every Provider with keys, active keys, models, today's Requests and success; Model Pools below. New Pool, Add Provider. | 8 Providers, Pools `glm-4.6`, `llama-3.3-70b` | Logos and the overview; Model Pools |
| Provider: Keys | `/providers/<handle>/keys` | Upstream Keys with Key State and reason, cache share over 24 h, last used; filter by state; enable, disable, test, edit many. Test opens the test chat. | `openrouter`: active, cooling, invalid, disabled | Key States and Failure Rules; Endpoint Gaps |
| Provider: Endpoints | `/providers/<handle>/endpoints` | Endpoints (URL, Shape, auth style, static headers, renames, caching settings); the Endpoint sheet shows the prompt cache summary. | `deepseek` has a Chat and an Anthropic Endpoint | Setting up a Provider and a Caller; Prompt caching across Shapes |
| Provider: Models | `/providers/<handle>/models` | The model list: discovered, added, hidden, Model Gaps, metadata; refresh. | Added models on every demo Provider (discovery is off) | Model lists; Model metadata; Daily model refresh |
| Provider: Rules | `/providers/<handle>/rules` | Failure Rules as a flow; try a failure against them. | built-ins | Managing Failure Rules |
| Provider: Settings | `/providers/<handle>/settings` | Name, logo, budget (attempts, first byte), strict, discovery, affinity; archive, delete. | | Setting up a Provider and a Caller; Conversation affinity |
| Model Pool | `/providers/pools/<name>/route` (also `members`, `settings`) | The route preview of a Pool name: members in order, their candidates and skips. | `glm-4.6` | Model Pools |
| Gateway Keys | `/gateway-keys`, `/gateway-keys/<key>` | Gateway Keys, their scope, capture switch, activity; issue, revoke, delete. | `laptop`, `ci`, `friend` | Gateway Keys: activity, revoke or delete |
| Requests | `/requests` | The Requests feed with stats, filters (Provider, key, Pool, status, Shape, affinity), live updates. | 32 Requests, cache reads, one failure | Logs, captures and retention; Prompt cache usage |
| One Request | `/requests/<id>/route` (also `details`, `captured`) | The route a Request took: each Attempt, rule, outcome, key; details; the captured bodies. | the failed `mistral` Request; the `zai` 429 then success | Logs, captures and retention |
| Chat | `/chat` | The test chat: pick a model (as a Gateway Key or not), tools, snippets. | any demo model | Testing a model (the test chat API) |
| Settings | `/settings/admin-tokens`, `/settings/audit-entries`, `/settings/sign-in` | Admin Tokens; Audit Entries with revert; the Owner password and sessions. | the seed's own Audit Entries | Conventions of every admin resource; The Owner's login |
| States | `/states` | Every shared component in every state (C25). | none needed | |
| Sign-in | `/` signed out | The password form; the first start asks for the bootstrap Admin Token. | `owner_password` | The Owner's login |

## Admin resources and routes

All under `base_url`, `Authorization: Bearer <admin_token>`. Mutations take `?dry_run=true`, write an Audit Entry and can be reverted (`/skill.md` "Conventions of every admin resource").

| Resource | Routes | `/skill.md` |
|---|---|---|
| Providers | `/api/providers`, `/api/providers/{provider}`, `.../summary` | Setting up a Provider and a Caller; Logos and the overview |
| Endpoints | `/api/providers/{provider}/endpoints[/{endpoint}]` | Setting up a Provider and a Caller; Shapes and translation; Prompt caching across Shapes; Keyless Providers |
| Upstream Keys | `/api/providers/{provider}/keys[/{key}]`, `.../enable`, `.../disable`, `.../test`, `.../clear-model-gaps`, bulk forms | Key States and Failure Rules; Endpoint Gaps |
| Model lists | `/api/providers/{provider}/models[/{model}]`, `.../refresh`, `.../reset`, `.../model-gaps`; `/api/model-refreshes` | Model lists; Model metadata; Daily model refresh |
| Model Pools | `/api/pools[/{pool}]`, `/api/route-preview?model=&shape=&as=` | Model Pools |
| Gateway Keys | `/api/gateway-keys[/{key}]`, `.../revoke`, bulk forms | Gateway Keys: activity, revoke or delete |
| Failure Rules | `/api/rules[/{rule}]`, replay, bulk forms | Managing Failure Rules |
| Settings | `/api/settings[/{setting}]` | the setting's own section (retention, affinity, ...) |
| Requests and Attempts | `/api/requests`, `/api/requests/{request}`, `.../capture`, `/api/requests/stats`, `/api/requests/filters` | Logs, captures and retention; Prompt cache usage |
| Logs | `/api/logs?kind=&since=` | Logs, captures and retention |
| Audit Entries | `/api/audit-entries[/{entry}]`, `.../revert`, `/api/audit-entries/filters` | Conventions of every admin resource |
| Admin Tokens | `/api/admin-tokens[/{token}]`, `.../revoke` | Operating Iroha (Authentication) |
| Owner login | `/api/session`, `/api/owner-password`, `/api/owner-sessions` | The Owner's login |
| Jobs | `/api/jobs`, `/api/jobs/{job}/run` | Daily model refresh; Logs, captures and retention |
| Test chat | `POST /api/test`, `/api/test/models`, `/api/test/tools`, `/api/test/snippets` | Testing a model (the test chat API) |
| Overview, logos | `/api/overview`, `/api/logos`, `/api/providers/{p}/logo`, `/api/pools/{p}/logo` | Logos and the overview |

## Caller routes

`Authorization: Bearer <Gateway Key>`. `/skill.md` "Calling the Gateway", "Global routes", "OpenAI Responses", "Gemini", "Shapes and translation", "Conversation affinity".

| Shape | Global route | Per Provider |
|---|---|---|
| OpenAI Chat | `POST /v1/chat/completions` | `/providers/{handle}/v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` | `/providers/{handle}/v1/responses` |
| Anthropic Messages | `POST /v1/messages` | `/providers/{handle}/v1/messages` |
| Gemini | | `POST /providers/{handle}/v1beta/models/{model}:generateContent` (`:streamGenerateContent`) |
| Model lists | `GET /v1/models` | `GET /providers/{handle}/v1/models` |
