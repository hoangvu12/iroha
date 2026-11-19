# v2 language and prior art (research, 2026-11-19)

Snapshot of a research pass. GitHub numbers as of 2026-11-19 (commits = last 30 days).

## Recommendation
Go, built from scratch on Iroha's own model; borrow a translation layer rather than fork a whole gateway.

- Only Go has standalone shape-translation libraries: RelayKit (new-api's converter as its own module; Chat/Responses/Messages/Gemini incl. streams; AGPL-3.0), Bifrost core (Apache-2.0, heavier deps), AxonHub `llm` (LGPL), CLIProxyAPI translators (MIT, internal). TypeScript has none maintained outside big apps; Portkey has had no commits since 2026-05-25.
- Streaming: Go stdlib + per-request write deadlines via `http.ResponseController`. Bun closes idle connections after 10 s by default (max 255 s).
- Deploy: one static binary with cgo-free SQLite (modernc or ncruces).
- Agents: Armin Ronacher (2025, 2026) singles out Go for agentic coding.
- Rust ecosystem in this niche is thin: TensorZero archived 2026-06-12; Helicone gateway inactive since 2025-11.

## Why not fork
new-api (AGPL + mandatory UI attribution; multi-key stored in one text column, round-robin/random), Bifrost (~1,000 commits/month, 7.8k files), LiteLLM (Python, virtual keys need Postgres), OmniRoute (Next.js, ~32k files) are built for multi-tenant resale or enterprise governance. Odd-relay fixes would become patches against fast-moving upstreams. one-api is stale (last commit 2025-02).

Strongest adopt alternative: gpt-load 2.x (Go, MIT, SQLite, single binary; Channel → Group → AccessKey; delegates translation to Bifrost core + CLIProxyAPI). Downsides: release candidate (rc.65), undocumented admin API, you live inside its model.

Strongest language alternative: TypeScript on Node with Hono — keeps v1 knowledge, but the whole translation matrix is yours to write.

## Ideas to borrow
- Same-shape traffic passes through as bytes with small JSON edits (model rename, headers); translate only when caller and upstream shapes differ. DashScope, z.ai and MiniMax expose Anthropic-compatible endpoints.
- Put the translation library behind one interface; choose RelayKit vs Bifrost core with golden tests on real traffic.
- OmniRoute's three resilience layers: circuit breaker on 408/5xx, per-key exponential cooldown honouring `Retry-After`, per-model lockout.
- Bifrost's key schema (models, blacklisted_models, weight) and REST layout.
- CLIProxyAPI's coding-agent tool quirks as test cases.
- LiteLLM's per-error-type cooldown policy.
- Send SSE headers immediately and ping while waiting, to avoid Cloudflare 524.

## Language comparison
| | Go | TypeScript | Rust |
|---|---|---|---|
| Streaming | `http.ResponseController`; server-wide WriteTimeout kills long streams | Node fine; Bun idle timeout 10 s unless `server.timeout(req, 0)` | axum excellent |
| Deploy | static binary, no cgo | Bun `--compile` + `bun:sqlite`; `node:sqlite` RC | static binary |
| SQLite | modernc, ncruces, mattn (cgo) | bun:sqlite / better-sqlite3 | rusqlite |
| Translation libs | RelayKit (AGPL), Bifrost core (Apache), AxonHub llm (LGPL), CLIProxyAPI (MIT, internal) | none standalone | none |
| Agent-friendliness | strong | good | slow edit-compile loop |

## Libraries
Go: `net/http`, `tmaxmax/go-sse`, `gjson`/`sjson`, RelayKit or Bifrost core, `openai-go` v3 / `anthropic-sdk-go` v2 for types only, modernc or ncruces SQLite, `sqlc`, goose.

## Sources
- https://pkg.go.dev/net/http#ResponseController
- https://bun.com/guides/http/sse
- https://github.com/oven-sh/bun/issues/27479
- https://github.com/maximhq/bifrost
- https://docs.litellm.ai/rust-migration
- https://nodejs.org/api/sqlite.html
- https://github.com/cvilsmeier/go-sqlite-bench
- https://github.com/QuantumNous/new-api
- https://pkg.go.dev/github.com/QuantumNous/new-api/relaykit
- https://github.com/tbphp/gpt-load
- https://github.com/looplj/axonhub
- https://github.com/router-for-me/CLIProxyAPI
- https://github.com/cheaper-inference/OmniRoute
- https://github.com/Portkey-AI/gateway
- https://lucumr.pocoo.org/2025/6/12/agentic-coding/
- https://lucumr.pocoo.org/2026/2/9/a-language-for-agents/
- https://github.com/tensorzero/tensorzero
- https://docs.getbifrost.ai/providers/custom-providers
- https://docs.getbifrost.ai/api-reference/providers/list-all-keys
- https://docs.litellm.ai/docs/routing
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/
