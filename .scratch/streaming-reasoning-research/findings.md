# Streaming inline-`<think>` parsing — what other gateways do

Research into how popular AI gateways and SDKs handle the `<think>…</think>` /
`<thinking>…</thinking>` / `<budget:thinking>…</budget:thinking>` convention that
some OpenAI-compatible upstreams embed inside `delta.content` of their SSE stream
instead of returning it as a separate `reasoning_content` field.

Scope: streaming chat-completions only. Buffered/non-streaming parsers are noted
where the project only ships a buffered implementation.

Primary sources:

- liteLLM — `BerriAI/litellm`
- Vercel AI SDK — `vercel/ai`
- LangChain.js — `langchain-ai/langchainjs` (DeepSeek, Perplexity, Groq block
  translator)
- OpenRouter — no inline-tag parser, relies on upstream `reasoning_content`
- Portkey, Bifrost, opencode, llmux, Kong AI Gateway — no inline-tag parser

---

## 1. liteLLM (`BerriAI/litellm`)

### Buffered parser

File: `litellm/litellm_core_utils/prompt_templates/common_utils.py:1540`
SHA: `c596e821ce9c6978d03dc708e3fd4bfac8d1f9ba`
Permalink:
https://github.com/BerriAI/litellm/blob/c596e821ce9c6978d03dc708e3fd4bfac8d1f9ba/litellm/litellm_core_utils/prompt_templates/common_utils.py#L1540

```python
def _parse_content_for_reasoning(
    message_text: str | None,
) -> tuple[str | None, str | None]:
    if not message_text:
        return None, message_text

    reasoning_match: Final = re.match(
        r"<(?:think|thinking|budget:thinking)>(.*?)</(?:think|thinking|budget:thinking)>(.*)",
        message_text,
        re.DOTALL,
    )

    if reasoning_match:
        return reasoning_match.group(1), reasoning_match.group(2)

    return None, message_text
```

Notes:

- `re.match` is anchored at the start. Anything before the leading `<think>` is
  dropped from `content` — they only handle the "model starts with the
  reasoning block" shape.
- Lazy `.*?` plus `re.DOTALL` means it handles multi-line reasoning bodies.
- Only one block is captured. A second `<think>…</think>` later in the same
  content survives in `content`.

### Streaming behaviour

File: `litellm/litellm_core_utils/streaming_handler.py:1113`
SHA: `99b1c1a2ab7fe2a4985b6b251bf90937280592bc`
Permalink:
https://github.com/BerriAI/litellm/blob/99b1c1a2ab7fe2a4985b6b251bf90937280592bc/litellm/litellm_core_utils/streaming_handler.py#L1113

liteLLM's streaming path **does not parse inline reasoning tags** out of
`delta.content`. It expects upstreams to send a separate `reasoning_content`
field on the delta. The only reasoning-tag-aware logic in the streaming path is
`merge_reasoning_content_in_choices`, which **re-inserts** the tags into
`delta.content` for UIs like OpenWebUI that want a single chunk with the tags
present:

```python
self.merge_reasoning_content_in_choices: bool = litellm_params.merge_reasoning_content_in_choices or False
self.sent_first_thinking_block = False
self.sent_last_thinking_block = False
```

```python
def _optional_combine_thinking_block_in_choices(self, model_response):
    """UI's Like OpenWebUI expect to get 1 chunk with <think>...</think> tags in the chunk content
    In place updates the model_response object with reasoning_content in content with <think>...</think> tags
    Enabled when merge_reasoning_content_in_choices=True passed in request params
    """
    if self.merge_reasoning_content_in_choices is True:
        reasoning_content = getattr(model_response.choices[0].delta, "reasoning_content", None)
        if reasoning_content:
            if self.sent_first_thinking_block is False:
                if model_response.choices[0].delta.content is None:
                    model_response.choices[0].delta.content = ""
                model_response.choices[0].delta.content += "<think>" + reasoning_content
                self.sent_first_thinking_block = True
            elif (
                self.sent_first_thinking_block is True
                and hasattr(model_response.choices[0].delta, "reasoning_content")
                and model_response.choices[0].delta.reasoning_content
            ):
                model_response.choices[0].delta.content = reasoning_content
        elif (
            self.sent_first_thinking_block is True
            and not self.sent_last_thinking_block
            and model_response.choices[0].delta.content
        ):
            model_response.choices[0].delta.content = "</think>" + (model_response.choices[0].delta.content or "")
            self.sent_last_thinking_block = True
        if hasattr(model_response.choices[0].delta, "reasoning_content"):
            del model_response.choices[0].delta.reasoning_content
```

State is two booleans (`sent_first_thinking_block`, `sent_last_thinking_block`).
There is no per-delta buffering — they trust the upstream to send reasoning in
a separate field, and only wrap it back into `content` at the point of egress.

### Lessons for Iroha

- Their tag-name regex matches exactly the three we already use (`think`,
  `thinking`, `budget:thinking`) and nothing else. No surprises there.
- Their buffered parser is **only valid at the start of the content string**.
  Multi-block reasoning (or reasoning preceded by any visible text) is silently
  ignored. Iroha's current parser is stricter than this and already handles
  middle-of-text reasoning correctly.
- liteLLM deliberately skips inline-tag parsing in the streaming path because
  it relies on upstream's separate field. We don't have that luxury — some
  upstreams (DeepSeek, Qwen, Kimi, GLM, OpenRouter-as-relay-of-DeepSeek) do
  emit inline tags in the stream, and we have to handle it.

---

## 2. Vercel AI SDK (`vercel/ai`)

The cleanest reference implementation for our problem.

### Core middleware

File: `packages/ai/src/middleware/extract-reasoning-middleware.ts`
SHA: `7271e2265ca494ab05154ced903475ee92017145`
Permalink:
https://github.com/vercel/ai/blob/7271e2265ca494ab05154ced903475ee92017145/packages/ai/src/middleware/extract-reasoning-middleware.ts

Key design:

1. **Per-id buffer** stored in `reasoningExtractions[chunk.id]`, with fields
   `isFirstReasoning`, `isFirstText`, `afterSwitch`, `isReasoning`, `buffer`,
   `idCounter`, `textId`. Buffers across chunks.
2. **State machine** with `isReasoning` toggle.
3. **Look for the OTHER tag.** If currently reasoning, search for the closing
   tag; if not, search for the opening tag. This avoids the "saw a stray close
   tag" foot-gun because we only ever look for the next expected tag.
4. **Partial-tag detection** via `getPotentialStartIndex` (see below). If the
   buffer ends mid-prefix-of-next-tag, we don't flush — we wait.
5. **Empty reasoning blocks** still emit a `reasoning-start` so downstream
   consumers see a deterministic `reasoning-start`/`reasoning-end` pair (see
   `vercel/ai#7774` comment in code).
6. **`text-start` is delayed** until the first reasoning-start OR until the
   first text-delta that isn't inside reasoning. Avoids a UI flicker where
   `text-start` arrives before `reasoning-start`.
7. **`afterSwitch` flag** causes a `separator` (default `"\n"`) to be inserted
   on the first chunk after a state switch, so a client reconstructing the
   visible text doesn't see the `\n` collapse.

Streaming transform core (excerpt):

```typescript
return {
  stream: stream.pipeThrough(
    new TransformStream({
      transform: (chunk, controller) => {
        if (chunk.type === 'text-start') {
          delayedTextStart = chunk;
          return;
        }
        if (chunk.type === 'text-end' && delayedTextStart) {
          controller.enqueue(delayedTextStart);
          delayedTextStart = undefined;
        }
        if (chunk.type !== 'text-delta') {
          controller.enqueue(chunk);
          return;
        }
        if (reasoningExtractions[chunk.id] == null) {
          reasoningExtractions[chunk.id] = {
            isFirstReasoning: true,
            isFirstText: true,
            afterSwitch: false,
            isReasoning: startWithReasoning,
            buffer: '',
            idCounter: 0,
            textId: chunk.id,
          };
        }
        const activeExtraction = reasoningExtractions[chunk.id];
        activeExtraction.buffer += chunk.delta;

        function publish(text: string) { /* emits reasoning-delta or text-delta */ }

        do {
          const nextTag = activeExtraction.isReasoning ? closingTag : openingTag;
          const startIndex = getPotentialStartIndex(activeExtraction.buffer, nextTag);
          if (startIndex == null) {
            publish(activeExtraction.buffer);
            activeExtraction.buffer = '';
            break;
          }
          publish(activeExtraction.buffer.slice(0, startIndex));
          const foundFullMatch =
            startIndex + nextTag.length <= activeExtraction.buffer.length;
          if (foundFullMatch) {
            activeExtraction.buffer = activeExtraction.buffer.slice(startIndex + nextTag.length);
            if (activeExtraction.isReasoning) {
              // Emit reasoning-start for empty reasoning blocks too.
              if (activeExtraction.isFirstReasoning) {
                controller.enqueue({ type: 'reasoning-start', id: `reasoning-${activeExtraction.idCounter}` });
              }
              controller.enqueue({ type: 'reasoning-end', id: `reasoning-${activeExtraction.idCounter++}` });
            }
            activeExtraction.isReasoning = !activeExtraction.isReasoning;
            activeExtraction.afterSwitch = true;
          } else {
            // partial tag at end of buffer — keep it for next chunk
            activeExtraction.buffer = activeExtraction.buffer.slice(startIndex);
            break;
          }
        } while (true);
      },
    }),
  ),
  ...rest,
};
```

### `getPotentialStartIndex` helper

File: `packages/ai/src/util/get-potential-start-index.ts`
SHA: `06ba2189ea2efa406e73c120719488824dfb3872`
Permalink:
https://github.com/vercel/ai/blob/06ba2189ea2efa406e73c120719488824dfb3872/packages/ai/src/util/get-potential-start-index.ts

```typescript
export function getPotentialStartIndex(
  text: string,
  searchedText: string,
): number | null {
  if (searchedText.length === 0) return null;

  const directIndex = text.indexOf(searchedText);
  if (directIndex !== -1) return directIndex;

  // Otherwise, look for the largest suffix of "text" that matches
  // a prefix of "searchedText". We go from the end of text inward.
  for (let i = text.length - 1; i >= 0; i--) {
    const suffix = text.substring(i);
    if (searchedText.startsWith(suffix)) {
      return i;
    }
  }
  return null;
}
```

Why it's clever:

- Returns the index of either a complete match or a partial prefix-of-tag
  suffix-of-buffer. So if the buffer is `"Hello <thi"` and `searchedText` is
  `"<think>"`, it returns `6` — meaning "the buffer ends with a 4-character
  prefix of `<think>`, so a tag might be starting here; don't flush those 4
  characters yet, wait for more data."
- Cost is `O(n)` per chunk — fine for chunk sizes in the dozens of bytes.
- Does not require regex backtracking.

### Edge cases Vercel covers (from the test file `extract-reasoning-middleware.test.ts`)

- tag straddling two chunks
- empty reasoning block: `<think></think>` (afterSwitch=true)
- startWithReasoning=true: immediate `</think>` (afterSwitch=false)
- multiple consecutive `<think>…</think>` blocks in one chunk
- reasoning with no text around it
- reasoning before AND after visible text

### Lessons for Iroha

- **The single biggest improvement**: buffer `delta.content` across SSE events
  (or across byte-level writes inside the SSE event) and only emit content
  that is provably not the prefix of an upcoming tag. This is the bug class
  that "iroha is parsing each text as a different thinking block" hits.
- **Look for the OTHER tag** each iteration, not both. Vercel's "if reasoning
  → look for close, else look for open" means a stray `</think>` before any
  `<think>` is harmless (the state stays in `not reasoning`).
- **`afterSwitch` + separator** matches Iroha's existing behaviour of trimming
  the leading whitespace after the close tag (see the existing comment in
  `splitStreamingReasoning` at `src/inference/generic-adapter.ts:560-567`).
- **`isFirstReasoning` for empty reasoning blocks** is something Iroha does
  NOT currently handle. An empty `<think></think>` would silently produce
  `content=""` and `reasoning_content=""` with no delta being mutated — that
  is technically correct (no content to move) but loses the structural cue
  that an empty reasoning block existed.

---

## 3. LangChain.js — DeepSeek provider (`langchain-ai/langchainjs`)

The closest match to what Iroha needs: per-stream stateful buffer with
greedy partial-tag detection.

File: `libs/providers/langchain-deepseek/src/chat_models.ts:490-720`
SHA: `755f2b55b048bf0306044c7dd549952292662a03`
Permalink:
https://github.com/langchain-ai/langchainjs/blob/755f2b55b048bf0306044c7dd549952292662a03/libs/providers/langchain-deepseek/src/chat_models.ts#L490

The async generator wraps `super._streamResponseChunks` and transforms each
chunk:

```typescript
// State for parsing <think> tags
let tokensBuffer = "";
let isThinking = false;

for await (const chunk of stream) {
  if (options.signal?.aborted) return;
  // If the model already provided reasoning_content natively, just yield it
  if (chunk.message.additional_kwargs.reasoning_content) {
    yield chunk;
    continue;
  }
  const text = chunk.text;
  if (!text) {
    yield chunk;
    continue;
  }

  // Append text to buffer to handle split tags
  tokensBuffer += text;

  // Check for <think> start tag
  if (!isThinking && tokensBuffer.includes("<think>")) {
    isThinking = true;
    const thinkIndex = tokensBuffer.indexOf("<think>");
    const beforeThink = tokensBuffer.substring(0, thinkIndex);
    const afterThink = tokensBuffer.substring(thinkIndex + "<think>".length);
    tokensBuffer = afterThink || "";
    if (beforeThink) {
      // Send the content before the tag
      yield new ChatGenerationChunk({ message: new AIMessageChunk({ content: beforeThink, ...}), text: beforeThink, ... });
    }
  }

  // Check for </think> end tag
  if (isThinking && tokensBuffer.includes("</think>")) {
    isThinking = false;
    const thinkEndIndex = tokensBuffer.indexOf("</think>");
    const thoughtContent = tokensBuffer.substring(0, thinkEndIndex);
    const afterThink = tokensBuffer.substring(thinkEndIndex + "</think>".length);
    yield new ChatGenerationChunk({ message: new AIMessageChunk({ content: "", additional_kwargs: { ...chunk.message.additional_kwargs, reasoning_content: thoughtContent }, ... }), ... });
    tokensBuffer = afterThink || "";
    if (tokensBuffer) {
      yield new ChatGenerationChunk({ content: tokensBuffer, ... });
      tokensBuffer = "";
    }
  } else if (isThinking) {
    // We are inside thinking block.
    // Check partial </think> match
    const possibleEndTag = "</think>";
    let splitIndex = -1;
    for (let i = possibleEndTag.length - 1; i >= 1; i--) {
      if (tokensBuffer.endsWith(possibleEndTag.substring(0, i))) {
        splitIndex = tokensBuffer.length - i;
        break;
      }
    }
    if (splitIndex !== -1) {
      const safeToYield = tokensBuffer.substring(0, splitIndex);
      if (safeToYield) {
        yield new ChatGenerationChunk({ ... reasoning_content: safeToYield ... });
      }
      tokensBuffer = tokensBuffer.substring(splitIndex); // keep partial tag
    } else {
      if (tokensBuffer) {
        yield new ChatGenerationChunk({ ... reasoning_content: tokensBuffer ... });
        tokensBuffer = "";
      }
    }
  } else {
    // NOT thinking.
    // Check partial start tag "<think>" - Greedy check (longest first)
    const possibleStartTag = "<think>";
    let splitIndex = -1;
    for (let i = possibleStartTag.length - 1; i >= 1; i--) {
      if (tokensBuffer.endsWith(possibleStartTag.substring(0, i))) {
        splitIndex = tokensBuffer.length - i;
        break;
      }
    }
    if (splitIndex !== -1) {
      const safeToYield = tokensBuffer.substring(0, splitIndex);
      if (safeToYield) {
        yield new ChatGenerationChunk({ content: safeToYield, ... });
      }
      tokensBuffer = tokensBuffer.substring(splitIndex); // keep partial tag
    } else {
      if (tokensBuffer) {
        yield new ChatGenerationChunk({ content: tokensBuffer, ... });
        tokensBuffer = "";
      }
    }
  }
}

// Flush remaining buffer at end of stream
if (tokensBuffer) {
  if (isThinking) {
    yield new ChatGenerationChunk({ ... reasoning_content: tokensBuffer ... });
  } else {
    yield new ChatGenerationChunk({ content: tokensBuffer, ... });
  }
}
```

Notes:

- Greedy longest-prefix match: walks from `tag.length-1` down to `1`, picks the
  longest suffix that is a prefix of the tag. Then keeps that partial tag in
  the buffer and yields everything before it.
- Bails out as soon as the upstream already provides `reasoning_content`
  natively. Iroha's `normalizeStreamingDelta` already does this with the
  `!('reasoning_content' in d)` check.
- One per-stream closure — they don't multiplex choices. Iroha needs the
  per-`choiceStates.get(idx)` map.
- They yield zero-or-one chunk per upstream chunk. We yield zero-or-one chunk
  per SSE event in `normalizeSseEvent`. The buffer must be the choice-level
  state, not the SSE-event-level buffer.
- End-of-stream flush: if `isThinking` is true at flush, the leftover buffer
  goes to `reasoning_content` (unclosed thought — model forgot the close tag).
  Iroha currently emits the leftover as plain content. Vercel and LangChain
  both treat it as reasoning.

### Lessons for Iroha

- **Greedy partial-tag detection** is a simple, correct alternative to
  `getPotentialStartIndex`. Same end result.
- **End-of-stream flush** of an unclosed reasoning block → reasoning_content.
  Iroha currently emits it as plain content in the buffered path. This is a
  real bug — if the model fails to emit `</think>`, the user sees a chunk of
  reasoning as if it were the answer.
- **`tagName` is hard-coded to `<think>`.** They do not handle `thinking` or
  `budget:thinking`. We should preserve our broader regex.
- **No multi-block handling inside one chunk** — the second `<think>` is lost
  because the code only does the indexOf check once. Our current regex-with-
  loop approach does handle multiple blocks in one chunk. Keep that.

---

## 4. LangChain.js — Perplexity provider (`langchain-ai/langchainjs`)

Buffered only — not streaming.

File: `libs/providers/langchain-perplexity/src/utils/output_parsers.ts`
SHA: `839b12a7c998a6c95e1b7331a5118adbc1ee4d1b`
Permalink:
https://github.com/langchain-ai/langchainjs/blob/839b12a7c998a6c95e1b7331a5118adbc1ee4d1b/libs/providers/langchain-perplexity/src/utils/output_parsers.ts#L16

```typescript
const stripThinkTags = (text: string): string => {
  let cleanedText = "";
  let searchStart = 0;

  while (searchStart < text.length) {
    const openTagIndex = text.indexOf(THINK_OPEN_TAG, searchStart);
    if (openTagIndex === -1) {
      cleanedText += text.slice(searchStart);
      break;
    }
    cleanedText += text.slice(searchStart, openTagIndex);
    const closeTagIndex = text.indexOf(
      THINK_CLOSE_TAG,
      openTagIndex + THINK_OPEN_TAG.length,
    );
    if (closeTagIndex === -1) {
      cleanedText += text.slice(openTagIndex);
      break;
    }
    searchStart = closeTagIndex + THINK_CLOSE_TAG.length;
    while (searchStart < text.length && isWhitespace(text[searchStart])) {
      searchStart += 1;
    }
  }
  return cleanedText.trim();
};
```

Notes:

- Skips past `<think>…</think>` blocks and the whitespace immediately after
  each one. This is the same whitespace rule Iroha already enforces.
- Handles multiple blocks correctly via `searchStart`.
- Buffered only — used for structured-output parsing where the full string is
  available.

---

## 5. LangChain.js — Groq block translator (`langchain-ai/langchainjs`)

Also buffered only, and only used on Groq raw responses that happen to embed
`<think>` tags in non-streaming completions.

File: `libs/langchain-core/src/messages/block_translators/groq.ts`
Permalink (latest main):
https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/src/messages/block_translators/groq.ts

Pattern: `text.match(/<think>([\s\S]*?)<\/think>/)`.

Single-block, lazy match, drops the captured reasoning from `content` and
yields it as a separate reasoning block. Same `re.DOTALL` style as liteLLM but
not anchored.

---

## 6. Other gateways (no inline-tag parsing)

`gh search code "<think>" --repo <owner>/<repo>` returned **zero matches** for:

- `sst/opencode` — uses upstream's `reasoning_content` field directly
- `Portkey-AI/gateway`
- `maximhq/bifrost`
- `vul-os/llmux`
- `api-evangelist/bifrost`, `api-evangelist/apipark`
- `kong` AI Gateway

The market consensus for streaming reasoning extraction is: rely on the
upstream's separate field. Iroha is unusual in trying to do the inline-tag
parse itself. That makes correctness bugs more visible — we have no peer
project to crib from, so the Vercel + LangChain patterns are our best reference.

---

## Lessons for Iroha — concrete change list

Working from the current `splitStreamingReasoning` /
`createOpenAiStreamingNormalizer` pair at `src/inference/generic-adapter.ts`.

### A. Buffer across chunks at the byte level

**Bug class:** `delta.content` for an SSE event may end mid-tag (e.g. upstream
tokenizer boundary at `<th|ink>`). Iroha's current code parses each event's
content independently, so the half-tag leaks into the next event's `content`
field and the next event's `splitStreamingReasoning` call sees a `<tag>`
where the open prefix was already discarded.

**Fix:** Keep a per-choice `pendingBuffer` alongside `inReasoning`. On each
SSE event, append `content` to the buffer before splitting. Only emit
(non-partial-prefix) text/reasoning into the SSE delta; keep the partial-tag
tail in the buffer for the next event.

### B. Adopt partial-tag detection

Use Vercel's `getPotentialStartIndex` (or LangChain's greedy loop) to find
both complete-tag matches AND partial-tag prefixes at the tail of the buffer.
Do not emit text that ends with a prefix of `<think>` (when not reasoning) or
`</think>` (when reasoning) — wait for the next chunk.

### C. Look for the OTHER tag, not both

When `isReasoning` is true, the next expected tag is the closing tag; ignore
any stray `<think>` in the buffer (and vice versa). This matches Vercel and
removes the risk of an early `</think>` toggling state out of reasoning.

### D. Flush an unclosed reasoning block at end of stream

If `isReasoning` is true when the SSE stream ends (upstream forgot
`</think>`), emit the remaining buffer as `reasoning_content` rather than
`content`. Vercel and LangChain both do this; Iroha currently leaks the
unclosed reasoning to the user as if it were the answer.

### E. Emit a structural cue for empty reasoning blocks

For `<think></think>` (empty body), the current Iroha code emits
`content=""` and `reasoning_content=""` because `mutated` is `true` (a tag
was found) but `reasoning` is empty. This produces no actual delta from
`mutated=true` perspective if the rest of the SSE event is empty. The
result: the client never sees that an empty reasoning block existed.

Not a correctness bug — empty reasoning blocks carry no information. But
if any future feature wants to count reasoning blocks or surface a
"thought for 0ms" UI cue, we'd need to emit a non-empty sentinel here.

### F. Multi-block support already exists — keep it

The current `while (tagRegex.exec(text))` loop handles multiple
`<think>…</think>` blocks in the same chunk correctly. Vercel's and
LangChain's simpler parsers do NOT (they yield the first block and let the
rest fall through to plain content). Don't regress this when adding the
buffer.

### G. Per-choice state isolation

Already correct via `choiceStates: Map<number, StreamingChoiceState>`. Keep
the map keyed by choice index; each choice gets its own `pendingBuffer`
and `inReasoning`. Existing test `'tracks reasoning state independently
per choice index'` covers this.

### H. Skip when upstream already published `reasoning_content`

Already correct via the `!('reasoning_content' in d)` check. Keep it.

---

## What we should NOT copy

- liteLLM's `merge_reasoning_content_in_choices` (re-insert tags into
  content for OpenWebUI). This is opt-in for a specific UI; Iroha's contract
  with its callers is OpenAI-shaped (`reasoning_content` separate from
  `content`), so we keep them separate.
- LangChain DeepSeek's single-tag-name hard-code. Our three-tag regex is
  broader and matches DeepSeek, Qwen, GLM, Kimi, and OpenRouter-as-relay.
- Vercel's `delayedTextStart` trick. That's an SDK-level concern for
  consumer UI flicker. At the gateway layer we emit raw deltas; the consumer
  decides how to render.

---

## Open questions to grill on

1. Do we want to keep emitting `reasoning_content: ""` and `content: ""`
   together when the chunk only participates in a transition (no actual
   text moved), or switch to omitting the empty field? The current contract
   says "deterministic shape for clients diffing consecutive deltas" —
   leaving both fields set is the Vercel-equivalent behaviour but doubles
   the byte cost of every empty chunk.
2. Should `splitStreamingReasoning` be the right shape, or should we move
   the buffer into `StreamingChoiceState` and rename to something like
   `appendAndSplit` / `drain` to make the per-call API explicit about
   buffering? The current two-function split (stateful transformer +
   stateless `splitStreamingReasoning`) is the source of the bug.
3. Should we add a feature flag (`merge_reasoning_content_in_choices`-style)
   for callers who want the inline tags reinserted? Cheap to add once the
   splitter is correct.
4. Test coverage gaps: empty reasoning block, unclosed reasoning at stream
   end, partial-tag straddling across SSE event boundaries, multi-block in
   one chunk with reasoning interleaved with visible text, choice with no
   reasoning at all (regression check).
