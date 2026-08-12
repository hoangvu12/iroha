/**
 * The Inference Adapter contract: typed knowledge of how to speak a Provider
 * Connection's inference API. The generic form forwards the OpenAI-compatible
 * request and response unchanged, injects adapter-owned authentication, and
 * filters unsafe or hop-by-hop headers; provider-specific adapters keep that
 * shape and add classification or transformation only where a Provider is not
 * OpenAI-compatible.
 */
export interface InferenceForwardRequest {
  /** The connection's configured OpenAI-compatible base URL. */
  readonly baseUrl: string
  /** The provider-scoped path, e.g. `/chat/completions`. Always starts with `/`. */
  readonly path: string
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH'
  /** The exact request body the caller sent, forwarded byte-for-byte. */
  readonly body: string | null
  /** The caller's headers, still carrying the caller's own authorization. */
  readonly headers: Readonly<Record<string, string>>
  /** The Upstream Key the adapter may use to authenticate. */
  readonly upstreamKey: string
  /** The explicit per-connection exception that permits plain HTTP. */
  readonly allowInsecureHttp: boolean
  /** The caller's cancellation, propagated to the upstream transport. */
  readonly signal?: AbortSignal | null
  /** Asks for the live upstream body instead of a fully buffered one. */
  readonly stream?: boolean
  /** Canonical authentication header name (e.g. "Authorization", "X-Api-Key"). */
  readonly authHeader: string
  /** Plain-text prefix for the authentication header; "" means none. */
  readonly authPrefix: string
  /** Decrypted static headers merged into every upstream request. */
  readonly staticHeaders: Readonly<Record<string, string>>
  /** Whether same-origin redirects are explicitly allowed. */
  readonly redirectAllowSameOrigin: boolean
  /** The idempotency header name the adapter accepts. */
  readonly idempotencyHeader: string
  /** Whether Iroha may generate a fresh idempotency value when the caller did not supply one. */
  readonly idempotencyGenerationSafe: boolean
  /** Per-connection override for the connection timeout (ms). */
  readonly connectionTimeoutMs: number
  /** Per-connection override for the first-byte timeout (ms). */
  readonly firstByteTimeoutMs: number
  /** Per-connection override for the non-streaming total timeout (ms). */
  readonly nonStreamingTotalTimeoutMs: number
  /** Per-connection override for the streaming idle timeout (ms). */
  readonly streamingIdleTimeoutMs: number
  /** Per-connection override for the total-retry timeout (ms). */
  readonly totalRetryTimeoutMs: number
}

/** One upstream answer, as raw material the routing layer may interpret. */
export type InferenceForwardResult = InferenceBufferedResult | InferenceStreamResult

/** A fully buffered answer, used for non-streaming calls and read-only discovery. */
export interface InferenceBufferedResult {
  readonly kind: 'buffered'
  readonly status: number
  /** Headers are surfaced structurally so retry and content information survive. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * A live upstream body. Only a caller that asked for `stream` receives this,
 * and the bytes flow through as-is, never accumulated and replayed.
 */
export interface InferenceStreamResult {
  readonly kind: 'stream'
  readonly status: number
  /** Headers are surfaced structurally so content type and error information survive. */
  readonly headers: Readonly<Record<string, string>>
  readonly stream: ReadableStream<Uint8Array>
}

/**
 * The capabilities an Inference Adapter declares about how it uses the
 * connection. Today only idempotency behaviour is declared; provider-specific
 * adapters will add theirs here, never as configuration.
 */
export interface InferenceAdapterCapabilities {
  /** The canonical header name this adapter sends as an idempotency key. */
  readonly idempotencyHeader: string
  /** Whether Iroha may mint a fresh value when the caller did not supply one. */
  readonly idempotencyGenerationSafe: boolean
}

export interface InferenceAdapter {
  /** What this adapter declares about itself; the routing layer reads it once. */
  readonly capabilities: InferenceAdapterCapabilities
  forward(request: InferenceForwardRequest): Promise<InferenceForwardResult>
}
