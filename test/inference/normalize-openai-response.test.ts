import { describe, expect, test } from 'bun:test'
import { normalizeOpenAiResponseBody } from '../../src/inference/generic-adapter.ts'

/**
 * The generic Inference Adapter is the place every OpenAI-shaped upstream
 * passes through, so the normalisations that make its answers consumable by
 * strict Chat Completions clients are tested here against representative
 * bodies the iroha Provider fleet has been observed to emit.
 */
describe('normalizeOpenAiResponseBody', () => {
  test('lifts an inline <think> block into reasoning_content', () => {
    const body = JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '<think>\nThe user said hi.\n</think>\n\nHello there!',
            name: 'MiniMax AI',
            audio_content: '',
          },
          finish_reason: 'stop',
        },
      ],
    })

    const out = JSON.parse(normalizeOpenAiResponseBody(body)) as {
      choices: { message: Record<string, unknown> }[]
    }

    expect(out.choices[0]!.message.content).toBe('Hello there!')
    expect(out.choices[0]!.message.reasoning_content).toBe('\nThe user said hi.\n')
    expect('audio_content' in out.choices[0]!.message).toBe(false)
    expect('name' in out.choices[0]!.message).toBe(false)
  })

  test('recognises the thinking and budget:thinking tag variants', () => {
    const thinkingBody = JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: '<thinking>a</thinking>answer' } }],
    })
    const budgetBody = JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: '<budget:thinking>b</budget:thinking>answer' } }],
    })

    const thinking = JSON.parse(normalizeOpenAiResponseBody(thinkingBody)) as {
      choices: { message: Record<string, unknown> }[]
    }
    const budget = JSON.parse(normalizeOpenAiResponseBody(budgetBody)) as {
      choices: { message: Record<string, unknown> }[]
    }

    expect(thinking.choices[0]!.message.content).toBe('answer')
    expect(thinking.choices[0]!.message.reasoning_content).toBe('a')
    expect(budget.choices[0]!.message.content).toBe('answer')
    expect(budget.choices[0]!.message.reasoning_content).toBe('b')
  })

  test('keeps a pre-existing reasoning_content untouched', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '<think>should-be-ignored</think>visible',
            reasoning_content: 'kept',
          },
        },
      ],
    })

    const out = JSON.parse(normalizeOpenAiResponseBody(body)) as {
      choices: { message: Record<string, unknown> }[]
    }

    expect(out.choices[0]!.message.content).toBe('<think>should-be-ignored</think>visible')
    expect(out.choices[0]!.message.reasoning_content).toBe('kept')
  })

  test('accepts the reasoning alias used by OpenRouter', () => {
    const body = JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'visible',
            reasoning: 'alias kept',
          },
        },
      ],
    })

    const out = JSON.parse(normalizeOpenAiResponseBody(body)) as {
      choices: { message: Record<string, unknown> }[]
    }

    expect(out.choices[0]!.message.content).toBe('visible')
    expect(out.choices[0]!.message.reasoning).toBe('alias kept')
    expect(out.choices[0]!.message.reasoning_content).toBeUndefined()
  })

  test('passes through bodies that need no normalisation', () => {
    const body = JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'plain reply' } }],
    })
    expect(normalizeOpenAiResponseBody(body)).toBe(body)
  })

  test('returns invalid JSON unchanged', () => {
    expect(normalizeOpenAiResponseBody('not json {')).toBe('not json {')
  })

  test('returns error envelopes unchanged so upstreamRefusal keeps matching them', () => {
    const body = JSON.stringify({
      error: { message: 'bad', type: 'invalid_request_error', code: 'invalid_request' },
    })
    expect(normalizeOpenAiResponseBody(body)).toBe(body)
  })

  test('drops the assistant name only when the upstream filled it with its own brand', () => {
    const named = JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi', name: 'MiniMax AI' } }],
    })
    const namedOut = JSON.parse(normalizeOpenAiResponseBody(named)) as {
      choices: { message: Record<string, unknown> }[]
    }
    expect('name' in namedOut.choices[0]!.message).toBe(false)

    const empty = JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi', name: '' } }],
    })
    expect(normalizeOpenAiResponseBody(empty)).toBe(empty)
  })

  test('leaves non-array and missing choices alone', () => {
    const noChoices = JSON.stringify({ choices: 'not-an-array' })
    expect(normalizeOpenAiResponseBody(noChoices)).toBe(noChoices)

    const emptyChoices = JSON.stringify({ choices: [] })
    expect(normalizeOpenAiResponseBody(emptyChoices)).toBe(emptyChoices)
  })

  test('normalises every choice independently', () => {
    const body = JSON.stringify({
      choices: [
        { index: 0, message: { role: 'assistant', content: '<think>a</think>first' } },
        { index: 1, message: { role: 'assistant', content: '<think>b</think>second' } },
      ],
    })
    const out = JSON.parse(normalizeOpenAiResponseBody(body)) as {
      choices: { message: Record<string, unknown> }[]
    }
    expect(out.choices[0]!.message.content).toBe('first')
    expect(out.choices[0]!.message.reasoning_content).toBe('a')
    expect(out.choices[1]!.message.content).toBe('second')
    expect(out.choices[1]!.message.reasoning_content).toBe('b')
  })
})