# Anthropic Generic Template - Implementation Summary

## Overview

This feature adds three capabilities to Iroha:

1. **Generic Anthropic-compatible provider template** - A new template for Anthropic-shaped services (like MiniMax's Anthropic-compatible endpoint)
2. **Configurable auth headers** - Users can override `authHeader` and `authPrefix` in the create/edit dialogs
3. **Anthropic SDK code snippets** - Code examples for the Anthropic SDK in the code snippet card

## Why this matters

**Problem 1: No generic Anthropic template**
- Services like MiniMax expose Anthropic-compatible endpoints
- Users need a template that uses the `AnthropicInferenceAdapter` without branding
- The existing `Generic OpenAI-compatible` template doesn't help here

**Problem 2: Auth not configurable**
- Anthropic's native API uses `x-api-key`
- Proxies like LiteLLM use `Authorization: Bearer`
- Users with non-standard auth couldn't override the template defaults

**Problem 3: No Anthropic SDK examples**
- The code snippet card only shows OpenAI-compatible examples
- Users who want to use the Anthropic SDK against Iroha had no examples

## Implementation plan

### Issue 01: Generic Anthropic-compatible template
- Add template to `src/providers/templates.ts`
- Use `x-api-key` as default auth (matches Anthropic native)
- Use `ANTHROPIC_INFERENCE_ADAPTER_ID` for protocol translation
- No known models or capability defaults (generic template)

### Issue 02: Auth header configurable in UI
- Add `authHeader` and `authPrefix` to create dialog (pre-filled from template)
- Add `authHeader` and `authPrefix` to edit dialog (shows current values)
- Update API to accept these fields
- Add validation for header names

### Issue 03: Anthropic SDK code snippets
- Detect if provider uses `AnthropicInferenceAdapter`
- Show Anthropic snippets (curl, js, py) for Anthropic providers
- Show OpenAI snippets for OpenAI-compatible providers
- Use provider's `authHeader` in curl snippet

## Design decisions

### Why `x-api-key` as default for generic template?
- Matches Anthropic's native API
- Most Anthropic-compatible proxies mimic this auth scheme
- Users with non-standard auth can override in UI

### Why make auth configurable at provider level (not key level)?
- Auth scheme is a property of the upstream service, not the individual key
- All keys on a provider use the same auth scheme
- Keeps the data model simple

### Why show both OpenAI and Anthropic snippets?
- The `AnthropicInferenceAdapter` supports both `/v1/chat/completions` and `/v1/messages`
- Users can choose the SDK they prefer
- Clear labels help users pick the right snippet

## Testing strategy

- Unit tests for template registration
- Integration tests for API changes (create/update with auth fields)
- UI tests for dialog behavior (pre-fill, override)
- Manual verification for code snippets

## Migration path

No migration needed - this is additive:
- Existing providers keep their current `authHeader` and `authPrefix`
- New providers can use the new template
- Users can override auth fields on existing providers if needed

## Success criteria

- [ ] Users can create a provider with the `Generic Anthropic-compatible` template
- [ ] Users can override `authHeader` and `authPrefix` in create/edit dialogs
- [ ] Users see Anthropic SDK examples for Anthropic providers
- [ ] Users see OpenAI SDK examples for OpenAI-compatible providers
- [ ] All existing tests pass
- [ ] New tests cover the added functionality

## Future considerations

- Auto-detection of auth schemes based on base URL patterns
- Per-key auth overrides (if there's demand)
- More SDK examples (Go, Ruby, etc.)
