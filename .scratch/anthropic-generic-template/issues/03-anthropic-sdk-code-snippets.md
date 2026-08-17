# 03 — Add Anthropic SDK code snippets

**What to build:** Extend the code snippet card in `ui/src/components/code-snippet-card.tsx` to show Anthropic SDK examples (curl, anthropic-js, anthropic-py) when the provider uses the `AnthropicInferenceAdapter`. The snippets target the `/v1/messages` endpoint with the provider's configured `authHeader`.

**Blocked by:** None — can start immediately (independent of issues 01 and 02, but should ship together).

**Status:** done

## Detection logic

- [x] Show all 6 snippet languages for every provider (no detection needed)
- [x] Iroha exposes both `/v1/chat/completions` and `/v1/messages` for all providers via adapter translation
- [x] Users can choose whichever SDK they prefer regardless of provider template

## Snippet languages

Add three new `SnippetLanguage` values:

- [x] `curl-anthropic`: curl example targeting `/v1/messages` with `x-api-key` header
- [x] `anthropic-js`: Anthropic TypeScript SDK example
- [x] `anthropic-py`: Anthropic Python SDK example

## Snippet content

### curl-anthropic

```bash
curl -X POST <origin>/providers/<provider-id>/v1/messages \
  -H "x-api-key: <gateway-key>" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-id>",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### anthropic-js

```typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: '<gateway-key>',
  baseURL: '<origin>/providers/<provider-id>'
})

const message = await client.messages.create({
  model: '<model-id>',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }]
})

console.log(message.content)
```

### anthropic-py

```python
import anthropic

client = anthropic.Anthropic(
    api_key='<gateway-key>',
    base_url='<origin>/providers/<provider-id>'
)

message = client.messages.create(
    model='<model-id>',
    max_tokens=1024,
    messages=[{'role': 'user', 'content': 'Hello'}]
)

print(message.content)
```

## UI changes

- [x] Update `LANGUAGE_LABELS` to include the new snippet languages
- [x] Update `TOKEN_CLASS` and `TOKEN_REGEX` for the new languages (reuse patterns from existing languages)
- [x] Update `KEYWORDS` and `BUILTINS` for syntax highlighting
- [x] Update `buildSnippet()` to handle the new languages
- [x] Pass the provider's `authHeader` to `buildSnippet()` so the curl snippet uses the correct header

## Auth header awareness

- [x] In the curl snippet, use the provider's `authHeader` instead of hardcoding `x-api-key`
- [x] If `authHeader === 'x-api-key'`, add `anthropic-version: 2023-06-01` header (required by Anthropic API)
- [x] If `authHeader === 'authorization'`, use `Authorization: Bearer <gateway-key>` (OpenAI-style)

## Tests

- [x] Add test in `test/ui/code-snippet-card.test.ts` (if exists) or manual verification proving Anthropic snippets appear for Anthropic providers
- [x] Add test proving OpenAI snippets appear for OpenAI-compatible providers
- [x] Add test proving the curl snippet uses the provider's `authHeader`

## Comments

- The Anthropic SDK automatically adds the `anthropic-version` header, so the JS and Python snippets don't need to show it explicitly.
- The curl snippet must include `anthropic-version: 2023-06-01` because curl doesn't have an SDK to add it automatically.
- The `baseURL` in the SDK examples points to `/providers/<provider-id>`, not the full `/v1/messages` URL. The SDK appends the path automatically.
- The `<gateway-key>` placeholder is the Iroha Gateway Key, not the upstream Anthropic key. This matches the existing OpenAI snippet pattern.
