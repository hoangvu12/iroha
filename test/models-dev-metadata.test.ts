import { describe, expect, test } from 'bun:test'
import {
  createModelsDevMetadataFallback,
  lookupModelsDevMetadata,
  parseModelsDevCatalog,
} from '../src/models/index.ts'

const catalogBody = {
  openai: {
    models: {
      'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        limit: { context: 128_000, input: 120_000, output: 16_384 },
      },
    },
  },
  anthropic: {
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
}

describe('models.dev metadata fallback', () => {
  test('matches arbitrary gateway prefixes without changing the upstream model ID', () => {
    const catalog = parseModelsDevCatalog(catalogBody)

    expect(lookupModelsDevMetadata('requesty/openai/gpt-4o-mini', catalog)).toEqual({
      normalizedName: 'GPT-4o Mini',
      contextLength: 128_000,
      maxInputTokens: 120_000,
      maxOutputTokens: 16_384,
    })
    expect(lookupModelsDevMetadata('another-gateway/anthropic/claude-sonnet-4-6', catalog)).toEqual({
      normalizedName: 'Claude Sonnet 4.6',
      contextLength: 200_000,
      maxInputTokens: null,
      maxOutputTokens: 64_000,
    })
  })

  test('reads the flat public models.dev catalog shape', () => {
    const catalog = parseModelsDevCatalog({
      'openai/gpt-4o-mini': {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o Mini',
        limit: { context: 128_000, output: 16_384 },
      },
    })

    expect(lookupModelsDevMetadata('gateway/openai/gpt-4o-mini', catalog)?.maxOutputTokens).toBe(16_384)
  })

  test('does not choose between conflicting provider-independent matches', () => {
    const catalog = parseModelsDevCatalog({
      first: { models: { shared: { id: 'shared', limit: { context: 1_000, output: 100 } } } },
      second: { models: { shared: { id: 'shared', limit: { context: 2_000, output: 200 } } } },
    })

    expect(lookupModelsDevMetadata('wrapper/shared', catalog)).toBeNull()
  })

  test('shares one cached fetch across provider refreshes', async () => {
    let calls = 0
    const fallback = createModelsDevMetadataFallback({
      fetch: async () => {
        calls += 1
        return Response.json(catalogBody)
      },
    })

    const [first, second] = await Promise.all([
      fallback('requesty', ['openai/gpt-4o-mini']),
      fallback('other', ['anthropic/claude-sonnet-4-6']),
    ])

    expect(calls).toBe(1)
    expect(first['openai/gpt-4o-mini']?.maxOutputTokens).toBe(16_384)
    expect(second['anthropic/claude-sonnet-4-6']?.maxOutputTokens).toBe(64_000)
  })

  test('uses the official repository mirror when the primary endpoint is unavailable', async () => {
    const requested: string[] = []
    const fallback = createModelsDevMetadataFallback({
      fetch: async (input) => {
        requested.push(String(input))
        if (requested.length === 1) throw new Error('unreachable')
        return Response.json(catalogBody)
      },
    })

    const metadata = await fallback('requesty', ['openai/gpt-4o-mini'])

    expect(requested).toEqual([
      'https://models.dev/models.json',
      'https://raw.githubusercontent.com/anomalyco/models.dev/dev/models.json',
    ])
    expect(metadata['openai/gpt-4o-mini']?.maxOutputTokens).toBe(16_384)
  })

  test('treats an unavailable fallback as an empty optional supplement', async () => {
    const fallback = createModelsDevMetadataFallback({
      fetch: async () => new Response(null, { status: 503 }),
    })

    expect(await fallback('requesty', ['openai/gpt-4o-mini'])).toEqual({})
  })
})
