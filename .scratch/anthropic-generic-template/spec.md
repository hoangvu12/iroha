# Generic Anthropic-compatible provider template

## Status

Draft

## Context

Iroha currently has full Anthropic support via the `AnthropicInferenceAdapter` and the `anthropic` provider template. However, there are two gaps:

1. **No generic Anthropic-compatible template**: Services like MiniMax expose Anthropic-compatible endpoints (`/v1/messages`), but there's no "Generic Anthropic-compatible" template for users who want to use these services. The existing `Generic OpenAI-compatible` template only covers OpenAI-shaped APIs.

2. **Auth header not user-configurable**: The `authHeader` and `authPrefix` fields are locked to template defaults. Users with proxies that use non-standard auth (e.g., LiteLLM proxy using `Authorization: Bearer` instead of `x-api-key`) cannot override these settings in the UI.

3. **No Anthropic SDK code snippets**: The code snippet card only shows OpenAI-compatible examples (curl, OpenAI JS SDK, OpenAI Python SDK). Users who want to use the Anthropic SDK against Iroha's `/v1/messages` endpoint have no examples.

## Goals

- Add a `Generic Anthropic-compatible` provider template with `x-api-key` as the default auth header
- Make `authHeader` and `authPrefix` configurable in both create and edit provider dialogs
- Add Anthropic SDK code snippets (curl, anthropic-js, anthropic-py) to the code snippet card

## Non-goals

- Auto-detection of auth schemes based on base URL or key format
- Per-key auth header overrides (auth is provider-level, not key-level)
- Support for custom auth headers beyond the standard `x-api-key` and `Authorization: Bearer` patterns

## Design

### Generic Anthropic-compatible template

Add a new entry to `BUILT_IN_PROVIDER_TEMPLATES` in `src/providers/templates.ts`:

```typescript
{
  id: 'generic-anthropic-compatible',
  displayName: 'Generic Anthropic-compatible',
  description: 'A safe default for any Anthropic-shaped service Iroha does not know by brand. x-api-key authentication, no inferred capability defaults, and reactive-only entitlement visibility.',
  baseUrl: 'https://api.example.com/v1',
  authHeader: 'x-api-key',
  authPrefix: '',
  capabilities: {
    chat: false,
    streaming: false,
    tools: false,
    structuredOutput: false,
    responses: false,
  },
  knownModels: [],
  inferenceAdapterId: ANTHROPIC_INFERENCE_ADAPTER_ID,
  usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID,
  brand: null,
}
```

**Why `x-api-key` as default?** Anthropic's native API uses `x-api-key`. Most proxies that expose Anthropic-compatible endpoints mimic this auth scheme. Users with non-standard auth (e.g., LiteLLM proxy using `Authorization: Bearer`) can override in the UI.

**Why `inferenceAdapterId: ANTHROPIC_INFERENCE_ADAPTER_ID`?** The Anthropic adapter handles the OpenAI ↔ Anthropic translation, so users can call `/v1/chat/completions` (OpenAI-shaped) or `/v1/messages` (Anthropic-shaped) against the same provider.

### Auth header configuration

Add `authHeader` and `authPrefix` fields to:

1. **Create provider dialog** (`ui/src/components/providers-area.tsx`): Pre-fill from template defaults, allow user to override
2. **Edit provider dialog** (`ui/src/components/edit-provider-form.tsx`): Show current values, allow user to change

**UI considerations:**
- Show these fields after the template picker so users can see the template's defaults
- Use a dropdown for common auth patterns: `x-api-key`, `Authorization: Bearer`, `Authorization` (custom prefix)
- Allow free-text input for custom auth headers

**API changes:**
- `POST /management/providers` accepts optional `authHeader` and `authPrefix` fields
- `PATCH /management/providers/:id` accepts optional `authHeader` and `authPrefix` fields
- Validation: `authHeader` must be a valid HTTP header name (alphanumeric + hyphens)

### Anthropic SDK code snippets

Add three new snippet languages to `ui/src/components/code-snippet-card.tsx`:

1. **curl (Anthropic)**: POST to `/v1/messages` with `x-api-key` header
2. **anthropic-js**: Anthropic TypeScript SDK example
3. **anthropic-py**: Anthropic Python SDK example

**Detection logic:**
- If provider's `inferenceAdapterId === ANTHROPIC_INFERENCE_ADAPTER_ID`, show Anthropic snippets
- Otherwise, show OpenAI snippets
- If the adapter supports both (Anthropic adapter does), show both sets with clear labels

**Example snippets:**

```typescript
// anthropic-js
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

```python
# anthropic-py
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

## Open questions

None at this time.

## Implementation plan

See `.scratch/anthropic-generic-template/issues/` for the breakdown.
