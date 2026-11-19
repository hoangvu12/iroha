# Go, built from scratch, not a fork of an existing gateway

v1 (Bun, TypeScript, Elysia) became hard to change because of its design, not its runtime: measured on 2026-10-29 it idled at ~65 MB and ~1 ms CPU per request, while each inference made ~16 database queries and three writes before the first token. We rewrite anyway, in Go, because Go is the only ecosystem with maintained libraries that translate between OpenAI Chat, OpenAI Responses, Anthropic Messages and Gemini (including streams), it ships as one static binary with an embedded SQLite driver, and agents write it reliably. We build our own gateway rather than fork new-api, Bifrost, LiteLLM or gpt-load, because those are shaped around multi-tenant resale or enterprise governance and their key models are coarser than Iroha's; every odd-provider fix would become a patch against a fast-moving upstream.

## Considered Options

- TypeScript on Node with a clean design: keeps v1 knowledge, but the whole Shape-translation matrix would be ours to write and maintain.
- Rust: thin ecosystem for this niche (TensorZero archived 2026-06), slow agent edit-compile loops.
- Fork gpt-load 2.x (Go, MIT, SQLite): closest fit, but a release candidate with an undocumented admin API, and we would live inside its Channel/Group model.

See `docs/research/language-and-prior-art.md`.
