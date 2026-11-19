# Translate through one canonical format; pass through when Shapes match

Callers may use any of four Shapes (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini) against any Provider. Rather than twelve pairwise translators, every request that needs translation is converted into one canonical form and out again, so each Shape needs one converter in each direction. When the chosen Endpoint already speaks the caller's Shape, the body passes through untouched apart from the model name and headers, which is faster and loses nothing; Endpoint selection prefers such Endpoints. The converter is a third-party Go library behind a single interface, chosen between RelayKit (new-api, AGPL-3.0) and Bifrost core (Apache-2.0) by golden tests on recorded traffic. The Owner has accepted that using RelayKit makes Iroha AGPL-3.0; the repository is already public.

## Decision (ticket 13): RelayKit v0.3.7

Iroha uses RelayKit (`github.com/QuantumNous/new-api/relaykit`, pinned at `v0.3.7`) behind `internal/translate`, the only package that imports it.

Golden tests (`internal/translate/testdata/golden/`, run by `TestGolden`; `-update` rewrites them) hold recorded-style exchanges built from v1's Anthropic fixtures and the Providers' documented wire examples. Each case sends a Caller's request through translation and an Endpoint's answer back, whole and streamed. All four cases pass, and each also checks invariants that hold whatever the golden says (no RelayKit billing fields, the Caller's model on every answer and chunk, one usage chunk only when asked for, `[DONE]` or `message_start`…`message_stop` framing):

| Case | Covers | Result |
|---|---|---|
| `chat-to-anthropic-text` | system + developer hoisted, stop → stop_sequences, max_tokens default, forced tool choice with a sanitised name, text answer and stream, ping dropped, usage with cache reads | pass |
| `chat-to-anthropic-tools-images-reasoning` | `reasoning_effort: high` → `thinking.budget_tokens` (max_tokens raised so budget < max_tokens), data-URL and URL images, replayed tool call + tool result, `parallel_tool_calls: false`, tool names `fs.read` / `mcp:git status` sanitised and restored, thinking → `reasoning_content`, two tool calls streamed, usage | pass |
| `anthropic-to-chat-tools-images-thinking` | thinking budget → `reasoning_effort`, cached system blocks, base64 and URL images → `image_url`, replayed assistant turn without its message id (REQ-53), tool results, `disable_parallel_tool_use`, `reasoning_content` → thinking block, tool call restored, stream with usage chunk → `message_delta` usage | pass |
| `anthropic-to-chat-text-effort` | `output_config.effort` → `reasoning_effort`, string system, stop_sequences, `length` → `max_tokens`, stream without usage | pass |

RelayKit converted every case correctly; the host work around it, as the exploration predicted, is Iroha's: stamping id/model/created on every chunk, dropping RelayKit's billing fields from usage, one usage chunk at the end of a Chat stream only when the Caller asked, sanitising tool names (RelayKit passes `fs.read` through), image URLs carried as Anthropic URL sources instead of downloaded, SSE framing, upstream error events and truncated streams turned into Iroha errors, and a default `max_tokens` toward Anthropic. Bifrost core was not taken to golden tests: its stream converter drops `finish_reason` and usage (they are built inside its unexported HTTP handler), which the stream cases require, and it pulls in ~70 modules (`iroha-v2-notes/translation-libs.md`).

Adding a Shape (Responses, Gemini) is adding its codec in `internal/translate` and its golden cases. Upgrading RelayKit means rerunning `TestGolden` and reading any golden diff before accepting it.
