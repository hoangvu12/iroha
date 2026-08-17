# Streaming reasoning-tag split

`createOpenAiStreamingNormalizer` (`src/inference/generic-adapter.ts`) extracts
inline `<think|thinking|budget:thinking>…</…>` blocks from a streamed
OpenAI-compatible response and lifts them into `delta.reasoning_content`, while
the visible text stays in `delta.content`.

## Current contract

- Per-choice state (`inReasoning`, `pendingBuffer`) is held across calls.
- A complete `<think>` (or `<thinking>`, `<budget:thinking>`) tag in the
  current chunk switches the choice into reasoning mode until a matching
  `</…>` tag arrives.
- If the tail of a chunk is a prefix of a tag the choice would accept next,
  it is held back in `pendingBuffer` until the next chunk completes the
  match. This keeps tags that straddle two upstream writes (or two SSE
  events) from being broken across two deltas.
- Tags that straddle the close→content boundary have their leading whitespace
  stripped from the visible-text run so a concatenating client sees no
  stray blank prefix.
- At end of stream, any remaining `pendingBuffer` is emitted — as
  `reasoning_content` if the choice is still inside a reasoning block
  (unclosed), or as `content` otherwise.
- The existing shape contract is preserved: when the splitter does any work
  on a chunk (matched a tag or held back a partial prefix), both
  `delta.content` and `delta.reasoning_content` are set on the outbound SSE
  event, even if one of them is empty. This lets clients diff consecutive
  deltas deterministically.

## What this fixes

Without `pendingBuffer`, a tag that an upstream tokenizer split across two
writes (e.g. `<th` then `ink>reasoningvisible`) was leaked into two deltas
with the half-tag visible to the caller, and the reasoning extraction
produced garbage text. See `issues/01-buffered-streaming-reasoning-split.md`
for the bug class and the failing tests.

## Research

`../streaming-reasoning-research/findings.md` compares the inline-tag
streaming parser across liteLLM, Vercel AI SDK, LangChain DeepSeek,
LangChain Perplexity, LangChain Groq, and the gateways that don't bother
(Portkey, Bifrost, llmux, opencode, Kong). Vercel's
`extract-reasoning-middleware` and LangChain's DeepSeek provider are the
two reference implementations; this module ports the partial-prefix
detection pattern from Vercel and the per-stream buffering pattern from
LangChain, adapted for OpenAI's flat-SSE event shape.
