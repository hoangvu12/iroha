import { describe, expect, test } from 'bun:test'
import {
  createOpenAiStreamingNormalizer,
  splitStreamingReasoning,
} from '../../src/inference/generic-adapter.ts'

const encoder = new TextEncoder()

async function pipe(upstream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let body = ''
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      body += decoder.decode(chunk, { stream: true })
    },
  })
  await upstream.pipeThrough(createOpenAiStreamingNormalizer()).pipeTo(sink)
  body += decoder.decode()
  return body
}

function chunk(input: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(input))
      controller.close()
    },
  })
}

function multiChunk(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

/** Parse the body of an SSE response back into one JSON object per `data:` line. */
function parseSse(body: string): Array<{ payload: unknown; isDone: boolean }> {
  const events = body.split('\n\n').filter((block) => block.length > 0)
  const out: Array<{ payload: unknown; isDone: boolean }> = []
  for (const event of events) {
    const dataLine = event
      .split('\n')
      .find((line) => line.startsWith('data:'))
    if (dataLine === undefined) continue
    const trimmed = dataLine.slice(5).trimStart()
    if (trimmed === '[DONE]') {
      out.push({ payload: null, isDone: true })
      continue
    }
    out.push({ payload: JSON.parse(trimmed) as unknown, isDone: false })
  }
  return out
}

describe('splitStreamingReasoning', () => {
  test('opens, closes, and tracks state across calls', () => {
    const initial = { inReasoning: false }
    const first = splitStreamingReasoning(initial, '<think>\nThe user said hi.\n')
    expect(first.reasoning).toBe('\nThe user said hi.\n')
    expect(first.content).toBe('')
    expect(first.inReasoning).toBe(true)

    const second = splitStreamingReasoning({ inReasoning: first.inReasoning }, '</think>\n\nHello!')
    expect(second.reasoning).toBe('')
    expect(second.content).toBe('Hello!')
    expect(second.inReasoning).toBe(false)
  })

  test('recognises the thinking and budget:thinking tag variants', () => {
    const thinking = splitStreamingReasoning({ inReasoning: false }, '<thinking>plan</thinking>done')
    expect(thinking).toEqual({
      reasoning: 'plan',
      content: 'done',
      inReasoning: false,
      mutated: true,
    })

    const budget = splitStreamingReasoning(
      { inReasoning: false },
      '<budget:thinking>b</budget:thinking>answer',
    )
    expect(budget).toEqual({
      reasoning: 'b',
      content: 'answer',
      inReasoning: false,
      mutated: true,
    })
  })

  test('keeps trailing whitespace on the visible-text half', () => {
    const split = splitStreamingReasoning(
      { inReasoning: false },
      '<think>thinking</think>\n\nHello!',
    )
    expect(split.content).toBe('Hello!')
    expect(split.reasoning).toBe('thinking')
  })

  test('handles text that contains no tags by leaving the state alone', () => {
    const split = splitStreamingReasoning({ inReasoning: false }, 'just words')
    expect(split.content).toBe('just words')
    expect(split.reasoning).toBe('')
    expect(split.inReasoning).toBe(false)
    expect(split.mutated).toBe(false)
  })

  test('a closed block followed by more text in the same chunk is fully split', () => {
    const split = splitStreamingReasoning(
      { inReasoning: false },
      '<think>a</think>one<think>b</think>two',
    )
    expect(split.reasoning).toBe('ab')
    expect(split.content).toBe('onetwo')
    expect(split.inReasoning).toBe(false)
  })
})

describe('createOpenAiStreamingNormalizer', () => {
  test('moves the inline <think> block out of delta.content into delta.reasoning_content', async () => {
    const upstream = chunk(
      [
        'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"<think>\\nhello","name":"MiniMax AI","audio_content":""}}]}\n\n',
        'data: {"id":"x","choices":[{"index":0,"delta":{"content":"</think>\\n\\nHi!"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    )

    const body = await pipe(upstream)
    const events = parseSse(body)
    expect(events.at(-1)?.isDone).toBe(true)

    const deltas = events
      .filter((event) => !event.isDone)
      .map((event) => (event.payload as { choices: { delta: Record<string, unknown> }[] }).choices[0]!.delta)

    expect(deltas[0]).toEqual({ role: 'assistant', content: '', reasoning_content: '\nhello' })
    expect(deltas[1]).toEqual({ content: 'Hi!', reasoning_content: '' })
  })

  test('preserves a tag that straddles two upstream writes', async () => {
    const upstream = multiChunk([
      'data: {"choices":[{"index":0,"delta":{"conte',
      'nt":"<think>reasoning</think>visible"}}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const body = await pipe(upstream)
    const events = parseSse(body).filter((event) => !event.isDone)
    expect(events).toHaveLength(1)
    const delta = (events[0]!.payload as { choices: { delta: Record<string, unknown> }[] }).choices[0]!.delta
    expect(delta.content).toBe('visible')
    expect(delta.reasoning_content).toBe('reasoning')
  })

  test('keeps a pre-existing reasoning_content field untouched', async () => {
    const upstream = chunk(
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"kept","content":"<think>ignored</think>visible"}}]}\n\n' +
        'data: [DONE]\n\n',
    )

    const body = await pipe(upstream)
    const delta = parseSse(body)[0]!.payload as {
      choices: { delta: Record<string, unknown> }[]
    }
    expect(delta.choices[0]!.delta).toEqual({
      reasoning_content: 'kept',
      content: '<think>ignored</think>visible',
    })
  })

  test('drops audio_content and the brand-name name from every delta', async () => {
    const upstream = chunk(
      [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hi","name":"MiniMax AI","audio_content":""}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":" there","name":"MiniMax AI"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    )

    const body = await pipe(upstream)
    const deltas = parseSse(body)
      .filter((event) => !event.isDone)
      .map((event) => (event.payload as { choices: { delta: Record<string, unknown> }[] }).choices[0]!.delta)

    expect(deltas[0]).toEqual({ role: 'assistant', content: 'hi' })
    expect(deltas[1]).toEqual({ content: ' there' })
  })

  test('tracks reasoning state independently per choice index', async () => {
    const upstream = chunk(
      'data: {"choices":[{"index":0,"delta":{"content":"<think>a</think>one"}},{"index":1,"delta":{"content":"<think>b</think>two"}}]}\n\n' +
        'data: [DONE]\n\n',
    )

    const body = await pipe(upstream)
    const choices = (parseSse(body)[0]!.payload as {
      choices: { delta: Record<string, unknown>; index: number }[]
    }).choices
    expect(choices[0]!.delta).toEqual({ content: 'one', reasoning_content: 'a' })
    expect(choices[1]!.delta).toEqual({ content: 'two', reasoning_content: 'b' })
  })

  test('passes non-data SSE lines through unchanged', async () => {
    const upstream = chunk(
      ':heartbeat\n\n' + 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n' + 'data: [DONE]\n\n',
    )

    const body = await pipe(upstream)
    expect(body.split('\n\n').map((b) => b.trim())).toContain(':heartbeat')
  })

  test('error envelopes are forwarded verbatim', async () => {
    const errorEvent =
      'data: {"error":{"message":"bad","type":"invalid_request_error","code":"invalid_request"}}\n\n'
    const upstream = chunk(errorEvent)
    const body = await pipe(upstream)
    expect(body).toContain('"error"')
    expect(body).toContain('invalid_request_error')
  })

  test('a flush that ends mid-event is still normalised', async () => {
    const upstream = chunk('data: {"choices":[{"index":0,"delta":{"content":"<think>r</think>v"}}]}')

    const body = await pipe(upstream)
    const delta = parseSse(body)[0]!.payload as {
      choices: { delta: Record<string, unknown> }[]
    }
    expect(delta.choices[0]!.delta).toEqual({ content: 'v', reasoning_content: 'r' })
  })
})