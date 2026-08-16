import { describe, expect, test } from 'bun:test'
import { parseQualifiedModelId } from '../../src/http/qualified-model.ts'

describe('Qualified Model ID parsing', () => {
  test('splits only at the first slash and preserves the exact upstream remainder', () => {
    expect(parseQualifiedModelId('pr_openrouter/openai/gpt-4o')).toEqual({
      ok: true,
      providerId: 'pr_openrouter',
      modelId: 'openai/gpt-4o',
    })
  })

  test('rejects missing Provider and model segments and unqualified IDs', () => {
    for (const input of ['gpt-4o', '/gpt-4o', 'pr_openrouter/', '', null]) {
      expect(parseQualifiedModelId(input)).toEqual({ ok: false, code: 'invalid_model_id' })
    }
  })
})
