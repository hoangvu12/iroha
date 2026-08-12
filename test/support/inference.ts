/**
 * A deterministic mock upstream Provider transport for inference tests: it
 * records every request (headers, body, signal) and answers from a responder
 * the test controls. No real Provider is ever reached.
 */

const encoder = new TextEncoder()

export interface RecordedUpstreamCall {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | null
  readonly signal: AbortSignal | null
}

export type UpstreamResponder = (call: RecordedUpstreamCall) => Response | Promise<Response>

export interface MockUpstreamTransport {
  readonly calls: RecordedUpstreamCall[]
  /** Replaces the responder for every call that follows. */
  respondWith(responder: UpstreamResponder): void
  /** The transport to inject into the generic Inference Adapter. */
  readonly fetch: typeof fetch
}

/** A default responder answering with a well-formed OpenAI Chat Completion. */
export function mockUpstreamTransport(initial?: UpstreamResponder): MockUpstreamTransport {
  let responder = initial ?? defaultCompletion
  const calls: RecordedUpstreamCall[] = []

  const fetchImpl = (async (input: Request | URL | string, init?: RequestInit) => {
    const call: RecordedUpstreamCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
      signal: init?.signal ?? null,
    }
    calls.push(call)
    return await responder(call)
  }) as typeof fetch

  return {
    calls,
    respondWith(next: UpstreamResponder) {
      responder = next
    },
    fetch: fetchImpl,
  }
}

/** Answers every request with a deterministic 503, so nothing touches a network. */
export function stubUpstreamTransport(): typeof fetch {
  return (async () => new Response('stub upstream is closed', { status: 503 })) as unknown as typeof fetch
}

/** The canonical mock Chat Completion, echoing the request's model. */
function defaultCompletion(call: RecordedUpstreamCall): Response {
  let model = 'gpt-4o'
  if (call.body !== null) {
    try {
      const parsed = JSON.parse(call.body) as { model?: unknown }
      if (typeof parsed.model === 'string') model = parsed.model
    } catch {
      // A malformed body still answers; the routing tests assert their own shapes.
    }
  }

  return Response.json(
    {
      id: 'chatcmpl-mock-upstream',
      object: 'chat.completion',
      created: 1_700_000_000,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Mock upstream reply' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    },
    { status: 200 },
  )
}

/** One OpenAI-compatible SSE `data:` block, as the upstream would emit it. */
export function sseEvent(payload: string): string {
  return `data: ${payload}\n\n`
}

/** The SSE block that marks the end of an OpenAI-compatible stream. */
export function sseDone(): string {
  return 'data: [DONE]\n\n'
}

/** A static `text/event-stream` response assembled from whole SSE blocks. */
export function sseResponse(blocks: readonly string[]): Response {
  return new Response(blocks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * A held-open SSE body the test pushes and closes by hand. Aborting the
 * upstream call closes the body, exactly as a real transport would, so a
 * deadline or a disconnect visibly ends the stream.
 */
export function controlledSse(call: RecordedUpstreamCall): {
  readonly stream: ReadableStream<Uint8Array>
  enqueue(block: string): void
  close(): void
  error(cause: unknown): void
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(created) {
      controller = created
    },
  })
  call.signal?.addEventListener('abort', () => {
    try {
      controller.close()
    } catch {
      // The body already ended.
    }
  })
  return {
    stream,
    enqueue: (block) => controller.enqueue(encoder.encode(block)),
    close: () => controller.close(),
    error: (cause) => controller.error(cause),
  }
}
