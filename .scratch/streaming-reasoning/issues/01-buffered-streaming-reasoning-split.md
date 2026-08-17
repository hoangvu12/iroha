# 01 — Buffered streaming reasoning-tag split

**What to build:** `createOpenAiStreamingNormalizer` correctly handles
inline `<think|thinking|budget:thinking>…</…>` blocks when the tag spans two
upstream writes (or two SSE events), and flushes any unclosed reasoning
block at end of stream as `reasoning_content` rather than leaking it to the
caller as visible content.

**Blocked by:** none.

**Status:** complete

- [x] `splitStreamingReasoning` carries a per-choice `pendingBuffer` across
      calls so a tag that straddles two upstream writes is reassembled
      before being split.
- [x] The function detects a partial tag prefix at the tail of a chunk and
      holds it back rather than emitting the partial characters as
      `delta.content`.
- [x] An unclosed reasoning block is emitted as `reasoning_content` at end
      of stream via `flushStreamingReasoning`, called from the
      `TransformStream.flush` hook before `[DONE]` would have been
      forwarded.
- [x] Existing single-chunk behaviour is preserved: tags inside one chunk,
      multiple tags in one chunk, and `</think>` with no matching
      `<think>` are all handled the same way they were before.
- [x] Tests cover: straddle across two SSE events (open and close), partial
      tag inside one event, byte-by-byte arrival, stray close, partial
      close at end of stream, unclosed reasoning at end of stream.
- [x] Per-choice state isolation across choices in the same response is
      preserved.

## Root cause

`splitStreamingReasoning` (`src/inference/generic-adapter.ts`, previous
version) took one `text` argument per call and ran a one-shot regex over it.
Upstream tokenizers can emit a tag like `<think>` split across two writes
(`<th` then `ink>reasoning</think>visible`). The first write's half-tag was
forwarded as plain `delta.content`, then the second write's text was split
by the regex without recognising the leading `<` it never saw — producing
garbage reasoning and visible content.

## Fix shape

Add `pendingBuffer: string` to `StreamingChoiceState`. Rewrite
`splitStreamingReasoning` to:

1. Append `text` to `pendingBuffer` before any work.
2. Walk the regex loop over `pendingBuffer` (not over `text`) to consume
   complete tags and switch `inReasoning`.
3. After the loop, look at the remaining tail (`pendingBuffer` from
   `lastIndex` onward). If its tail is a prefix of any tag the choice would
   accept next, hold that prefix back in `pendingBuffer` and emit the rest
   now; otherwise emit the rest now and clear `pendingBuffer`.

The partial-prefix detection uses a small helper
(`longestMatchingTagPrefixLen`) that walks the suffixes of every
tag-of-the-current-type and returns the longest one that matches the tail.
This is the same pattern Vercel AI SDK uses
(`packages/ai/src/util/get-potential-start-index.ts`); the Iroha version is
slightly different because we only check the *current*-direction tags, not
all tags, since a stray tag of the wrong direction is treated as a no-op
when consumed.

End-of-stream flushes any leftover buffer via a new `flushStreamingReasoning`
helper called from `createOpenAiStreamingNormalizer`'s `flush` hook. The
helper drains `pendingBuffer` into `reasoning` if the choice is still
inside a reasoning block, otherwise into `content`. It emits *before*
`[DONE]` would have been forwarded, so the reasoning-to-content
transition lands in the right place.

## Out of scope (parked)

- An opt-in `merge_reasoning_content_in_choices` flag that re-inserts
  `<think>` tags into `delta.content` for UIs like OpenWebUI. Not a
  correctness concern; deferred.
- Empty reasoning block detection (`<think></think>` with no body). The
  current implementation passes the empty string through unchanged. There
  is no caller-visible regression; revisit when a consumer asks for a
  count of reasoning blocks.
- Cross-chunk leading-whitespace stripping after a close tag. Both the old
  and new implementations only strip whitespace inside a single chunk.

## Files touched

- `src/inference/generic-adapter.ts` — `splitStreamingReasoning`,
  `flushStreamingReasoning`, `StreamingChoiceState`, default state in
  `normalizeSseEvent`, `flush` in `createOpenAiStreamingNormalizer`.
- `test/inference/streaming-normalize-openai-response.test.ts` — six new
  failing tests covering the bug class, plus a typo fix on a pre-existing
  test (`a flush that ends mid-event is still normalised` had malformed
  JSON).

## Verification

- `bun test test/inference/streaming-normalize-openai-response.test.ts` —
  20 pass / 0 fail.
- `bun test test/inference` — 30 pass / 0 fail.
- `bunx tsc --noEmit` — no new errors. (Two pre-existing errors remain in
  `src/inference/anthropic-adapter.ts` and `src/http/inference.ts`;
  confirmed they exist on `main` before this change via `git stash`.)

## Debugging

If a stream still misbehaves against a real upstream, enable the
file-based debug logger to see every byte that crosses the splitter:

```sh
# Windows PowerShell
$env:IROHA_STREAMING_DEBUG = "1"
bun run dev:server

# bash / zsh
IROHA_STREAMING_DEBUG=1 bun run dev:server
```

The log file is appended to (not truncated) on each run. Reset it with:

- Windows: `Remove-Item "$env:TEMP\opencode\iroha-streaming-debug.log"`
- bash: `rm -f "${TMPDIR:-/tmp}/opencode/iroha-streaming-debug.log"`

Path source: `src/debug/streaming-log.ts`. Tagged lines:

- `[split]` — one per call to `splitStreamingReasoning`, with the input
  text, the combined buffer, the number of tags consumed, the first tag
  consumed, the partial-prefix length, the input/output state, and the
  mutated flag.
- `[sse.in]` / `[sse.out]` — bytes entering and JSON-encoded payloads
  leaving the SSE TransformStream.
- `[sse.event]` / `[sse.passthrough]` — each `data:` event after
  boundary split.
- `[flush]` / `[flush.start]` / `[flush.end]` — end-of-stream buffer
  drains.

The logger is no-op when `IROHA_STREAMING_DEBUG` is unset or set to
anything other than `"1"`, so production deployments pay nothing.

## When the logger shows the bug

What to look for, in order:

1. A chunk that arrives as `[sse.in]` with a `delta.content` that *ends*
   with `<` or `</` or any prefix-of-tag — the next line should be a
   `[split]` with `partialPrefixLen > 0` and `pendingAfter` non-empty. If
   `partialPrefixLen` is `0`, the partial-prefix detection has a hole —
   probably a tag variant we don't recognise (e.g. `<reasoning>`,
   `<|begin▁of▁thinking|>`).
2. `[sse.out]` with `reasoning_content` populated but the visible text
   leaking into `content` (or vice versa). That indicates a tag matched
   the wrong direction or a stray tag toggled state unexpectedly.
3. `[flush]` lines where `inReasoning=true` draining `reasoning` —
   expected when the upstream forgot `</think>`. `[sse.out]` should
   follow immediately; if it doesn't, the flush is being suppressed by
   `[DONE]` arriving first.
4. Any line with `partialPrefixLen > 0` but `pendingAfter=""` — the
   splitter threw away a partial tag it should have kept.
